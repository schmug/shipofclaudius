// Pure protocol dispatch for the vent tool. No I/O: every side effect arrives
// through `deps`, which is what makes the suite fast and hermetic.
export const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25']
// Which of the SUPPORTED_VERSIONS actually use the modern result shape. Kept separate
// because server/discover advertises the whole supported list, so a _meta-bearing
// client can negotiate DOWN to 2025-11-25 — and that revision defines neither
// resultType nor structuredContent. Presence of _meta is NOT the era signal.
export const MODERN_VERSIONS = ['2026-07-28']
// The complement, DERIVED rather than written out: a version added to MODERN_VERSIONS
// leaves the `initialize` door in the same edit, so the two lists cannot drift apart.
export const LEGACY_VERSIONS = SUPPORTED_VERSIONS.filter((v) => !MODERN_VERSIONS.includes(v))
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
  // Two eras in one process, selected per request (design spec §4.1). Modern
  // (2026-07-28) removed the handshake: a client is stateless and declares its version
  // in `_meta` on every request. Legacy (2025-11-25 and earlier) opens with `initialize`
  // and carries no `_meta`, so the absence of this key IS the legacy signal.
  const requestedVersion = params?._meta?.[META_VERSION]

  // A version we do not speak MUST be rejected rather than guessed at — the modern spec
  // is normative on that. The gate sits in front of method dispatch so a rejected call
  // costs nothing and can never reach the sink. A notification carries no id, so there
  // is nothing to answer: not even to reject it.
  // Presence, not truthiness: a client that declares '' or null has declared a version
  // we do not speak, and the spec is normative that it MUST be rejected rather than
  // guessed at. Only an ABSENT key means "legacy client, no _meta at all".
  if (requestedVersion !== undefined && !SUPPORTED_VERSIONS.includes(requestedVersion)) {
    if (isNotification) return null
    return err(id, -32022, 'Unsupported protocol version', {
      supported: SUPPORTED_VERSIONS, requested: requestedVersion,
    })
  }
  const modern = MODERN_VERSIONS.includes(requestedVersion)

  // Nothing arriving without an id may be answered — a reply with no id is a protocol
  // violation, and index.mjs would write it straight to stdout. This sits in FRONT of
  // dispatch so EVERY method inherits it, including ones added later: server/discover
  // was added above the old trailing guard and answered notifications until this moved.
  if (isNotification) return null

  // Mandatory in the modern era, and answered in either: it is how a client learns what
  // this server speaks, so gating it behind a version it has not yet learned is circular.
  if (method === 'server/discover') {
    return ok(id, {
      resultType: 'complete',
      supportedVersions: SUPPORTED_VERSIONS,
      capabilities: { tools: {} },
      _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
    })
  }
  if (method === 'initialize') {
    // `initialize` IS the legacy handshake — the modern revision removed it — so a client
    // arriving here is a legacy-era client and may only negotiate a LEGACY version (design
    // spec §4.1: "an `initialize` request selects legacy semantics for that stdio process").
    // Gating on LEGACY_VERSIONS, not SUPPORTED_VERSIONS, is the whole point: the latter let
    // a client ask for 2026-07-28 through this door and be told yes, after which every
    // subsequent request — carrying no _meta — was served the LEGACY shape. Answering a
    // modern request with 2025-11-25 negotiates it DOWN, which is ordinary legacy behaviour.
    const requested = params?.protocolVersion
    return ok(id, {
      protocolVersion: LEGACY_VERSIONS.includes(requested) ? requested : '2025-11-25',
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    })
  }
  if (method === 'tools/list') {
    return ok(id, modern ? { resultType: 'complete', tools: [TOOL] } : { tools: [TOOL] })
  }
  if (method === 'tools/call') {
    if (params?.name !== TOOL.name) return err(id, -32602, `Unknown tool: ${params?.name}`)
    return ok(id, callVent(params?.arguments, state, deps, modern))
  }
  return err(id, -32601, `Method not found: ${method}`)
}

// The era decides the SHAPE, never the outcome: the same payload goes out either way.
// A legacy result must carry no modern-only field — Claude Code is the legacy client, so
// that is the era where a wire-contract slip is a real outage rather than a hypothetical
// one. Modern additionally mirrors the payload structurally; the text block stays for
// backwards compatibility, and `structuredContent` needs no `outputSchema` on the tool
// (the spec only constrains it when one is declared).
function result(payload, modern) {
  const body = { content: [{ type: 'text', text: JSON.stringify(payload) }], isError: false }
  return modern ? { resultType: 'complete', structuredContent: payload, ...body } : body
}

function callVent(args, state, deps, modern) {
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
    return result({ recorded: false, reason: 'invalid-input' }, modern)
  }
  const now = deps.now()
  state.stamps = state.stamps.filter((t) => now - t < RATE_WINDOW_MS)
  if (state.stamps.length > 0 || state.count >= MAX_PER_SESSION) {
    return result({ recorded: false, reason: 'rate-limited' }, modern)
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
    return result({ recorded: false, reason: 'sink-unavailable' }, modern)
  }
  state.count += 1
  return result({ recorded: true }, modern)
}
