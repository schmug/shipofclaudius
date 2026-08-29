// Pure protocol dispatch for the vent tool. No I/O: every side effect arrives
// through `deps`, which is what makes the suite fast and hermetic.
export const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25']
export const SERVER_INFO = { name: 'vent', version: '1.0.0' }
export const RATE_WINDOW_MS = 90_000
export const MAX_PER_SESSION = 10
const META_VERSION = 'io.modelcontextprotocol/protocolVersion'

export const TOOL = {
  name: 'vent',
  description:
    "Record friction with Cory's agent tooling: a hook that blocked legitimate work, " +
    'a skill that misfired, a permission denial that cost you a retry, a guardrail whose ' +
    'rule was ambiguous, a command that failed confusingly. Free text — say what happened ' +
    'and what you wanted to happen. There is no bar to clear and no format to follow; if ' +
    'something about this environment made your work harder, that is enough. Fire and ' +
    'continue — this never blocks and never needs follow-up.',
  inputSchema: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
  },
}

export const makeState = () => ({ stamps: [], count: 0 })

const ok = (id, result) => ({ jsonrpc: '2.0', id, result })
const err = (id, code, message, data) => ({
  jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) },
})

export function handle(msg, state, deps) {
  const { method, id, params } = msg
  const isNotification = id === undefined

  if (method === 'initialize') {
    const requested = params?.protocolVersion
    return ok(id, {
      protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25',
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    })
  }
  if (method === 'notifications/initialized') return null
  if (method === 'tools/list') return ok(id, { tools: [TOOL] })
  if (method === 'tools/call') {
    if (params?.name !== TOOL.name) return err(id, -32602, `Unknown tool: ${params?.name}`)
    return ok(id, callVent(params?.arguments, state, deps))
  }
  if (isNotification) return null
  return err(id, -32601, `Method not found: ${method}`)
}

function result(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], isError: false }
}

function callVent(args, state, deps) {
  // Both guards are the shape docs/specs/2026-08-28-vent-tool-plan.md writes for Task 4,
  // pulled forward into the task that actually makes the server reachable: n1 ships the
  // .mcp.json, so any window where the live tool lies about recording is a real window.
  // Rate limiting stays in n2 (#142) with the real sink — RATE_WINDOW_MS, MAX_PER_SESSION
  // and `state` remain forward declarations until then.
  const text = args?.text
  if (typeof text !== 'string' || text.trim() === '') {
    return result({ recorded: false, reason: 'invalid-input' })
  }
  const record = { ts: new Date(deps.now()).toISOString(), text, ...deps.context() }
  if (!deps.appendVent(record)) {
    return result({ recorded: false, reason: 'sink-unavailable' })
  }
  return result({ recorded: true })
}
