/**
 * dsh-interrupt — browser half.
 *
 * 形态照 `persona-switcher` 的「糖豆」：默认收起成一颗胶囊 `💬 插话 ▾`，
 * 点开才弹出浮层输入框，点空白处收起。**默认不占地方**——用户 2026-11-11：
 * 「做成跟隔壁说画风格一样的那种，类似于糖豆一样的东西，胶囊是吧…因为它有点占位置」。
 *
 * 发送走后端插件自己的路由 `/dsh-interrupt/send`，绕开 turn 运行时会把消息
 * "先插入再撤回"的那条客户端队列；宿主半在下次 `agent/pre-step` 里注入。
 *
 * ⚠️ 经典 script 不是 ESM：只能 window.__ModuleLoader__.load + factory(require)。
 * ⚠️ 必须导出带 `apply` 的对象，空对象会让 web-boot 报 invalid plugin。
 *
 * @module dsh-interrupt/client
 */
window.__ModuleLoader__.load({
  id: 'dsh-interrupt',
  factory: (require) => {
    var React = require('react')
    var useState = React.useState
    var useEffect = React.useEffect
    var useRef = React.useRef
    var useCallback = React.useCallback

    var NS = 'dsh-interrupt'
    var DOCK_ID = 'interrupt'
    var SEND_PATH = '/dsh-interrupt/send'
    var STATE_PATH = '/dsh-interrupt/state'
    var POLL_MS = 5000

    // ── 样式：与 persona-switcher 的胶囊同源，保证观感一致 ──────────────
    var PILL = {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '6px',
      background: 'rgba(127,127,127,.10)',
      border: '1px solid var(--dsw-alias-border-l2, #30363d)',
      color: 'inherit',
      borderRadius: '999px',
      padding: '2px 11px',
      fontSize: '12px',
      lineHeight: '18px',
      cursor: 'pointer',
      maxWidth: '78vw',
      overflow: 'hidden',
      whiteSpace: 'nowrap',
      textOverflow: 'ellipsis',
    }
    var PANEL = {
      position: 'fixed',
      left: '50%',
      transform: 'translateX(-50%)',
      bottom: '84px',
      zIndex: 3002,
      width: '560px',
      maxWidth: '94vw',
      background: 'var(--dsw-alias-bg-layer-2, #161b22)',
      border: '1px solid var(--dsw-alias-border-l2, #30363d)',
      borderRadius: '16px',
      padding: '12px 12px 10px',
      boxShadow: '0 18px 48px rgba(0,0,0,.5)',
      color: 'var(--dsw-alias-label-primary, #e6edf3)',
    }
    var INPUT = {
      flex: '1 1 auto',
      minWidth: 0,
      padding: '7px 12px',
      borderRadius: '999px',
      border: '1px solid var(--dsw-alias-border-l2, #30363d)',
      background: 'rgba(127,127,127,.10)',
      color: 'inherit',
      fontSize: '13px',
      outline: 'none',
    }
    var BTN = {
      flex: '0 0 auto',
      padding: '7px 16px',
      borderRadius: '999px',
      border: '1px solid var(--dsw-alias-border-l2, #30363d)',
      background: 'rgba(127,127,127,.12)',
      color: 'inherit',
      fontSize: '12px',
      cursor: 'pointer',
    }

    function InterruptDock() {
      var openState = useState(false)
      var open = openState[0]
      var setOpen = openState[1]

      var textState = useState('')
      var text = textState[0]
      var setText = textState[1]

      var statusState = useState('') // '' | 'ok' | 'err'
      var status = statusState[0]
      var setStatus = statusState[1]

      var busyState = useState(false)
      var busy = busyState[0]
      var setBusy = busyState[1]

      var inputRef = useRef(null)

      // 队列里还有多少条没被我取走（真值从 host 路由拿，不靠自己数）
      var countState = useState(0)
      var pendingCount = countState[0]
      var setPendingCount = countState[1]

      var refreshCount = useCallback(function () {
        fetch(STATE_PATH, { credentials: 'same-origin' })
          .then(function (r) {
            return r.ok ? r.json() : null
          })
          .then(function (j) {
            if (j && typeof j.pending === 'number') setPendingCount(j.pending)
          })
          .catch(function () {})
      }, [])

      // 打开面板时查一次；打开着的时候每 5 秒刷一次
      useEffect(
        function () {
          if (!open) return
          if (inputRef.current) inputRef.current.focus()
          refreshCount()
          var t = setInterval(refreshCount, POLL_MS)
          return function () {
            clearInterval(t)
          }
        },
        [open, refreshCount],
      )

      var send = useCallback(
        function () {
          var t = String(text || '').trim()
          if (!t || busy) return
          setBusy(true)
          setStatus('')
          fetch(SEND_PATH, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ text: t }),
          })
            .then(function (r) {
              if (!r.ok) throw new Error('http ' + r.status)
              setText('')
              setStatus('ok')
              refreshCount()
              setTimeout(function () {
                setStatus('')
              }, 5000)
            })
            .catch(function () {
              setStatus('err')
            })
            .then(function () {
              setBusy(false)
              if (inputRef.current) inputRef.current.focus()
            })
        },
        [text, busy, refreshCount],
      )

      var onKeyDown = useCallback(
        function (e) {
          if (e.key === 'Enter' && !e.shiftKey) {
            var composing = e.nativeEvent && e.nativeEvent.isComposing
            if (!composing) {
              e.preventDefault()
              send()
            }
          }
          if (e.key === 'Escape') setOpen(false)
        },
        [send],
      )

      var pill = React.createElement(
        'button',
        {
          type: 'button',
          style: PILL,
          title: '插话：方向不对就敲一句，下一步生效（不打断当前动作）',
          onClick: function () {
            setOpen(!open)
          },
        },
        React.createElement('span', null, '💬 插话' + (pendingCount > 0 ? ' · ' + pendingCount : '')),
        React.createElement('span', { style: { opacity: 0.6 } }, open ? '▴' : '▾'),
      )

      var panel = open
        ? React.createElement(
            'div',
            null,
            React.createElement('div', {
              style: { position: 'fixed', inset: 0, zIndex: 3001, background: 'rgba(0,0,0,.25)' },
              onClick: function () {
                setOpen(false)
              },
            }),
            React.createElement(
              'div',
              { style: PANEL },
              React.createElement(
                'div',
                { style: { fontSize: '11px', opacity: 0.65, marginBottom: '8px' } },
                '这句话会在下一步注入给我，不会打断我正在做的事' +
                  (pendingCount > 0 ? '（队列里还有 ' + pendingCount + ' 条待取）' : ''),
              ),
              React.createElement(
                'div',
                { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
                React.createElement('input', {
                  ref: inputRef,
                  style: INPUT,
                  type: 'text',
                  value: text,
                  placeholder: '方向不对就说一句，回车发送',
                  onChange: function (e) {
                    setText(e.target.value)
                    if (status) setStatus('')
                  },
                  onKeyDown: onKeyDown,
                }),
                React.createElement(
                  'button',
                  {
                    type: 'button',
                    style: BTN,
                    onClick: send,
                    disabled: busy || !String(text || '').trim(),
                  },
                  busy ? '…' : '发送',
                ),
              ),
              status === 'ok'
                ? React.createElement(
                    'div',
                    { style: { color: '#4caf7d', fontSize: '11px', marginTop: '6px' } },
                    '✓ 已塞进队列，下一步生效',
                  )
                : null,
              status === 'err'
                ? React.createElement(
                    'div',
                    { style: { color: '#b4534f', fontSize: '11px', marginTop: '6px' } },
                    '✕ 发送失败——看插件目录下的日志（cordis.patch.yml 里配 debugFile）',
                  )
                : null,
            ),
          )
        : null

      return React.createElement(
        'div',
        { style: { display: 'flex', alignItems: 'center', padding: '2px 2px', minWidth: 0 } },
        pill,
        panel,
      )
    }

    /** 错误边界：这个小条挂了只显示一行灰字，别拖死 composer */
    function SafeDock() {
      var errState = useState(null)
      var err = errState[0]
      var setErr = errState[1]
      if (err) {
        return React.createElement(
          'span',
          { style: { fontSize: '11px', opacity: 0.45 }, title: String(err) },
          '插话不可用',
        )
      }
      try {
        return React.createElement(InterruptDock, null)
      } catch (e) {
        setErr(e && e.message ? e.message : e)
        return null
      }
    }

    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    exports.name = 'dsh-interrupt-client'
    exports.inject = ['slots']
    exports.apply = function apply(ctx) {
      ctx.slots.inject('conversation.composer.dock', function () {
        return ctx.slots.register(
          { name: 'conversation.composer.dock', id: DOCK_ID, order: 2, label: '插话' },
          SafeDock,
        )
      })
    }

    return module.exports
  },
})
