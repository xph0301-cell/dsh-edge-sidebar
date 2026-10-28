/**
 * dsh-edge-sidebar — host half: a real Microsoft Edge window, cropped to its PAGE
 * viewport and parked exactly on the DSH sidebar pane.
 *
 * The sidebar's browser panel is the shell's Electron <webview>, whose engine cannot be
 * replaced, and native child windows (and DWM thumbnails) cannot be composited inside an
 * Electron window — all measured dead ends. The one shape that keeps the REAL browser and
 * still lives inside the pane is a window-region crop:
 *
 *   - the Edge window (the same instance the agent drives over CDP) is sized so its page
 *     viewport equals the pane's page rectangle, and moved so that viewport sits exactly
 *     on it;
 *   - `SetWindowRgn` clips the window to that viewport, so Edge's title bar, tab strip and
 *     address bar are neither drawn nor hit-tested;
 *   - the page itself is untouched: native scrolling, mouse, keyboard, IME, downloads and
 *     file dialogs keep working, because it is still the real Edge window.
 *
 * The client half measures the page host (below its toolbar), reports the rectangle, and
 * renders the sidebar toolbar. The window only exists while the pane is visible; the page
 * and its CDP session keep running while it is hidden, so the agent can continue.
 */
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** Fixed port; the client half hardcodes the same value. */
export const DOCK_PORT = 17781
const EDGE_PATH = process.env.EDGE_PATH ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const BROWSER_ROOT = join(DSH_HOME, 'dsh-builtin-browser-host')

/** Frame one server->client text message. */
function encodeText(text) {
  const payload = Buffer.from(text, 'utf8')
  const len = payload.length
  let header
  if (len < 126) header = Buffer.from([0x81, len])
  else if (len < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x81
    header[1] = 126
    header.writeUInt16BE(len, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x81
    header[1] = 127
    header.writeBigUInt64BE(BigInt(len), 2)
  }
  return Buffer.concat([header, payload])
}

/** RFC 6455 accept key. */
function wsAccept(key) {
  return createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')
}

/** Only HTTP(S) URLs are ever navigated. */
function normalizeUrl(value) {
  const raw = String(value ?? '').trim()
  if (raw === '') return undefined
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`
  let url
  try { url = new URL(candidate) } catch { return undefined }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
  if (url.href.length > 8000) return undefined
  return url.href
}

/**
 * Minimal CDP websocket client. Commands resolve by id; events go to `onEvent`.
 * A closing socket rejects everything pending, so callers never hang.
 */
class CdpClient {
  constructor(url, onEvent) {
    this.url = url
    this.onEvent = onEvent
    this.seq = 0
    this.pending = new Map()
    this.closed = false
    this.socket = undefined
  }

  async open() {
    const socket = new WebSocket(this.url)
    this.socket = socket
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP open timeout')), 5000)
      socket.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP open failed')) }, { once: true })
    })
    socket.addEventListener('message', event => {
      let message
      try { message = JSON.parse(event.data) } catch { return }
      if (message.id !== undefined) {
        const pending = this.pending.get(message.id)
        if (pending === undefined) return
        this.pending.delete(message.id)
        if (message.error) pending.reject(new Error(message.error.message ?? JSON.stringify(message.error)))
        else pending.resolve(message.result)
        return
      }
      if (typeof message.method === 'string') this.onEvent?.(message.method, message.params ?? {})
    })
    socket.addEventListener('close', () => {
      this.closed = true
      for (const pending of this.pending.values()) pending.reject(new Error('CDP socket closed'))
      this.pending.clear()
      this.onEvent?.('__close', {})
    })
    return this
  }

  send(method, params = {}, timeoutMs = 4000) {
    if (this.closed || this.socket === undefined) return Promise.reject(new Error('CDP not connected'))
    return new Promise((resolve, reject) => {
      const id = ++this.seq
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`CDP timeout: ${method}`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: value => { clearTimeout(timer); resolve(value) },
        reject: error => { clearTimeout(timer); reject(error) },
      })
      try { this.socket.send(JSON.stringify({ id, method, params })) } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error)
      }
    })
  }

  close() {
    this.closed = true
    try { this.socket?.close() } catch { /* already gone */ }
  }
}

/**
 * Start the dock service.
 * @param options - `{ port, log }`.
 * @returns `{ port, close, status, show, navigate, back, forward, reload }`.
 */
export function startDock(options = {}) {
  const port = options.port ?? DOCK_PORT
  const log = options.log ?? (() => {})
  const state = {
    hwnd: 0,
    owner: 0,
    windowId: 0,
    cdpPort: 0,
    profileDir: '',
    targetId: '',
    page: undefined,
    inset: undefined,
    dpr: 1,
    visible: false,
    shown: false,
    url: '',
    title: '',
    canBack: false,
    canForward: false,
    loading: false,
    text: '等待侧栏面板',
    error: undefined,
    launching: false,
  }
  const clients = new Set()
  const broadcast = message => { for (const client of clients) client.send(message) }
  const status = () => ({
    docked: state.hwnd !== 0,
    visible: Boolean(state.visible && state.shown),
    url: state.url,
    title: state.title,
    canBack: state.canBack,
    canForward: state.canForward,
    loading: state.loading,
    page: state.page,
    text: state.text,
    edgePort: state.cdpPort || undefined,
    targetId: state.targetId || undefined,
    hwnd: state.hwnd || undefined,
  })
  const pushState = error => broadcast({ t: 'state', ...status(), ...error === undefined ? {} : { error } })

  /* ------------------------------------------------------------ helper io */
  let helper
  let helperSeq = 0
  const helperPending = new Map()

  function ensureHelper() {
    if (helper !== undefined && helper.exitCode === null) return helper
    helper = spawn('powershell', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(HERE, 'dock-helper.ps1'), '-Op', 'stdio',
    ], { stdio: ['pipe', 'pipe', 'ignore'] })
    let buffer = ''
    helper.stdout.setEncoding('utf8')
    helper.stdout.on('data', chunk => {
      buffer += chunk
      for (;;) {
        const index = buffer.indexOf('\n')
        if (index < 0) break
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (line === '') continue
        let message
        try { message = JSON.parse(line) } catch { continue }
        const resolve = helperPending.get(message.id)
        if (resolve !== undefined) { helperPending.delete(message.id); resolve(message) }
      }
    })
    helper.on('exit', () => {
      helper = undefined
      for (const resolve of helperPending.values()) resolve({ ok: false, error: 'helper exited' })
      helperPending.clear()
    })
    return helper
  }

  /** One helper round-trip; never throws, so a missing helper only degrades docking. */
  function callHelper(op, params = {}) {
    return new Promise(resolve => {
      const proc = ensureHelper()
      const id = ++helperSeq
      helperPending.set(id, resolve)
      try { proc.stdin.write(`${JSON.stringify({ id, op, ...params })}\n`) } catch { resolve({ ok: false, error: 'helper write failed' }) }
      setTimeout(() => {
        if (helperPending.has(id)) { helperPending.delete(id); resolve({ ok: false, error: 'helper timeout' }) }
      }, 5000)
    })
  }

  /* ------------------------------------------------------- browser carrier */
  function carrierState() {
    for (const name of ['edge-profile', 'chrome-profile']) {
      const dir = join(BROWSER_ROOT, name)
      try {
        const [first, second] = readFileSync(join(dir, 'DevToolsActivePort'), 'utf8').split(/\r?\n/)
        const cdpPort = Number(String(first).trim())
        if (Number.isInteger(cdpPort) && cdpPort > 0) return { dir, cdpPort, browserPath: String(second ?? '').trim() }
      } catch { /* not running, or a half-written file during launch */ }
    }
    return undefined
  }

  async function jsonList() {
    if (!(state.cdpPort > 0)) return []
    try {
      const response = await fetch(`http://127.0.0.1:${state.cdpPort}/json/list`, { signal: AbortSignal.timeout(1500) })
      const list = await response.json()
      return Array.isArray(list) ? list : []
    } catch { return [] }
  }

  async function createPage() {
    if (!(state.cdpPort > 0)) return false
    try {
      await fetch(`http://127.0.0.1:${state.cdpPort}/json/new?about:blank`, { method: 'PUT', signal: AbortSignal.timeout(2500) })
      return true
    } catch { return false }
  }

  /** Launch the same profile the builtin-browser plugin uses, then wait for a page. */
  async function launchEdge(url) {
    if (state.launching) return carrierState() !== undefined
    if (!existsSync(EDGE_PATH)) return false
    state.launching = true
    try {
      const profile = join(BROWSER_ROOT, 'edge-profile')
      mkdirSync(profile, { recursive: true })
      spawn(EDGE_PATH, [
        '--remote-debugging-port=0',
        `--user-data-dir=${profile}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-sync',
        normalizeUrl(url) ?? 'about:blank',
      ], { detached: true, stdio: 'ignore' }).unref()
      for (let attempt = 0; attempt < 30; attempt += 1) {
        await sleep(300)
        const carrier = carrierState()
        if (carrier === undefined) continue
        state.cdpPort = carrier.cdpPort
        const list = await jsonList()
        if (list.some(entry => entry.type === 'page' && entry.url)) return true
        await createPage()
      }
      return carrierState() !== undefined
    } finally {
      state.launching = false
    }
  }

  /* ------------------------------------------------------------- browser cdp */
  let browserCdp
  let pageCdp
  let connectingBrowser = false
  const pageTargets = new Map()
  let browserTimer = 0

  async function connectBrowser() {
    if (browserCdp !== undefined && !browserCdp.closed) return true
    if (connectingBrowser) return false
    const carrier = carrierState()
    if (carrier === undefined || carrier.browserPath === '') return false
    connectingBrowser = true
    try {
      const cdp = new CdpClient(`ws://127.0.0.1:${carrier.cdpPort}${carrier.browserPath}`, onBrowserEvent)
      await cdp.open()
      browserCdp = cdp
      await cdp.send('Target.setDiscoverTargets', { discover: true }).catch(() => {})
      const { targetInfos } = await cdp.send('Target.getTargets').catch(() => ({ targetInfos: [] }))
      for (const info of targetInfos ?? []) trackTarget(info)
      return true
    } catch (error) {
      log(`browser CDP unavailable: ${error.message}`)
      return false
    } finally {
      connectingBrowser = false
    }
  }

  function trackTarget(info) {
    if (info === undefined || info?.type !== 'page') return
    pageTargets.set(info.targetId, info)
  }

  function onBrowserEvent(method, params) {
    if (method === '__close') {
      browserCdp = undefined
      clearTimeout(browserTimer)
      browserTimer = setTimeout(() => { void connectBrowser() }, 2000)
      return
    }
    if (method === 'Target.targetCreated' || method === 'Target.targetInfoChanged') {
      const info = params?.targetInfo
      trackTarget(info)
      if (info?.type === 'page' && info?.targetId === state.targetId && info.url && info.url !== 'edge://newtab/') {
        state.url = info.url
        if (info.title) state.title = info.title
      }
      return
    }
    if (method === 'Target.targetActivated') {
      const info = params?.targetInfo ?? params
      if (info?.type !== 'page' || info?.targetId === undefined) return
      void switchTarget(info.targetId)
      return
    }
    if (method === 'Target.targetDestroyed') {
      pageTargets.delete(params?.targetId)
      if (params?.targetId === state.targetId) {
        const next = [...pageTargets.keys()].find(id => id !== state.targetId)
        if (next !== undefined) void switchTarget(next)
        else { pageCdp?.close(); pageCdp = undefined; state.targetId = '' }
      }
    }
  }

  function onPageEvent(method) {
    if (method === '__close') {
      pageCdp = undefined
      if (state.visible) setTimeout(() => { void ensurePage().then(() => refreshState(true)).catch(() => {}) }, 500)
      return
    }
    if (method === 'Page.loadEventFired') void refreshState(true)
    if (method === 'Page.frameNavigated') setTimeout(() => { void refreshState(true) }, 120)
  }

  async function switchTarget(targetId) {
    if (targetId === state.targetId && pageCdp !== undefined && !pageCdp.closed) return
    pageCdp?.close()
    pageCdp = undefined
    pageTargets.set(targetId, pageTargets.get(targetId) ?? { targetId, type: 'page' })
    await ensurePage()
    await refreshState(true)
  }

  /** Attach a page-level CDP session to the active target. */
  async function ensurePage() {
    if (pageCdp !== undefined && !pageCdp.closed && state.targetId !== '') return true
    const list = await jsonList()
    const pages = list.filter(entry => entry.type === 'page')
    let info = pages.find(entry => entry.id === state.targetId)
    if (info === undefined) {
      info = pages.find(entry => entry.webSocketDebuggerUrl)
      if (info === undefined) {
        if (!(await createPage())) return false
        await sleep(350)
        const again = (await jsonList()).filter(entry => entry.type === 'page')
        info = again.find(entry => entry.webSocketDebuggerUrl)
        if (info === undefined) return false
      }
    }
    if (info.webSocketDebuggerUrl === undefined) return false
    const cdp = new CdpClient(info.webSocketDebuggerUrl, onPageEvent)
    try { await cdp.open() } catch (error) {
      log(`page CDP unavailable: ${error.message}`)
      return false
    }
    await cdp.send('Page.enable').catch(() => {})
    pageCdp = cdp
    state.targetId = info.id
    state.windowId = 0
    if (info.url) state.url = info.url
    if (info.title) state.title = info.title
    return true
  }

  async function evaluate(expression) {
    if (pageCdp === undefined || pageCdp.closed) return undefined
    try {
      const result = await pageCdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
      return result?.result?.value
    } catch { return undefined }
  }

  async function windowMetrics() {
    const raw = await evaluate('JSON.stringify({screenX,screenY,outerWidth,outerHeight,innerWidth,innerHeight,dpr:devicePixelRatio})')
    if (typeof raw !== 'string') return undefined
    try { return JSON.parse(raw) } catch { return undefined }
  }

  async function refreshState(force = false) {
    if (pageCdp === undefined || pageCdp.closed) return
    const info = await evaluate('JSON.stringify({url:location.href,title:document.title})')
    let history
    try { history = await pageCdp.send('Page.getNavigationHistory') } catch { /* older carries */ }
    let changed = force
    if (typeof info === 'string') {
      try {
        const parsed = JSON.parse(info)
        if (parsed.url && parsed.url !== state.url) { state.url = parsed.url; changed = true }
        if (parsed.title !== undefined && parsed.title !== state.title) { state.title = parsed.title; changed = true }
      } catch { /* ignore */ }
    }
    if (history?.currentIndex !== undefined && Array.isArray(history.entries)) {
      const canBack = history.currentIndex > 0
      const canForward = history.currentIndex < history.entries.length - 1
      if (canBack !== state.canBack || canForward !== state.canForward) { state.canBack = canBack; state.canForward = canForward; changed = true }
      const current = history.entries[history.currentIndex]
      if (current?.url && current.url !== state.url) { state.url = current.url; changed = true }
      if (current?.title && current.title !== state.title) { state.title = current.title; changed = true }
    }
    if (state.loading) { state.loading = false; changed = true }
    if (changed) pushState()
  }

  /* --------------------------------------------------------------- window */
  async function alive() {
    if (state.hwnd === 0) return false
    const reply = await callHelper('exists', { hwnd: state.hwnd })
    return reply.ok === true && reply.exists === true
  }

  async function findOwner() {
    let owner = await callHelper('find', { pid: process.pid })
    if (!(owner.ok === true && owner.hwnd > 0)) owner = await callHelper('find-title', { title: 'DeepSeek Harness' })
    return owner.ok === true ? owner.hwnd : 0
  }

  /** The browser window bounds (CSS px) that own the active page target. */
  async function cdpWindowBounds() {
    if (pageCdp === undefined || pageCdp.closed) return undefined
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        const { bounds } = await pageCdp.send('Browser.getWindowForTarget', { targetId: state.targetId })
        if (bounds?.width > 0) return bounds
      } catch { /* window still being created */ }
      await sleep(300)
    }
    return undefined
  }

  async function ensureWindow() {
    if (await alive()) {
      // Verify that the adopted HWND really is the window that owns the page (an Edge
      // auxiliary window, e.g. the translation bubble, must never be adopted).
      const current = await callHelper('rect', { hwnd: state.hwnd })
      if (current.ok === true && (!state.title || String(current.title ?? '').includes(state.title) || state.title === '')) return true
      state.hwnd = 0
      state.windowId = 0
      state.shown = false
    }
    state.hwnd = 0
    state.windowId = 0
    state.shown = false
    await stopFollower()
    const bounds = await cdpWindowBounds()
    const metrics = await windowMetrics()
    const dpr = metrics?.dpr ?? state.dpr ?? 1
    const hint = bounds === undefined ? {} : {
      rx: Math.round(bounds.left * dpr),
      ry: Math.round(bounds.top * dpr),
      rw: Math.round(bounds.width * dpr),
      rh: Math.round(bounds.height * dpr),
      tolerance: 90,
    }
    let found = { ok: false }
    for (let attempt = 0; attempt < 6; attempt += 1) {
      found = await callHelper('find-profile', { profile: state.profileDir, title: state.title, ...hint })
      if (found.ok === true && found.hwnd > 0) break
      await sleep(400)
    }
    if (!(found.ok === true && found.hwnd > 0)) return false
    state.hwnd = found.hwnd
    state.windowId = 0
    if (state.owner === 0) state.owner = await findOwner()
    // A leftover region from a previous host run would clip the newly adopted window
    // before the first layout: clear it, then place/crop deliberately.
    await callHelper('uncrop', { hwnd: state.hwnd })
    // Owner: keeps the cropped browser above DSH and hides it with the app. The tool
    // style keeps it out of the taskbar.
    await callHelper('own', { hwnd: state.hwnd, owner: state.owner })
    log(`adopted hwnd=${state.hwnd} title=${JSON.stringify(found.title)} rect=${found.x},${found.y} ${found.w}x${found.h}`)
    return true
  }

  /** Adopt the agent's Edge instance, creating a page/window when it is not running. */
  async function ensureEdge(url) {
    let carrier = carrierState()
    if (carrier === undefined) {
      state.text = 'Edge 未启动：正在拉起…'
      pushState()
      await launchEdge(url)
      carrier = carrierState()
      if (carrier === undefined) {
        state.text = 'Edge 未启动（未找到 msedge.exe）'
        pushState()
        return false
      }
    }
    state.cdpPort = carrier.cdpPort
    state.profileDir = carrier.dir
    if (!(await connectBrowser())) { /* target events are optional */ }
    const list = await jsonList()
    if (!list.some(entry => entry.type === 'page')) {
      await createPage()
      await sleep(350)
    }
    // A page session is needed before the window can be identified by its CDP bounds.
    await ensurePage()
    if (!(await ensureWindow())) {
      state.text = 'Edge 窗口未找到（可能已关闭）'
      pushState()
      return false
    }
    if (state.text === '' || state.text === '等待侧栏面板' || state.text === 'Edge 未启动：正在拉起…') state.text = 'Edge 已嵌入侧栏'
    return true
  }

  /* ---------------------------------------------------------------- layout */
  let layoutRunning = false
  let layoutDirty = false
  let lastLayoutAt = 0
  let closed = false

  function requestLayout() {
    if (layoutRunning) { layoutDirty = true; return }
    layoutRunning = true
    void (async () => {
      try {
        do {
          layoutDirty = false
          try { await layoutOnce() } catch (error) { log(`layout failed: ${error.message}`) }
        } while (layoutDirty)
      } finally { layoutRunning = false }
      pushState()
    })()
  }

  async function hideWindow() {
    await stopFollower()
    if (state.hwnd !== 0 && state.shown) {
      await callHelper('hide', { hwnd: state.hwnd })
      state.shown = false
    }
  }

  async function showWindow() {
    if (state.hwnd === 0 || closed) return
    // Raise without activating: SW_SHOWNOACTIVATE alone left the owned window behind an
    // active DSH window on some runs. HWND_TOP keeps it above the app without focus.
    await callHelper('show', { hwnd: state.hwnd })
    state.shown = true
  }

  /* -------------------------------------------------------------- follower */
  let followerActive = false
  let followerSize
  let followerInset

  /**
   * Start/update the native follower thread in the helper process. It glues the Edge
   * window to the DSH client origin at ~120 Hz, so dragging the DSH window does not show
   * the browser lagging behind by a renderer frame or a WebSocket round-trip.
   */
  async function startFollower() {
    if (closed || state.owner === 0 || state.hwnd === 0 || state.page === undefined) return false
    const dpr = state.dpr || 1
    let left = state.inset?.left
    let top = state.inset?.top
    if (left === undefined || top === undefined) {
      // Older client without `inset`: derive the body offset from the DSH client origin.
      const origin = await callHelper('client-origin', { hwnd: state.owner })
      if (origin.ok !== true) { followerActive = false; return false }
      left = (state.page.x * dpr - origin.x) / dpr
      top = (state.page.y * dpr - origin.y) / dpr
    }
    const x = Math.round(left * dpr)
    const y = Math.round(top * dpr)
    const w = Math.round(state.page.w * dpr)
    const h = Math.round(state.page.h * dpr)
    const reply = await callHelper('follow', { dsh: state.owner, edge: state.hwnd, x, y, w, h })
    followerActive = reply.ok === true
    followerSize = followerActive ? { w: state.page.w, h: state.page.h } : undefined
    followerInset = followerActive && state.inset ? { ...state.inset } : undefined
    if (!followerActive) log(`follower start failed: ${reply.error ?? 'unknown'}`)
    return followerActive
  }

  async function stopFollower() {
    if (!followerActive) return
    followerActive = false
    followerSize = undefined
    followerInset = undefined
    await callHelper('unfollow')
  }

  async function applyBounds(left, top, width, height) {
    const css = {
      left: Math.round(left),
      top: Math.round(top),
      width: Math.max(200, Math.round(width)),
      height: Math.max(200, Math.round(height)),
    }
    let lastError
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        if (state.windowId === 0) {
          const { windowId } = await pageCdp.send('Browser.getWindowForTarget', { targetId: state.targetId })
          state.windowId = windowId
        }
        await pageCdp.send('Browser.setWindowBounds', { windowId: state.windowId, bounds: { ...css, windowState: 'normal' } })
        return true
      } catch (error) {
        lastError = error
        state.windowId = 0
        await sleep(250)
      }
    }
    // Fallback: Win32 placement in physical pixels.
    const dpr = state.dpr || 1
    const reply = await callHelper('place', {
      hwnd: state.hwnd,
      x: Math.round(css.left * dpr),
      y: Math.round(css.top * dpr),
      w: Math.round(css.width * dpr),
      h: Math.round(css.height * dpr),
      owner: state.owner ?? 0,
    })
    log(`CDP bounds failed (${lastError?.message}); fallback place ok=${reply.ok}`)
    return reply.ok === true
  }

  async function cropToViewport(page) {
    const metrics = await windowMetrics()
    if (metrics === undefined) return false
    const dpr = metrics.dpr || state.dpr || 1
    const border = Math.max(0, (metrics.outerWidth - metrics.innerWidth) / 2)
    const chromeTop = Math.max(0, (metrics.outerHeight - metrics.innerHeight) - border)
    const rx = Math.round(border * dpr)
    const ry = Math.round(chromeTop * dpr)
    const rw = Math.round(Math.min(page.w, metrics.innerWidth) * dpr)
    const rh = Math.round(Math.min(page.h, metrics.innerHeight) * dpr)
    if (rw < 40 || rh < 40) return false
    const reply = await callHelper('crop', { hwnd: state.hwnd, rx, ry, rw, rh })
    return reply.ok === true
  }

  async function documentRect() {
    if (state.hwnd === 0) return undefined
    const reply = await callHelper('document-rect', { hwnd: state.hwnd })
    return reply.ok === true && reply.w >= 40 && reply.h >= 40 ? reply : undefined
  }

  async function windowRect() {
    if (state.hwnd === 0) return undefined
    const reply = await callHelper('rect', { hwnd: state.hwnd })
    return reply.ok === true ? reply : undefined
  }

  /**
   * UIA-based layout: the document rectangle is the page viewport in SCREEN pixels, so it
   * is correct even when Edge shows vertical tabs or a side panel (where the viewport is
   * not horizontally centred). The window is moved/sized by the delta, then the region is
   * the document rectangle relative to the window.
   */
  async function layoutByUia(page) {
    const metrics = await windowMetrics()
    if (metrics === undefined) return false
    const hostDpr = state.dpr || metrics.dpr || 1
    const edgeDpr = metrics.dpr || hostDpr
    const pagePhys = { x: page.x * hostDpr, y: page.y * hostDpr, w: page.w * hostDpr, h: page.h * hostDpr }
    let doc = await documentRect()
    let win = await windowRect()
    if (doc === undefined || win === undefined) return false
    log(`uia page=${JSON.stringify(page)} doc=${doc.x},${doc.y} ${doc.w}x${doc.h} win=${win.x},${win.y} ${win.w}x${win.h}`)
    await applyBounds(
      (win.x + (pagePhys.x - doc.x)) / edgeDpr,
      (win.y + (pagePhys.y - doc.y)) / edgeDpr,
      (win.w + (pagePhys.w - doc.w)) / edgeDpr,
      (win.h + (pagePhys.h - doc.h)) / edgeDpr,
    )
    await sleep(160)
    doc = await documentRect()
    win = await windowRect()
    if (doc === undefined || win === undefined) return false
    const dx = doc.x - pagePhys.x
    const dy = doc.y - pagePhys.y
    if (Math.abs(dx) > 1.5 || Math.abs(dy) > 1.5) {
      await applyBounds((win.x - dx) / edgeDpr, (win.y - dy) / edgeDpr, win.w / edgeDpr, win.h / edgeDpr)
      await sleep(140)
      doc = await documentRect()
      win = await windowRect()
      if (doc === undefined || win === undefined) return false
    }
    const rx = Math.round(doc.x - win.x)
    const ry = Math.round(doc.y - win.y)
    const rw = Math.round(Math.min(pagePhys.w, doc.w))
    const rh = Math.round(Math.min(pagePhys.h, doc.h))
    if (rw < 40 || rh < 40) return false
    const reply = await callHelper('crop', { hwnd: state.hwnd, rx, ry, rw, rh })
    return reply.ok === true
  }

  /** Metrics fallback when UIA is unavailable: assumes a centred viewport. */
  async function layoutByMetrics(page) {
    const first = await windowMetrics()
    if (first === undefined) return false
    const b0 = Math.max(0, (first.outerWidth - first.innerWidth) / 2)
    const top0 = Math.max(0, (first.outerHeight - first.innerHeight) - b0)
    const left = page.x - b0
    const top = page.y - top0
    const width = page.w + 2 * b0
    const height = page.h + top0 + b0
    log(`metrics page=${JSON.stringify(page)} first=${JSON.stringify(first)} bounds=${JSON.stringify({ left, top, width, height })}`)
    await applyBounds(left, top, width, height)
    await sleep(120)

    let m = await windowMetrics()
    if (m === undefined) return false
    let b = Math.max(0, (m.outerWidth - m.innerWidth) / 2)
    let topOffset = Math.max(0, (m.outerHeight - m.innerHeight) - b)
    const dx = (m.screenX + b) - page.x
    const dy = (m.screenY + topOffset) - page.y
    if (Math.abs(dx) > 1.5 || Math.abs(dy) > 1.5) {
      await applyBounds(m.screenX - dx, m.screenY - dy, m.outerWidth, m.outerHeight)
      await sleep(120)
      m = await windowMetrics()
      if (m === undefined) return false
    }
    return cropToViewport(page)
  }

  async function layoutOnce() {
    if (closed) return
    state.lastLayoutAt = Date.now()
    if (!state.visible || state.page === undefined) { await hideWindow(); return }
    const page = state.page
    if (!(page.w >= 80) || !(page.h >= 80)) { await hideWindow(); return }
    if (!(await ensureEdge(state.url))) { await hideWindow(); return }

    const metrics = await windowMetrics()
    if (metrics?.dpr) state.dpr = metrics.dpr
    // Keep the browser's OWN title bar / tab strip / address bar: dock the whole Edge
    // window onto the pane body instead of cropping it to the page. The pane body starts
    // BELOW the DSH sidebar header, so the browser can no longer cover the app's hide /
    // collapse controls. (A window region also failed to clip Edge's own browser-UI
    // overlays such as the translate bubble, which is what covered those controls.)
    await callHelper('uncrop', { hwnd: state.hwnd })
    const laid = await applyBounds(page.x, page.y, page.w, page.h)
    if (!laid) { log('layout failed'); await hideWindow(); return }
    await showWindow()
    await startFollower()
    if (state.text !== 'Edge 已嵌入侧栏') state.text = 'Edge 已嵌入侧栏'
  }

  /* ------------------------------------------------------------- navigation */
  async function navigate(url) {
    const target = normalizeUrl(url)
    if (target === undefined) throw new Error('只支持 HTTP/HTTPS 地址')
    if (!(await ensureEdge(target))) throw new Error('Edge 未就绪')
    if (!(await ensurePage())) throw new Error('Edge 页面未就绪')
    state.loading = true
    state.text = '正在打开页面…'
    pushState()
    await pageCdp.send('Page.navigate', { url: target })
    state.url = target
    setTimeout(() => { void refreshState(true) }, 600)
    pushState()
    return target
  }
  async function goHistory(delta) {
    if (!(await ensurePage())) throw new Error('Edge 页面未就绪')
    const history = await pageCdp.send('Page.getNavigationHistory')
    const index = history.currentIndex + delta
    if (index < 0 || index >= history.entries.length) return
    await pageCdp.send('Page.navigateToHistoryEntry', { entryId: history.entries[index].id })
    setTimeout(() => { void refreshState(true) }, 400)
  }

  async function reload() {
    if (!(await ensurePage())) throw new Error('Edge 页面未就绪')
    await pageCdp.send('Page.reload')
    setTimeout(() => { void refreshState(true) }, 400)
  }

  /* ----------------------------------------------------------------- ws */
  function attachClient(socket) {
    const client = {
      socket,
      alive: true,
      send(message) {
        if (!this.alive) return
        try { socket.write(encodeText(JSON.stringify(message))) } catch { this.alive = false }
      },
      close() {
        this.alive = false
        try { socket.destroy() } catch { /* already gone */ }
      },
    }
    clients.add(client)
    client.send({ t: 'state', ...status() })
    let buffer = Buffer.alloc(0)
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk])
      for (;;) {
        if (buffer.length < 2) return
        const opcode = buffer[0] & 0x0f
        const masked = (buffer[1] & 0x80) !== 0
        let len = buffer[1] & 0x7f
        let offset = 2
        if (len === 126) {
          if (buffer.length < 4) return
          len = buffer.readUInt16BE(2)
          offset = 4
        } else if (len === 127) {
          if (buffer.length < 10) return
          len = Number(buffer.readBigUInt64BE(2))
          offset = 10
        }
        const maskLen = masked ? 4 : 0
        if (buffer.length < offset + maskLen + len) return
        const mask = masked ? buffer.subarray(offset, offset + 4) : null
        const payload = Buffer.from(buffer.subarray(offset + maskLen, offset + maskLen + len))
        buffer = buffer.subarray(offset + maskLen + len)
        if (mask) for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4]
        if (opcode === 8) { client.close(); return }
        if (opcode === 9) { try { socket.write(Buffer.from([0x8a, 0])) } catch { /* gone */ }; continue }
        if (opcode !== 1) continue
        let message
        try { message = JSON.parse(payload.toString('utf8')) } catch { continue }
        void handleMessage(message, client)
      }
    })
    socket.on('close', () => {
      clients.delete(client)
      // No pane watching any more: do not leave the cropped browser floating over DSH.
      if (clients.size === 0) {
        state.visible = false
        void hideWindow()
      }
    })
    socket.on('error', () => clients.delete(client))
  }

  async function handleMessage(message, client) {
    try {
      if (message.t === 'dock' || message.t === 'page') {
        const page = message.page
        if (page !== undefined && Number.isFinite(page.x) && Number.isFinite(page.y)
          && Number.isFinite(page.w) && Number.isFinite(page.h)) {
          state.page = { x: page.x, y: page.y, w: Math.max(0, page.w), h: Math.max(0, page.h) }
        }
        const inset = message.inset
        if (inset !== undefined && Number.isFinite(inset.left) && Number.isFinite(inset.top)) {
          state.inset = { left: inset.left, top: inset.top }
        }
        if (Number.isFinite(message.dpr) && message.dpr > 0) state.dpr = message.dpr
        state.visible = Boolean(message.visible)
        if (!state.visible) {
          await hideWindow()
          pushState()
          return
        }
        if (state.hwnd === 0 || !state.shown || state.page === undefined) {
          requestLayout()
          return
        }
        if (!followerActive) {
          // No native follower yet: move the whole window immediately, no CDP/UIA.
          const dpr = state.dpr || 1
          const reply = await callHelper('move', {
            hwnd: state.hwnd,
            x: Math.round(state.page.x * dpr),
            y: Math.round(state.page.y * dpr),
            w: Math.round(state.page.w * dpr),
            h: Math.round(state.page.h * dpr),
          })
          if (reply.ok !== true) requestLayout()
          return
        }
        // The native follower handles pure moves. Only a geometry (size/inset) change
        // needs new parameters; Update keeps the following thread alive.
        if (followerSize === undefined
          || Math.abs(state.page.w - followerSize.w) > 1
          || Math.abs(state.page.h - followerSize.h) > 1
          || (state.inset !== undefined && followerInset !== undefined
            && (Math.abs(state.inset.left - followerInset.left) > 1
              || Math.abs(state.inset.top - followerInset.top) > 1))) {
          await startFollower()
        }
        return
      }
      if (message.t === 'nav') {
        await navigate(String(message.url ?? ''))
        client.send({ t: 'state', ...status() })
        return
      }
      if (message.t === 'back') { await goHistory(-1); client.send({ t: 'state', ...status() }); return }
      if (message.t === 'forward') { await goHistory(1); client.send({ t: 'state', ...status() }); return }
      if (message.t === 'reload') { await reload(); client.send({ t: 'state', ...status() }); return }
      if (message.t === 'undock') {
        await hideWindow()
        state.visible = false
        pushState()
        return
      }
      client.send({ t: 'state', ...status(), error: `unknown message: ${message.t}` })
    } catch (error) {
      client.send({ t: 'state', ...status(), error: error.message })
      log(`message ${message.t} failed: ${error.message}`)
    }
  }

  /* ---------------------------------------------------------------- http */
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/health') {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      response.end(JSON.stringify({ ...status(), clients: clients.size }))
      return
    }
    if (url.pathname === '/navigate' && url.searchParams.get('url')) {
      void navigate(url.searchParams.get('url')).catch(() => {})
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify({ ok: true }))
      return
    }
    response.writeHead(404, { 'content-type': 'text/plain' })
    response.end('not found')
  })

  server.on('upgrade', (request, socket) => {
    const key = request.headers['sec-websocket-key']
    if (typeof key !== 'string') { socket.destroy(); return }
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
      + `Sec-WebSocket-Accept: ${wsAccept(key)}\r\n\r\n`,
    )
    attachClient(socket)
  })

  server.listen(port, '127.0.0.1', () => log(`dock service on http://127.0.0.1:${port}/`))
  server.on('error', error => log(`dock server error: ${error.message}`))

  /** Recovery loop: relaunched Edge gives a new HWND; re-adopt and re-crop. */
  async function keepDocked() {
    if (state.visible && state.page !== undefined) {
      if (!(await alive())) {
        state.hwnd = 0
        state.windowId = 0
        state.shown = false
        requestLayout()
      } else if (Date.now() - lastLayoutAt > 2500) {
        // The pane may have been shown again after a hide; re-assert the crop.
        if (!state.shown) requestLayout()
      }
    }
    if (state.visible && state.page !== undefined && Date.now() - state.lastRefresh > 1000) {
      state.lastRefresh = Date.now()
      void refreshState()
    }
    if (state.visible && state.page !== undefined && browserCdp === undefined) void connectBrowser()
  }
  state.lastRefresh = 0
  const keepTimer = setInterval(() => { void keepDocked() }, 1800)

  return {
    port,
    status,
    show: async url => {
      try { await navigate(url) } catch (error) { state.text = error.message }
      // Never reveal the raw browser window when no pane is visible: the tool only
      // navigates the shared instance; the pane decides when it is on screen.
      if (state.visible && state.page !== undefined) requestLayout()
      pushState()
      return status()
    },
    navigate,
    back: () => goHistory(-1),
    forward: () => goHistory(1),
    reload,
    async close() {
      closed = true
      clearInterval(keepTimer)
      for (const client of clients) client.close()
      clients.clear()
      await stopFollower()
      if (state.hwnd !== 0) {
        // The browser belongs to the agent's session: stop showing it, never kill it.
        // Await the helper replies BEFORE killing the helper, otherwise the hide request
        // is written to a process that is already going away and the window stays up.
        await callHelper('uncrop', { hwnd: state.hwnd })
        await callHelper('hide', { hwnd: state.hwnd })
      }
      pageCdp?.close()
      browserCdp?.close()
      try { server.close() } catch { /* ignore */ }
      try { helper?.kill() } catch { /* ignore */ }
    },
  }
}

