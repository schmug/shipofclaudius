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
// All four outcomes are live as of n2 (#142) — recorded, rate-limited,
// sink-unavailable, invalid-input — and one test asserts the contract across
// the whole set at once, so a fifth outcome cannot be added quietly.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  handle, makeState, TOOL, SERVER_INFO, SUPPORTED_VERSIONS, RATE_WINDOW_MS, MAX_PER_SESSION,
} from '../packages/vent-server/server.mjs'
import { appendVent, DEFAULT_SINK } from '../packages/vent-server/sink.mjs'
import { captureContext, parseRepo } from '../packages/vent-server/context.mjs'

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

test('the shipped entry point records a real vent, and confirms only what it wrote', async () => {
  // n1 was reachable in live sessions via .mcp.json but shipped no sink, so the only
  // honest answer to a well-formed vent was `sink-unavailable`. n2 (#142) lands the
  // real sink and this expectation flips to recorded:true — proved through the spawned
  // entry point and a real file on disk, not through a stub, because index.mjs's
  // wiring is exactly the thing a unit test on handle() cannot see.
  //
  // VENT_SINK redirects the sink so the suite never appends to the operator's own
  // ~/.claude/vents.jsonl, and so CI — which has no ~/.claude at all — exercises the
  // same path everyone else does instead of being the one place this looks broken.
  const dir = await mkdtemp(join(tmpdir(), 'vent-e2e-'))
  const sink = join(dir, 'vents.jsonl')
  const input = JSON.stringify(
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'vent', arguments: { text: 'real vent' } } }) + '\n'
  const entry = fileURLToPath(new URL('../packages/vent-server/index.mjs', import.meta.url))
  // Assert the exit status BEFORE parsing: a crashed server otherwise surfaces as a
  // confusing JSON parse failure instead of as the crash it actually is (#155).
  const proc = spawnSync(process.execPath, [entry], {
    input,
    encoding: 'utf8',
    env: { ...process.env, VENT_SINK: sink, CLAUDE_PROJECT_DIR: dir, CLAUDE_CODE_SESSION_ID: 'sess-e2e' },
  })
  assert.equal(proc.status, 0, `server exited non-zero: ${proc.stderr}`)
  const reply = JSON.parse(proc.stdout.trim())
  assert.equal(reply.error, undefined)
  assert.equal(reply.result.isError, false)
  assert.deepEqual(JSON.parse(reply.result.content[0].text), { recorded: true })

  const lines = (await readFile(sink, 'utf8')).trim().split('\n')
  assert.equal(lines.length, 1, 'one vent is one line')
  const record = JSON.parse(lines[0])
  assert.equal(record.text, 'real vent')
  assert.equal(record.cwd, dir, 'cwd comes from CLAUDE_PROJECT_DIR, not process.cwd()')
  assert.equal(record.session, 'sess-e2e')
  assert.ok(!Number.isNaN(Date.parse(record.ts)), `ts must be a real timestamp: ${record.ts}`)
  for (const field of ['cwd', 'repo', 'branch', 'session']) {
    assert.ok(field in record, `every context field is present: ${field}`)
    assert.ok(record[field] === null || typeof record[field] === 'string',
      `${field} is string|null, never undefined`)
  }
})

test('an unknown tool is a protocol error, not a vent outcome', () => {
  const reply = handle(
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'nope', arguments: {} } },
    makeState(), stubDeps())
  assert.equal(reply.error.code, -32602)
})

test('a multi-byte character split across two stdin writes survives the framer (#154)', async () => {
  // The framer decoded each chunk independently, so a UTF-8 sequence straddling a chunk
  // boundary became U+FFFD. The corruption is SILENT: 0x0A never appears inside a
  // multi-byte sequence, so lines still split correctly and JSON.parse still succeeds —
  // only the characters are wrong, and nothing downstream can tell.
  //
  // The id is the probe because JSON-RPC echoes it verbatim and n1 ships no sink, so
  // vent text has no return path here. Same decode step either way.
  const marker = 'héllo — 日本語 🎉 naïve café'
  const bytes = Buffer.from(
    JSON.stringify({ jsonrpc: '2.0', id: marker, method: 'tools/list' }) + '\n', 'utf8')
  // Cut ON a UTF-8 continuation byte (0b10xxxxxx), guaranteeing a character straddles
  // the two writes — precisely the condition the old decode mangled.
  const cut = bytes.findIndex((b, i) => i > 0 && (b & 0xc0) === 0x80)
  assert.ok(cut > 0, 'the payload must contain a multi-byte character to split')

  const entry = fileURLToPath(new URL('../packages/vent-server/index.mjs', import.meta.url))
  const proc = spawn(process.execPath, [entry], {
    env: { ...process.env, VENT_SINK: '/dev/null' },
  })
  let out = ''
  proc.stdout.setEncoding('utf8')
  proc.stdout.on('data', (c) => { out += c })
  proc.stdin.write(bytes.subarray(0, cut))
  // Two SEPARATE data events is the whole point; without a gap Node coalesces the writes
  // and the boundary never lands mid-character.
  await new Promise((r) => setTimeout(r, 60))
  proc.stdin.write(bytes.subarray(cut))
  proc.stdin.end()
  await new Promise((r) => proc.on('close', r))

  assert.equal(JSON.parse(out.trim()).id, marker,
    'id must round-trip byte-identical; U+FFFD here means chunks were decoded independently')
})

test('an EPIPE on stdout is a quiet exit, not an uncaught exception (#155)', () => {
  // This server is spawned into EVERY session where the plugin is installed, so a client
  // that disconnects mid-write must not become a crashed child process with a stack
  // trace. A vent is a side channel — it must never be the noisy thing in a session.
  // `head -c 1` reads one byte then exits, closing the read end deterministically; the
  // server's own status is echoed to stderr because the pipeline's status is head's.
  const input = Array.from({ length: 400 }, (_, i) =>
    JSON.stringify({ jsonrpc: '2.0', id: i, method: 'tools/list' })).join('\n') + '\n'
  const entry = fileURLToPath(new URL('../packages/vent-server/index.mjs', import.meta.url))
  const proc = spawnSync('sh',
    ['-c', '{ "$0" "$1"; echo "SERVER_EXIT:$?" >&2; } | head -c 1', process.execPath, entry],
    { input, encoding: 'utf8', env: { ...process.env, VENT_SINK: '/dev/null' } })
  assert.doesNotMatch(proc.stderr, /Unhandled 'error' event/,
    'EPIPE reached the default handler and crashed the process')
  assert.match(proc.stderr, /SERVER_EXIT:0/,
    `server must exit 0 on a closed pipe. stderr was:\n${proc.stderr}`)
})

test('SUPPORTED_VERSIONS covers both eras, modern first', () => {
  assert.deepEqual(SUPPORTED_VERSIONS, ['2026-07-28', '2025-11-25'])
})

// ---- the sink ----

test('appendVent writes one parseable JSON line per record', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vent-sink-'))
  const p = join(dir, 'vents.jsonl')
  assert.equal(appendVent({ ts: 'T1', text: 'a' }, p), true)
  assert.equal(appendVent({ ts: 'T2', text: 'b' }, p), true)
  const lines = (await readFile(p, 'utf8')).trim().split('\n')
  assert.equal(lines.length, 2)
  assert.deepEqual(JSON.parse(lines[0]), { ts: 'T1', text: 'a' })
  assert.deepEqual(JSON.parse(lines[1]), { ts: 'T2', text: 'b' })
})

test('appendVent returns false rather than throwing when the sink is unwritable', () => {
  // A vent is a side channel. If the sink is gone, the session must not notice.
  assert.equal(appendVent({ text: 'x' }, '/nonexistent-dir-xyz/vents.jsonl'), false)
})

test('DEFAULT_SINK is ~/.claude/vents.jsonl', () => {
  assert.ok(DEFAULT_SINK.endsWith('/.claude/vents.jsonl'), DEFAULT_SINK)
})

test('a vent text carrying newlines cannot forge a second JSONL record', async () => {
  // SECURITY. `text` is the one field an agent controls, and the sink is read back
  // line-by-line by the weekly triage. A raw newline reaching the file would let one
  // vent plant a whole second record that triage reads as independently reported.
  // JSON.stringify escapes it, so one record is always exactly one line.
  const dir = await mkdtemp(join(tmpdir(), 'vent-forge-'))
  const p = join(dir, 'vents.jsonl')
  const forged = 'legit\n' + JSON.stringify({ ts: 'T0', text: 'planted through the vent text' })
  assert.equal(appendVent({ ts: 'T1', text: forged }, p), true)
  const lines = (await readFile(p, 'utf8')).trim().split('\n')
  assert.equal(lines.length, 1, 'a newline in the text must not become a line break in the sink')
  assert.equal(JSON.parse(lines[0]).text, forged, 'and the text survives intact, escaped')
})

// ---- context capture ----

test('captureContext prefers CLAUDE_PROJECT_DIR and CLAUDE_CODE_SESSION_ID', () => {
  // Both verified present in a spawned server's env on 2026-08-28. The env var is
  // preferred over process.cwd() because it is unambiguous rather than usually-right.
  const env = { CLAUDE_PROJECT_DIR: '/proj', CLAUDE_CODE_SESSION_ID: 'sess-1' }
  const git = (cwd, args) =>
    args[0] === 'config' ? 'git@github.com:schmug/dmarcheck.git' : 'feat/x'
  assert.deepEqual(captureContext(env, git), {
    cwd: '/proj', repo: 'schmug/dmarcheck', branch: 'feat/x', session: 'sess-1',
  })
})

test('captureContext yields nulls, never undefined, when env is empty', () => {
  const r = captureContext({}, () => null)
  assert.deepEqual(r, { cwd: null, repo: null, branch: null, session: null })
})

test('a failing git degrades to null instead of propagating', () => {
  const env = { CLAUDE_PROJECT_DIR: '/proj', CLAUDE_CODE_SESSION_ID: 's' }
  const boom = () => { throw new Error('git not found') }
  assert.deepEqual(captureContext(env, boom),
    { cwd: '/proj', repo: null, branch: null, session: 's' })
})

test('parseRepo handles ssh, https, and .git-less remotes', () => {
  assert.equal(parseRepo('git@github.com:schmug/agent-notes.git'), 'schmug/agent-notes')
  assert.equal(parseRepo('https://github.com/schmug/agent-notes.git'), 'schmug/agent-notes')
  assert.equal(parseRepo('https://github.com/schmug/agent-notes'), 'schmug/agent-notes')
  assert.equal(parseRepo(null), null)
})

// ---- rate limiting and the calm-failure contract ----

test('a second vent inside the window is refused and writes nothing', () => {
  const state = makeState(); const deps = stubDeps()
  assert.deepEqual(payloadOf(call(state, deps, { text: 'one' })), { recorded: true })
  deps._now += RATE_WINDOW_MS - 1
  assert.deepEqual(payloadOf(call(state, deps, { text: 'two' })),
    { recorded: false, reason: 'rate-limited' })
  assert.equal(deps.writes.length, 1, 'the refused vent must not reach the sink')
})

test('a vent after the window is accepted again', () => {
  const state = makeState(); const deps = stubDeps()
  call(state, deps, { text: 'one' })
  deps._now += RATE_WINDOW_MS + 1
  assert.deepEqual(payloadOf(call(state, deps, { text: 'two' })), { recorded: true })
  assert.equal(deps.writes.length, 2)
})

test('the per-session cap holds and refusals do not count against it', () => {
  const state = makeState(); const deps = stubDeps()
  for (let i = 0; i < MAX_PER_SESSION; i++) {
    deps._now += RATE_WINDOW_MS + 1
    assert.deepEqual(payloadOf(call(state, deps, { text: `v${i}` })), { recorded: true })
  }
  deps._now += RATE_WINDOW_MS + 1
  assert.deepEqual(payloadOf(call(state, deps, { text: 'over' })),
    { recorded: false, reason: 'rate-limited' })
  assert.equal(deps.writes.length, MAX_PER_SESSION)
})

test('a failed sink write reports sink-unavailable and does not consume quota', () => {
  const state = makeState(); const deps = stubDeps({ ok: false })
  assert.deepEqual(payloadOf(call(state, deps, { text: 'x' })),
    { recorded: false, reason: 'sink-unavailable' })
  deps._now += RATE_WINDOW_MS + 1
  assert.equal(state.count, 0, 'a vent that was never written must not count')
})

test('missing or blank text is invalid-input, not a crash', () => {
  const deps = stubDeps()
  assert.deepEqual(payloadOf(call(makeState(), deps, {})),
    { recorded: false, reason: 'invalid-input' })
  assert.deepEqual(payloadOf(call(makeState(), deps, { text: '   ' })),
    { recorded: false, reason: 'invalid-input' })
  assert.deepEqual(payloadOf(call(makeState(), deps, { text: 42 })),
    { recorded: false, reason: 'invalid-input' })
  assert.equal(deps.writes.length, 0)
})

test('EVERY outcome an agent can cause sets isError:false', () => {
  // The core invariant. isError:true is reserved for errors a model should
  // self-correct from; a dropped vent is information, not a fault to retry.
  const state = makeState()
  const good = call(state, stubDeps(), { text: 'ok' })
  const bad = call(makeState(), stubDeps({ ok: false }), { text: 'x' })
  const invalid = call(makeState(), stubDeps(), {})
  const limited = call(state, stubDeps(), { text: 'again' })
  for (const r of [good, bad, invalid, limited]) {
    assert.equal(r.result.isError, false)
    assert.equal(r.error, undefined, 'never a JSON-RPC error for an agent-caused outcome')
  }
  // ...and these are genuinely all four outcomes, not one outcome asserted four times.
  assert.deepEqual([good, bad, invalid, limited].map(payloadOf), [
    { recorded: true },
    { recorded: false, reason: 'sink-unavailable' },
    { recorded: false, reason: 'invalid-input' },
    { recorded: false, reason: 'rate-limited' },
  ])
})

test('agent-supplied fields other than text never reach the sink record', () => {
  // SECURITY. `text` is the entire input surface (design spec §4.3). A vent able to set
  // `ts`, `session` or `repo` could plant a record blaming another session or another
  // repo, and the weekly triage cannot tell a forged field from a captured one. The
  // record is built field by field from the clock and deps.context(), never spread
  // from `args`, so extra arguments are inert rather than merely schema-discouraged.
  const deps = stubDeps()
  call(makeState(), deps, { text: 'real', ts: 'FORGED', session: 'someone-else', repo: 'evil/x' })
  assert.equal(deps.writes.length, 1)
  assert.deepEqual(deps.writes[0], {
    ts: new Date(1_000_000).toISOString(),
    text: 'real',
    cwd: '/p', repo: 'schmug/x', branch: 'main', session: 's1',
  })
})

// ---- runner ----
let failed = 0
for (const [name, fn] of tests) {
  try { await fn(); console.log('PASS', name) }
  catch (e) { failed++; console.error('FAIL', name, '\n  ', e.message) }
}
console.log(failed ? `\n${failed}/${tests.length} FAILED` : `\nall ${tests.length} passed`)
process.exit(failed ? 1 : 0)
