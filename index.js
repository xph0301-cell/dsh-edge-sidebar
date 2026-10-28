/**
 * dsh-edge-sidebar — host half.
 *
 * The sidebar's browser tab kind is replaced by this plugin's client half. The host
 * adopts the same Microsoft Edge window the agent drives over CDP and DOCKs the WHOLE
 * window — title bar, tab strip and address bar included — exactly onto the sidebar pane
 * body. The pane body starts below the DSH sidebar header, so the browser never covers the
 * app's own hide/collapse controls, while browser control stays native (tabs, address bar,
 * input, IME, downloads). No canvas, iframe or projected frames.
 *
 * `lib/dock.js` owns the adopted instance (window placement, visibility, CDP session,
 * navigation); `lib/dock-helper.ps1` owns every Win32 call. This file only wires the
 * service into the host context and registers the optional agent tools plus
 * the system-prompt note that teaches the model when to use them.
 */
import { DOCK_PORT, startDock } from './dock.js'
import { registerSidebarTools } from './tools.js'

/** Cordis plugin name, shown in loader diagnostics. */
export const name = 'dsh-edge-sidebar'

/** No services are required: docking talks to Win32 through the helper process. */
export const inject = []

/**
 * Start the dock service for this host process' lifetime.
 * @param ctx - the cordis context.
 */
export function apply(ctx) {
  // The port is fixed in the client half too; the environment override exists only so
  // the host half can run in a test sandbox beside a running DSH.
  const port = Number(process.env.DSH_EDGE_SIDEBAR_PORT ?? DOCK_PORT)
  const server = startDock({ port, log: message => ctx.logger?.info?.(`dsh-edge-sidebar: ${message}`) })
  ctx.effect(() => () => server.close(), 'dsh-edge-sidebar: dock')
  ctx.logger?.info?.(`dsh-edge-sidebar: dock service on http://127.0.0.1:${server.port}/`)

  // Optional: a profile without the tools service keeps the sidebar and loses only the
  // two agent tools.
  try {
    ctx.inject(['tools'], scope => { void registerSidebarTools(scope, server) })
  } catch (error) {
    ctx.logger?.warn?.(`dsh-edge-sidebar: tools service unavailable (${error.message})`)
  }

  // Discoverability: without this line the model has two tools it does not know when to use.
  try {
    ctx.inject(['systemPrompt'], scope => {
      scope.systemPrompt?.section?.({
        name: 'tool:edge-sidebar',
        order: 151,
        text: 'The DSH right sidebar docks a REAL Microsoft Edge window: the same Edge instance your dsh_browser_* tools drive is placed, with its own title bar/tabs/address bar, exactly onto the sidebar pane body (below the app header, so it does not cover DSH controls). It is not a projection or an iframe. Call edge_sidebar_status to learn whether the pane is showing a page and which URL/title it has; call edge_sidebar_show with `url` to navigate that same Edge. Because it is the same instance, dsh_browser_* and edge_sidebar_* share one page — do not assume the sidebar is visible, and do not close the Edge window: hiding the pane only hides it.',
      })
    })
  } catch (error) {
    ctx.logger?.warn?.(`dsh-edge-sidebar: system prompt service unavailable (${error.message})`)
  }
}
