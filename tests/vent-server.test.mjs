// Contract test for packages/vent-server — the agent vent tool.
// Node built-ins only; zero token cost. Unit tests drive the pure dispatcher
// directly; one integration test spawns the real server, pinning the framing
// defect described below. Full stdio-framing coverage arrives with n3 (#143).
//   node tests/vent-server.test.mjs
//
// The invariant this suite exists to protect: a vent must NEVER error into a
// session. Every outcome an agent can cause returns isError:false with a calm
// {recorded:false, reason} payload. A vent that fails loudly trains agents to
// stop calling it, which is the failure mode the question board already had.
// Two of those outcomes are live here (invalid-input, sink-unavailable);
// rate-limited arrives with the real sink in n2 (#142).
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { handle, makeState, TOOL, SERVER_INFO, SUPPORTED_VERSIONS } from '../packages/vent-server/server.mjs'

const tests = []
const test = (name, fn) => tests.push([name, fn])

// A deps stub with a controllable clock and an in-memory sink.
function stubDeps({ now = 1_000_000, writes = [], ok = true } = {}) {
  const d = {
    now: () => d._now,
    appendVent: (r) => { if (!ok) return false; writes.push(r); return true },
    context: () => ({ cwd: '/p', repo: 'schmug/x', branch: 'main', session: 's1' }),
    _now: now,
    writes,
  }
  return d
}

const call = (state, deps, args, extra = {}) =>
  handle({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'vent', arguments: args, ...extra } }, state, deps)

// Reads the JSON payload back out of a tools/call result.
const payloadOf = (reply) => JSON.parse(reply.result.content[0].text)

test('legacy initialize echoes a supported protocolVersion and declares tools', () => {
  const reply = handle(
    { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-11-25' } },
    makeState(), stubDeps())
  assert.equal(reply.result.protocolVersion, '2025-11-25')
  assert.deepEqual(reply.result.capabilities, { tools: {} })
  assert.deepEqual(reply.result.serverInfo, SERVER_INFO)
})

test('notifications/initialized draws NO reply', () => {
  // Verified against Claude Code 2.1.241: it arrives with no `id`. Replying to a
  // notification is a protocol violation.
  const reply = handle({ jsonrpc: '2.0', method: 'notifications/initialized' }, makeState(), stubDeps())
  assert.equal(reply, null)
})

test('tools/list returns exactly the vent tool with a valid inputSchema', () => {
  const reply = handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, makeState(), stubDeps())
  assert.deepEqual(reply.result.tools, [TOOL])
  assert.equal(TOOL.name, 'vent')
  assert.equal(TOOL.inputSchema.type, 'object')
  assert.deepEqual(TOOL.inputSchema.required, ['text'])
  assert.deepEqual(Object.keys(TOOL.inputSchema.properties), ['text'],
    'text is the ONLY input; every extra field is friction at the moment of use')
})

test('tools/call records a vent and reports recorded:true', () => {
  const deps = stubDeps()
  const reply = call(makeState(), deps, { text: 'the hook blocked a legitimate push' })
  assert.deepEqual(payloadOf(reply), { recorded: true })
  assert.equal(reply.result.isError, false)
  assert.equal(deps.writes.length, 1)
  assert.equal(deps.writes[0].text, 'the hook blocked a legitimate push')
})

test('a malformed tools/call always draws a reply, never a silent drop', () => {
  // The defect this pins: callVent read `args.text` off an unguarded `args`, so a
  // tools/call with no `arguments` key THREW; index.mjs caught the throw into a null
  // reply and wrote nothing, leaving a request that carried an id with no response
  // line at all. The client then blocks until its own timeout — strictly worse than
  // the error the isError:false contract exists to avoid.
  const deps = stubDeps()
  for (const params of [
    { name: 'vent' },                              // no `arguments` key at all
    { name: 'vent', arguments: null },
    { name: 'vent', arguments: {} },               // no `text`
    { name: 'vent', arguments: { text: 123 } },    // inputSchema declares type:'string'
    { name: 'vent', arguments: { text: '   ' } },  // whitespace only
  ]) {
    const reply = handle({ jsonrpc: '2.0', id: 7, method: 'tools/call', params }, makeState(), deps)
    assert.ok(reply, `a request bearing an id must draw a reply: ${JSON.stringify(params)}`)
    assert.equal(reply.error, undefined, 'malformed input is a vent outcome, not a JSON-RPC error')
    assert.equal(reply.result.isError, false)
    assert.deepEqual(payloadOf(reply), { recorded: false, reason: 'invalid-input' })
  }
  assert.equal(deps.writes.length, 0, 'nothing malformed reaches the sink')
})

test('a sink failure is a calm outcome, not a silent success', () => {
  // appendVent's return value is the sink's only channel for "I dropped this".
  // Ignoring it reports recorded:true for a vent that was thrown away.
  const deps = stubDeps({ ok: false })
  const reply = call(makeState(), deps, { text: 'the sink is down' })
  assert.equal(reply.error, undefined)
  assert.equal(reply.result.isError, false)
  assert.deepEqual(payloadOf(reply), { recorded: false, reason: 'sink-unavailable' })
})

test('through the real stdio entry point, every request bearing an id draws a reply', () => {
  // The silent drop was only ever visible HERE: server.mjs threw, and index.mjs — not
  // server.mjs — is what swallowed it. A unit test on handle() cannot see that, so this
  // pins the one framing shape that shipped broken. n3 (#143) owns full framing coverage.
  const input = [
    { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-11-25' } },
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'vent' } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
  ].map((m) => JSON.stringify(m)).join('\n') + '\n'
  const entry = fileURLToPath(new URL('../packages/vent-server/index.mjs', import.meta.url))
  const proc = spawnSync(process.execPath, [entry], { input, encoding: 'utf8' })
  assert.equal(proc.status, 0, `server exited non-zero: ${proc.stderr}`)
  const ids = proc.stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).id)
  assert.deepEqual(ids, [0, 1, 2],
    'ids 0,1,2 each answered exactly once, in order; the notification drew nothing')
})

test('the shipped entry point never confirms a write it did not make', () => {
  // n1 is reachable in live sessions via .mcp.json but ships no sink, so the honest
  // answer to a well-formed vent is `sink-unavailable`, NOT `recorded:true`.
  // n2 (#142) lands the real sink and flips this expectation to recorded:true.
  const input = JSON.stringify(
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'vent', arguments: { text: 'real vent' } } }) + '\n'
  const entry = fileURLToPath(new URL('../packages/vent-server/index.mjs', import.meta.url))
  const proc = spawnSync(process.execPath, [entry], { input, encoding: 'utf8' })
  const reply = JSON.parse(proc.stdout.trim())
  assert.equal(reply.result.isError, false)
  assert.deepEqual(JSON.parse(reply.result.content[0].text),
    { recorded: false, reason: 'sink-unavailable' })
})

test('an unknown tool is a protocol error, not a vent outcome', () => {
  const reply = handle(
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'nope', arguments: {} } },
    makeState(), stubDeps())
  assert.equal(reply.error.code, -32602)
})

test('SUPPORTED_VERSIONS covers both eras, modern first', () => {
  assert.deepEqual(SUPPORTED_VERSIONS, ['2026-07-28', '2025-11-25'])
})

// ---- runner ----
let failed = 0
for (const [name, fn] of tests) {
  try { await fn(); console.log('PASS', name) }
  catch (e) { failed++; console.error('FAIL', name, '\n  ', e.message) }
}
console.log(failed ? `\n${failed}/${tests.length} FAILED` : `\nall ${tests.length} passed`)
process.exit(failed ? 1 : 0)
