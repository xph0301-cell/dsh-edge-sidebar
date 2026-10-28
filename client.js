/**
 * dsh-edge-sidebar — client half.
 *
 * The sidebar's browser tab kind is taken over by this plugin (kind "browser" at the
 * `extension` priority). Its body is a single page host: it measures its screen rectangle
 * (CSS px) and reports it to the host half, which docks the REAL Microsoft Edge window —
 * title bar, tab strip and address bar included — exactly onto that rectangle. The pane
 * body starts below the DSH sidebar header, so the browser window never covers the app's
 * own hide/collapse controls, and browser control stays native (tabs, address bar, input,
 * IME, downloads). No iframe, no canvas, no projected frames.
 */
window.__ModuleLoader__.load({
  id: 'dsh-edge-sidebar',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const react = require('react')
    const h = react.createElement

    /** Slot dispatch key: must equal the registered type's id. */
    const EDGE_TYPE_ID = 'dsh-edge-sidebar.edge'
    /** The built-in browser tab kind, deliberately shadowed. */
    const EDGE_KIND = 'browser'
    /** Host dock service (lib/dock.js). */
    const DOCK_URL = 'ws://127.0.0.1:17781/'
    /** Tab ids whose initial URL was already opened; remounts must not navigate again. */
    const openedTabs = new Set()

    const inject = ['slots', 'sidebarRight', 'sidebarRightTabs']

    /**
     * The pane body's screen rectangle in CSS pixels. The host docks the whole Edge
     * window (chrome included) onto it; Edge's own DPI conversion happens there.
     * @param element - the page host.
     * @returns the dock report.
     */
    function measurePage(element) {
      const rect = element.getBoundingClientRect()
      const dpr = window.devicePixelRatio || 1
      const border = Math.max(0, (window.outerWidth - window.innerWidth) / 2)
      const title = Math.max(0, window.outerHeight - window.innerHeight - border)
      // A collapsed sidebar keeps the pane laid out but translated outside the viewport;
      // visibility must mean "intersects the viewport", not "has a size".
      const inside = rect.right > 0 && rect.bottom > 0
        && rect.left < window.innerWidth && rect.top < window.innerHeight
      const visible = rect.width > 40 && rect.height > 40 && inside
        && document.visibilityState === 'visible'
      return {
        page: {
          x: Math.round(window.screenX + border + rect.left),
          y: Math.round(window.screenY + title + rect.top),
          w: Math.round(rect.width),
          h: Math.round(rect.height),
        },
        // Body position relative to the renderer viewport (= the window's client area).
        // The native follower uses this instead of screen coordinates, so a window move
        // between measurement and placement cannot skew the offset.
        inset: { left: Math.round(rect.left), top: Math.round(rect.top) },
        dpr,
        visible,
      }
    }

    /** The tab body: report the page-host geometry; the host docks real Edge onto it. */
    function EdgeBody(props) {
      const { tab } = props.useTabInfo()
      const initialUrl = tab?.navigation?.params?.url ?? ''
      const tabId = tab?.id ?? ''
      const hostRef = react.useRef(null)
      const socketRef = react.useRef(null)
      const [view, setView] = react.useState({
        connected: false, docked: false, url: initialUrl, title: '', text: '正在连接 Edge…',
      })

      const sendMessage = react.useCallback(message => {
        const socket = socketRef.current
        if (socket?.readyState === 1) {
          try { socket.send(JSON.stringify(message)) } catch { /* reconnecting */ }
        }
      }, [])

      react.useEffect(() => {
        const element = hostRef.current
        if (element === null) return undefined
        let disposed = false
        let socket
        let retryTimer
        let lastReport = ''

        const report = force => {
          if (element === null) return
          const snapshot = measurePage(element)
          const text = JSON.stringify(snapshot)
          if (!force && text === lastReport) return
          lastReport = text
          sendMessage({ t: 'page', ...snapshot })
        }
        const onResize = () => report(false)
        const onVisibility = () => report(false)
        const connect = () => {
          if (disposed) return
          socket = new WebSocket(DOCK_URL)
          socketRef.current = socket
          socket.addEventListener('open', () => {
            report(true)
            if (initialUrl !== '' && !openedTabs.has(tabId)) {
              openedTabs.add(tabId)
              sendMessage({ t: 'nav', url: initialUrl })
            }
          })
          socket.addEventListener('message', event => {
            let message
            try { message = JSON.parse(event.data) } catch { return }
            if (message.t !== 'state') return
            setView({
              connected: true,
              docked: Boolean(message.docked),
              url: message.url ?? '',
              title: message.title ?? '',
              text: message.error ? `Edge 错误：${message.error}` : (message.text ?? ''),
            })
          })
          socket.addEventListener('close', () => {
            if (socketRef.current === socket) socketRef.current = null
            if (disposed) return
            setView(current => ({ ...current, connected: false, text: '正在重连 Edge…' }))
            retryTimer = setTimeout(connect, 1500)
          })
          socket.addEventListener('error', () => { try { socket.close() } catch { /* ignore */ } })
        }
        connect()

        const observer = new ResizeObserver(() => report(false))
        observer.observe(element)
        const intersection = new IntersectionObserver(() => report(false), { threshold: [0, 0.25, 0.5, 1] })
        intersection.observe(element)
        window.addEventListener('resize', onResize)
        document.addEventListener('visibilitychange', onVisibility)
        // Window moves and sidebar layout changes fire no `resize` on this element. The
        // native follower does the real-time gluing; this poll only keeps the reported
        // geometry (size/inset) fresh, so it can be modest.
        const poll = setInterval(() => report(false), 60)

        return () => {
          disposed = true
          clearTimeout(retryTimer)
          clearInterval(poll)
          observer.disconnect()
          intersection.disconnect()
          window.removeEventListener('resize', onResize)
          document.removeEventListener('visibilitychange', onVisibility)
          try { socket?.send(JSON.stringify({ t: 'undock' })) } catch { /* closing anyway */ }
          if (socketRef.current === socket) socketRef.current = null
          try { socket?.close() } catch { /* ignore */ }
        }
      }, [initialUrl, tabId, sendMessage])

      return h('div', {
        ref: hostRef,
        style: {
          position: 'relative',
          width: '100%',
          height: '100%',
          minHeight: 0,
          background: '#17181c',
          color: '#9aa0ab',
          font: '12px/1.5 "Segoe UI", "Microsoft YaHei", system-ui, sans-serif',
          display: 'grid',
          placeItems: 'center',
          textAlign: 'center',
          padding: '16px',
          boxSizing: 'border-box',
          overflow: 'hidden',
        },
      }, h('div', { style: { maxWidth: 420 } }, [
        h('div', { key: 'status', style: { marginBottom: '6px' } }, view.text || (view.connected ? '正在嵌入 Edge…' : '正在连接 Edge…')),
        h('div', { key: 'url', style: { opacity: 0.6, wordBreak: 'break-all' } }, view.url || initialUrl),
        h('div', { key: 'hint', style: { opacity: 0.4, marginTop: '10px' } }, '页面由真实 Edge 承载；这里是它的窗口（保留浏览器标题栏/地址栏）。'),
      ]))
    }

    /** The tab title. The real page title lives in the Edge window. */
    function EdgeTitle() {
      return h('span', null, 'Edge')
    }

    /**
     * Register the shadowing browser tab kind, its body, title and the command that opens it.
     * @param ctx - client context.
     */
    function apply(ctx) {
      ctx.effect(() => ctx.sidebarRightTabs.register({
        id: EDGE_TYPE_ID,
        kind: EDGE_KIND,
        priority: 'extension',
        multiple: true,
        keepMounted: true,
        title: () => 'Edge',
        guide: [{
          id: 'new',
          commandId: 'edge.new',
          order: 30,
          title: () => 'Edge',
          description: () => '用真实 Edge 打开（窗口嵌入侧栏）',
        }],
      }), 'dsh-edge-sidebar:type')

      ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
        name: 'sidebar.right.pane.tab',
        key: EDGE_TYPE_ID,
        inject: () => ({}),
      }, EdgeBody)), 'dsh-edge-sidebar:body')

      ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
        name: 'sidebar.right.pane.tab.title',
        key: EDGE_TYPE_ID,
      }, EdgeTitle)), 'dsh-edge-sidebar:title')

      ctx.inject(['shortcuts'], (scope) => {
        scope.effect(() => scope.shortcuts.register({
          id: 'edge.new',
          label: () => 'Edge',
          aliases: ['edge', 'new edge tab'],
          defaults: {
            'desktop:windows': { code: 'KeyT', modifiers: ['primary', 'shift'] },
            'desktop:macos': { code: 'KeyT', modifiers: ['primary', 'shift'] },
            'desktop:linux': { code: 'KeyT', modifiers: ['primary', 'shift'] },
          },
          regions: ['page', 'editable', 'terminal'],
          modals: [],
          resolve: ({ target: element }) => {
            const target = ctx.sidebarRight.commandTarget(element)
            if (target === undefined) return { status: 'blocked', reason: '请先打开一个会话' }
            return {
              status: 'handled',
              run: () => { ctx.sidebarRight.openTabFromTarget(EDGE_KIND, target) },
            }
          },
        }), 'dsh-edge-sidebar:command')
      })
    }

    exports.name = 'dsh-edge-sidebar'
    exports.inject = inject
    exports.apply = apply
    return module.exports
  },
})
