/**
 * Agent-facing tools for the docked sidebar Edge.
 *
 * The docked window is the human's browser in the sidebar; these tools let the agent
 * join the same instance: ask what it is showing, and navigate it. They are optional —
 * a profile without the tools service loses only these, not the sidebar.
 *
 * `defineTool` is imported dynamically: a profile without the tools package must not
 * lose the sidebar because of a module that this plugin only optionally needs.
 */
import { appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** JSON schema for both tools' return value. */
const STATUS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    docked: { type: 'boolean', required: true },
    visible: { type: 'boolean', required: true },
    url: { type: 'string', required: true },
    title: { type: 'string' },
    text: { type: 'string', required: true },
    canBack: { type: 'boolean' },
    canForward: { type: 'boolean' },
    edgePort: { type: 'number' },
  },
}

/** One-line human-readable rendering of a status value. */
function formatStatus(value) {
  const where = value.docked
    ? value.visible ? '已嵌入侧栏' : '已嵌入但面板当前不可见'
    : '未嵌入'
  const title = value.title ? `（${value.title}）` : ''
  return `侧栏 Edge：${where}\n页面：${value.url || '(空)'}${title}\n${value.text}`
}

/**
 * Build the tool definitions against one dock service.
 * @param defineTool - the host's tool factory.
 * @param dock - the service returned by `startDock`.
 * @returns the definitions.
 */
export function sidebarToolDefinitions(defineTool, dock) {
  const statusValue = () => {
    const status = dock.status()
    return {
      docked: status.docked,
      visible: status.visible,
      url: status.url ?? '',
      title: status.title ?? '',
      text: status.text ?? '',
      canBack: Boolean(status.canBack),
      canForward: Boolean(status.canForward),
      ...status.edgePort === undefined ? {} : { edgePort: status.edgePort },
    }
  }

  return [
    defineTool({
      name: 'edge_sidebar_status',
      description: 'Report the Edge window docked into the DSH sidebar: whether the shared Edge instance is adopted/visible, which URL and title it shows, and the dock text. Use it before edge_sidebar_show, and to tell the user which page you are both looking at.',
      parameters: {},
      output: {
        schema: STATUS_SCHEMA,
        render: (_args, value) => [{ type: 'text', text: formatStatus(value) }],
      },
      timeoutMs: 20_000,
      isConcurrencySafe: () => true,
      async execute() {
        return statusValue()
      },
    }),

    defineTool({
      name: 'edge_sidebar_show',
      description: 'Navigate the Edge window docked into the DSH sidebar (the same instance the user sees there and dsh_browser_* drives). This is not a projection: it navigates the real Edge page. Works even while the sidebar is hidden; the pane shows the window when it is visible.',
      parameters: {
        url: { type: 'string', required: true, description: 'URL to open in the docked Edge (HTTP/HTTPS).' },
      },
      output: {
        schema: STATUS_SCHEMA,
        render: (_args, value) => [{ type: 'text', text: formatStatus(value) }],
      },
      timeoutMs: 30_000,
      isConcurrencySafe: () => false,
      async execute(args) {
        const url = String(args.url ?? '').trim()
        if (url === '') throw new Error('edge_sidebar_show: url is required')
        await dock.navigate(url)
        return statusValue()
      },
    }),
  ]
}

/**
 * Where to import `defineTool` from.
 *
 * A plugin installed as a directory link has no peer dependencies materialised, so the
 * bare specifier can fail even though the host itself has the package. The second
 * candidate is the host's own copy inside the installed archive (Electron's fs maps
 * `app.asar` paths transparently), derived from the executable location.
 * @returns candidate specifiers, most portable first.
 */
function defineToolCandidates() {
  const candidates = ['@deepseek-ai/dsh-tools']
  try {
    const installRoot = process.execPath.replace(/[\\/][^\\/]+$/, '')
    const packaged = `${installRoot}\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-tools\\lib\\index.js`
    candidates.push(new URL(`file:///${packaged.replace(/\\/g, '/')}`).href)
  } catch { /* no execPath: stay with the bare specifier */ }
  return candidates
}

/** Append one diagnostic line beside the plugin's settings, best-effort. */
function noteDiagnostic(line) {
  try {
    const root = process.env.DSH_HOME ?? join(homedir(), '.dsh')
    appendFileSync(join(root, 'edge-sidebar.log'), `${new Date().toISOString()} ${line}\n`)
  } catch { /* diagnostics must never break the plugin */ }
}

/** Convert the compact per-property spec used in this file into JSON Schema. */
function toJsonSchema(spec) {
  const properties = {}
  const required = []
  for (const [name, field] of Object.entries(spec?.properties ?? spec ?? {})) {
    const { required: isRequired, ...rest } = field
    properties[name] = rest
    if (isRequired === true) required.push(name)
  }
  return {
    type: 'object',
    additionalProperties: false,
    properties,
    ...required.length > 0 ? { required } : {},
  }
}

/**
 * Build a registry-ready definition WITHOUT the host's `defineTool` helper.
 *
 * `defineTool` is a convenience wrapper (spec → JSON Schema, plus argument/output
 * validation). A plugin installed as a directory link has no materialised peer
 * dependencies, so that import can fail even though the host itself works — and then
 * two whole tools would silently disappear. The registry accepts a plain definition
 * whose `parameters` is already JSON Schema, which is exactly what this builds.
 * @param options - the same options this file passes to defineTool.
 * @returns a plain registry-ready definition.
 */
export function plainTool(options) {
  return {
    name: options.name,
    description: options.description,
    parameters: toJsonSchema(options.parameters),
    output: {
      schema: toJsonSchema(options.output?.schema),
      render: options.output?.render ?? (() => []),
    },
    ...options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs },
    ...options.isConcurrencySafe === undefined ? {} : { isConcurrencySafe: options.isConcurrencySafe },
    execute: options.execute,
  }
}

/**
 * Register the tools when the host provides a tools service.
 * @param ctx - a context that has `tools`.
 * @param dock - the service returned by `startDock`.
 */
export async function registerSidebarTools(ctx, dock) {
  let defineTool
  const failures = []
  for (const specifier of defineToolCandidates()) {
    try {
      ({ defineTool } = await import(specifier))
      noteDiagnostic(`tools: defineTool loaded from ${specifier}`)
      break
    } catch (error) {
      failures.push(`${specifier}: ${error.message}`)
    }
  }
  const build = defineTool ?? plainTool
  if (defineTool === undefined) noteDiagnostic(`tools: defineTool unavailable, using the plain builder (${failures.join(' | ')})`)
  for (const definition of sidebarToolDefinitions(build, dock)) {
    try {
      ctx.tools.register(definition)
      noteDiagnostic(`tools: registered ${definition?.name}`)
    } catch (error) {
      // A name collision must cost one tool, not the sidebar.
      const message = `dsh-edge-sidebar: could not register ${definition?.name} (${error.message})`
      ctx.logger?.warn?.(message)
      noteDiagnostic(message)
    }
  }
}
