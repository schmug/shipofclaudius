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
  // Four outcomes, all of them calm (design spec §4.6). The ordering is load-bearing:
  // an invalid-input or rate-limited refusal is decided before anything is built or
  // written, so it costs a clock read and nothing else — no sink touch, no quota
  // consumed. (sink-unavailable is the one refusal decided AFTER a write attempt; the
  // window stamp below is what keeps that path bounded.)
  //
  // `text` is the entire input surface. The record is assembled field by field from the
  // clock and deps.context(), never spread from `args`, so an agent cannot plant `ts`,
  // `session` or `repo` values that the weekly triage would read as captured fact.
  const text = args?.text
  if (typeof text !== 'string' || text.trim() === '') {
    return result({ recorded: false, reason: 'invalid-input' })
  }
  const now = deps.now()
  state.stamps = state.stamps.filter((t) => now - t < RATE_WINDOW_MS)
  if (state.stamps.length > 0 || state.count >= MAX_PER_SESSION) {
    return result({ recorded: false, reason: 'rate-limited' })
  }
  // The two limits bound DIFFERENT things, so they advance at different points.
  // The window bounds INVOCATIONS, so its stamp lands BEFORE the write can fail:
  // advancing it only on success let an unwritable sink (full disk, read-only home,
  // bad VENT_SINK, CI with no ~/.claude) remove the only bound on how often this runs,
  // while each attempt still paid for deps.context() and its two git subprocesses.
  state.stamps.push(now)
  // callVent must be TOTAL. index.mjs's -32603 backstop limits the blast radius but is
  // itself an error in front of the agent, so a throwing dep is absorbed here instead.
  // Context is spread FIRST so a future context field cannot shadow the clock or the
  // agent's text — "assembled field by field" structural rather than dependent on
  // context.mjs happening to return exactly {cwd, repo, branch, session}.
  let ctx = {}
  try { ctx = deps.context() } catch { ctx = {} }
  const record = { ...ctx, ts: new Date(now).toISOString(), text }
  let written = false
  try { written = deps.appendVent(record) } catch { written = false }
  if (!written) {
    // The quota, unlike the window, tracks records WRITTEN, not calls attempted, so a
    // broken disk still cannot burn the session's ten vents.
    return result({ recorded: false, reason: 'sink-unavailable' })
  }
  state.count += 1
  return result({ recorded: true })
}
