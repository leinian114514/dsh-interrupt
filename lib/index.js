// dsh-interrupt — 插话旁路（host 半）
//
// 要解决的问题：DSH 客户端在 turn 运行时会把用户消息"先插入再撤回"
// （会话日志里表现为 agent/inbox/spliced 的 ins=1 / rm=1 反复，
//  全程没有 user/message），所以用户想说一句"方向错了"根本没到服务端。
//
// 做法：不走那个坏掉的发送流程，另开一条插件自己的 HTTP 路由。
//   ① 浏览器（http://127.0.0.1:<port>，与宿主同源）POST /dsh-interrupt/send
//   ② 插件把消息按 sessionId 塞进内存队列
//   ③ 下一次 agent/pre-step 时把它们追加进 messages
//   ④ AgentLoop 会把追加的消息作为正常 user/message 落盘并进入本次请求
//
// 安全边界（照 mem-tools / auto-checkpoint 的教训）：
//   · 只往 messages 里追加，**永不返回 reject**
//   · next() 的返回值不合法时原样返回，不构造新决策
//   · 路由必须过 ctx.connection.requestRejection 这道信任栅栏

import { randomUUID } from 'node:crypto'

export const name = 'interrupt'
export const inject = ['webServer', 'agents', 'connection']

const ROUTE_SEND = '/dsh-interrupt/send'
const ROUTE_STATE = '/dsh-interrupt/state'

export function apply(ctx, config = {}) {
  const maxKeep = Number(config.maxKeep) > 0 ? Number(config.maxKeep) : 20
  const ttlMinutes = Number(config.ttlMinutes) > 0 ? Number(config.ttlMinutes) : 30
  const ttlMs = ttlMinutes * 60_000
  const debugFile = typeof config.debugFile === 'string' ? config.debugFile : ''

  /** sessionId -> [{ id, text, ts }]；'' 表示"哪个会话都行" */
  const pending = new Map()

  const log = (msg) => {
    ctx.logger?.info?.(`[interrupt] ${msg}`)
    if (!debugFile) return
    try {
      // 延迟 import，避免没配 debugFile 时的额外开销
      import('node:fs').then((fs) => {
        try { fs.appendFileSync(debugFile, `${new Date().toISOString()} ${msg}\n`) } catch {}
      }).catch(() => {})
    } catch {}
  }

  const push = (sid, text) => {
    const arr = pending.get(sid) || []
    arr.push({ id: randomUUID(), text, ts: Date.now() })
    while (arr.length > maxKeep) arr.shift()
    pending.set(sid, arr)
    return arr.length
  }

  /** 取走某会话的待注入消息（含通配 ''），顺便丢掉过期的 */
  const drain = (sid) => {
    const now = Date.now()
    const out = []
    for (const key of [sid, '']) {
      const arr = pending.get(key)
      if (!arr) continue
      pending.delete(key)
      for (const it of arr) if (now - it.ts < ttlMs) out.push(it)
    }
    return out
  }

  const json = (res, code, obj) => {
    res.statusCode = code
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(JSON.stringify(obj))
  }

  const makeHandler = (connection) => (req, res) => {
    // 信任栅栏：与宿主其它插件路由同一套判定
    try {
      const rejection = connection && typeof connection.requestRejection === 'function'
        ? connection.requestRejection(req)
        : undefined
      if (rejection !== undefined) {
        res.statusCode = rejection
        res.end()
        return
      }
    } catch {
      res.statusCode = 403
      res.end()
      return
    }

    let path = '/'
    let sid = ''
    try {
      const url = new URL(String(req.url || '/'), 'http://localhost')
      path = url.pathname
      sid = url.searchParams.get('session') || ''
    } catch {
      res.statusCode = 400
      res.end()
      return
    }

    if (path === ROUTE_STATE) {
      const own = pending.get(sid) || []
      const any = pending.get('') || []
      return json(res, 200, {
        ok: true,
        pending: own.length + (sid ? any.length : 0),
        items: [...own, ...(sid ? any : [])].map((x) => ({ id: x.id, ts: x.ts })),
      })
    }

    if (path === ROUTE_SEND) {
      if (req.method !== 'POST') {
        res.statusCode = 405
        res.setHeader('allow', 'POST')
        res.end()
        return
      }
      let body = ''
      let tooBig = false
      req.on('data', (c) => {
        body += c
        if (body.length > 20_000) {
          tooBig = true
          req.destroy()
        }
      })
      req.on('end', () => {
        if (tooBig) return
        let text = ''
        let target = ''
        try {
          const j = JSON.parse(body || '{}')
          text = String(j.text ?? '').trim()
          target = String(j.sessionId ?? '').trim()
        } catch {
          json(res, 400, { ok: false, error: 'bad json' })
          return
        }
        if (!text) {
          json(res, 400, { ok: false, error: 'empty text' })
          return
        }
        const n = push(target, text)
        log(`queued → ${target || '(any session)'}  n=${n}  ${text.slice(0, 50)}`)
        json(res, 200, { ok: true, pending: n })
      })
      return
    }

    res.statusCode = 404
    res.end()
  }

  const registerRoutes = () => {
    const handler = makeHandler(ctx.connection)
    const offs = [
      ctx.webServer.register({ kind: 'exact', path: ROUTE_SEND, handler }),
      ctx.webServer.register({ kind: 'exact', path: ROUTE_STATE, handler }),
    ]
    return () => {
      for (const off of offs) {
        try { if (typeof off === 'function') off() } catch {}
      }
    }
  }

  try {
    ctx.effect(registerRoutes, 'interrupt: routes')
    log(`routes ready: POST ${ROUTE_SEND} · GET ${ROUTE_STATE}`)
  } catch (e) {
    log(`route registration FAILED: ${e && e.message}`)
  }

  // 下一步开始前，把待注入的话塞进去
  ctx.on('agent/pre-step', async ({ agent, messages }, next) => {
    let decision
    try {
      decision = await next()
    } catch (e) {
      // 下游抛了：不能返回 undefined，退回一个合法的 enter
      ctx.logger?.warn?.(`[interrupt] downstream threw: ${e && e.message}`)
      return { kind: 'enter', messages: messages || [] }
    }
    try {
      if (!decision || typeof decision !== 'object' || decision.kind !== 'enter') return decision
      const sid = (agent && agent.id) ? String(agent.id) : ''
      const items = drain(sid)
      if (items.length === 0) return decision
      log(`injecting ${items.length} item(s) into session ${sid || '(unknown)'}`)
      return {
        ...decision,
        messages: [
          ...decision.messages,
          ...items.map((it) => ({
            id: it.id,
            role: 'user',
            content: [{ type: 'text', text: `⟪插话⟫ ${it.text}` }],
            source: {
              kind: 'plugin:interrupt',
              form: 'snapshot',
              sections: [{ name: 'interrupt', text: 'mid-turn steering' }],
            },
          })),
        ],
      }
    } catch (e) {
      ctx.logger?.warn?.(`[interrupt] inject failed: ${e && e.message}`)
      return decision
    }
  })

  log('pre-step hook installed')
}
