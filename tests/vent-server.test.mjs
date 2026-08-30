// Contract test for packages/vent-server — the agent vent tool.
// Node built-ins only; zero token cost. Unit tests drive the pure dispatcher
// directly; the integration tests spawn the real server, because index.mjs's
// stdio framing is exactly what a unit test on handle() cannot see.
//   node tests/vent-server.test.mjs
//
// The invariant this suite exists to protect: a vent must NEVER error into a
// session. Every outcome an agent can cause returns isError:false with a calm
// {recorded:false, reason} payload. A vent that fails loudly trains agents to
// stop calling it, which is the failure mode the question board already had.
// All four outcomes are live as of n2 (#142) — recorded, rate-limited,
// sink-unavailable, invalid-input — and one test asserts the contract across
// the whole set at once, so a fifth outcome cannot be added quietly.
//
// Two eras are served (n3, #143). The legacy one is observed fact; the modern
// 2026-07-28 one is written to the published spec and has never met a client —
// see the honesty note above its section, and do not upgrade that claim.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  handle, makeState, TOOL, SERVER_INFO, SUPPORTED_VERSIONS, MODERN_VERSIONS, LEGACY_VERSIONS,
  RATE_WINDOW_MS, MAX_PER_SESSION,
} from '../packages/vent-server/server.mjs'
import { appendVent, DEFAULT_SINK } from '../packages/vent-server/sink.mjs'
import { captureContext, parseRepo } from '../packages/vent-server/context.mjs'

const tests = []
const test = (name, fn) => tests.push([name, fn])

// The shipped stdio entry point, spawned for real by every integration test below.
const ENTRY = fileURLToPath(new URL('../packages/vent-server/index.mjs', import.meta.url))
// Every spawn in this file must stay OFF the operator's real ~/.claude/vents.jsonl.
// The framing tests never call the tool, so this points VENT_SINK at a path inside a
// directory that does not exist: should one ever reach the sink, the write fails into
// a calm sink-unavailable instead of appending to somebody's real file.
const NEVER_SINK = join(tmpdir(), 'vent-framing-never-written', 'vents.jsonl')

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
  // pins the one framing shape that shipped broken. The rest of the framing — chunk
  // boundaries, blank lines, junk, batched messages — is under "framing" below.
  const input = [
    { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-11-25' } },
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'vent' } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
  ].map((m) => JSON.stringify(m)).join('\n') + '\n'
  const proc = spawnSync(process.execPath, [ENTRY], {
    input, encoding: 'utf8', env: { ...process.env, VENT_SINK: NEVER_SINK },
  })
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
  // Assert the exit status BEFORE parsing: a crashed server otherwise surfaces as a
  // confusing JSON parse failure instead of as the crash it actually is (#155).
  const proc = spawnSync(process.execPath, [ENTRY], {
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

test('MODERN_VERSIONS and LEGACY_VERSIONS partition SUPPORTED_VERSIONS exactly', () => {
  // The drift this exists to catch (#157): add a version to SUPPORTED_VERSIONS and forget
  // MODERN_VERSIONS, and it is silently served the LEGACY shape AND silently allowed
  // through the `initialize` door. Pin the exact partition so either omission fails here.
  for (const v of MODERN_VERSIONS) {
    assert.ok(SUPPORTED_VERSIONS.includes(v), `MODERN_VERSIONS lists ${v}, absent from SUPPORTED_VERSIONS`)
  }
  assert.deepEqual(MODERN_VERSIONS, ['2026-07-28'])
  assert.deepEqual(LEGACY_VERSIONS, ['2025-11-25'])
  assert.deepEqual(
    [...MODERN_VERSIONS, ...LEGACY_VERSIONS].sort(), [...SUPPORTED_VERSIONS].sort(),
    'every supported version must be classified into exactly one era',
  )
})

test('the legacy `initialize` handshake NEVER negotiates a modern version (#157)', () => {
  // Decision #157, implementing design spec §4.1 verbatim: "an `initialize` request selects
  // legacy semantics for that stdio process." `initialize` IS the legacy handshake — the
  // modern revision removed it outright — so a client arriving through that door is by
  // definition a legacy-era client and must be answered with a legacy version, even when it
  // asks for a modern one. Negotiating a client DOWN is ordinary, legal legacy behaviour.
  //
  // What this pins: the server used to echo 2026-07-28 straight back and then serve legacy
  // shapes for the rest of the session — it agreed to an era it never went on to speak.
  const state = makeState()
  const init = handle(
    { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2026-07-28' } },
    state, stubDeps())
  assert.equal(init.result.protocolVersion, '2025-11-25')
  assert.ok(!MODERN_VERSIONS.includes(init.result.protocolVersion),
    'the legacy handshake must never hand back a version whose shapes it will not serve')

  // ...and what follows must match what was negotiated.
  const list = handle({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
    state, stubDeps())
  assert.deepEqual(Object.keys(list.result), ['tools'])
  assert.equal(list.result.resultType, undefined)
})

test('_meta WITHOUT a protocolVersion key is legacy by assertion, not by accident', () => {
  // The shape a real legacy client actually produces: _meta carrying only a progressToken.
  // The version key is ABSENT, and absence means "no era declared" => legacy. A declared-
  // but-empty version ('' or null) is a different case entirely and is refused -32022.
  const reply = handle(
    { jsonrpc: '2.0', id: 0, method: 'tools/list',
      params: { _meta: { 'io.modelcontextprotocol/progressToken': 'abc' } } },
    makeState(), stubDeps())
  assert.deepEqual(Object.keys(reply.result), ['tools'])
  assert.equal(reply.result.resultType, undefined)
})

// ---- the modern (2026-07-28) era ----
//
// WRITTEN TO SPEC, NOT TO OBSERVATION (design spec §4.1.1). No modern client exists to
// test against, so every assertion below proves only that our replies match the
// published shapes — never that any client accepted one. Do not upgrade that claim in a
// commit message, a PR body, or a doc.
//
// Claude Code 2.1.241 is a LEGACY client — verified 2026-08-28: it opens with
// `initialize` carrying protocolVersion 2025-11-25. So legacy carries every real call
// today and modern is insurance. When that inverts, delete the legacy branch rather
// than maintaining both forever.
const MV = 'io.modelcontextprotocol/protocolVersion'
const modernMeta = (v = '2026-07-28') => ({ _meta: { [MV]: v } })

test('a LEGACY version declared in _meta is served the LEGACY shape', () => {
  // The era must be selected off the MODERN version, not off mere presence of _meta.
  // server/discover advertises BOTH versions, so a _meta-bearing client can negotiate
  // DOWN to 2025-11-25 through the server's own published list — and that revision does
  // not define resultType or structuredContent.
  const deps = stubDeps()
  const list = handle(
    { jsonrpc: '2.0', id: 1, method: 'tools/list', params: modernMeta('2025-11-25') },
    makeState(), deps)
  assert.equal(list.result.resultType, undefined, 'legacy _meta must not get resultType')
  const called = call(makeState(), deps, { text: 'x' }, modernMeta('2025-11-25'))
  assert.equal(called.result.resultType, undefined)
  assert.equal(called.result.structuredContent, undefined)
  assert.equal(called.result.isError, false)
})

test('a declared-but-empty version is rejected, not guessed at', () => {
  // The design spec is normative: a version the server does not support MUST be rejected.
  // Truthiness-gating served '' and null the legacy shape instead of telling the client
  // which versions we speak — the exact failure -32022 exists to prevent.
  for (const v of ['', null]) {
    const r = handle(
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: modernMeta(v) },
      makeState(), stubDeps())
    assert.equal(r.error?.code, -32022, `version ${JSON.stringify(v)} must be rejected`)
    assert.deepEqual(r.error.data.supported, SUPPORTED_VERSIONS)
    assert.equal(r.error.data.requested, v)
  }
})

test('NO method answers a notification, including ones added later', () => {
  // server/discover was added ABOVE the trailing isNotification guard, so it answered a
  // notification with an id-less response that index.mjs would write to stdout — a
  // protocol violation. The guard now sits in FRONT of dispatch so every method inherits
  // it, including any added after this.
  for (const method of ['server/discover', 'initialize', 'tools/list', 'tools/call',
                        'notifications/initialized', 'no/such/method']) {
    const reply = handle(
      { jsonrpc: '2.0', method, params: { name: 'vent', arguments: { text: 'x' } } },
      makeState(), stubDeps())
    assert.equal(reply, null, `${method} as a notification must draw no reply`)
  }
})

test('every spawn in this suite is pinned to a temp VENT_SINK', async () => {
  // The file-level invariant, ENFORCED rather than asserted in a comment. A spawn with no
  // explicit env inherits the operator environment, and appendVent then falls back to
  // DEFAULT_SINK (~/.claude/vents.jsonl). One such spawn shipped: it was harmless only
  // because its request omitted `arguments` and short-circuited to invalid-input, so
  // adding a text to that one request would have appended to the real sink for real.
  const lines = (await readFile(fileURLToPath(import.meta.url), 'utf8')).split('\n')
  const missing = []
  lines.forEach((line, i) => {
    if (!line.includes('spawnSync(process.execPath') && !line.includes('spawn(process.execPath')) return
    if (!lines.slice(i, i + 6).join(' ').includes('VENT_SINK')) missing.push(i + 1)
  })
  assert.deepEqual(missing, [], 'these spawn lines carry no VENT_SINK env')
})

test('server/discover returns supported versions, capabilities, and serverInfo', () => {
  const reply = handle(
    { jsonrpc: '2.0', id: 'd1', method: 'server/discover', params: modernMeta() },
    makeState(), stubDeps())
  assert.equal(reply.result.resultType, 'complete')
  assert.deepEqual(reply.result.supportedVersions, SUPPORTED_VERSIONS)
  assert.deepEqual(reply.result.capabilities, { tools: {} })
  assert.deepEqual(reply.result._meta['io.modelcontextprotocol/serverInfo'], SERVER_INFO)
})

test('an unsupported requested version is rejected with -32022 and a supported list', () => {
  const reply = handle(
    { jsonrpc: '2.0', id: 3, method: 'tools/list', params: modernMeta('1900-01-01') },
    makeState(), stubDeps())
  assert.equal(reply.error.code, -32022)
  assert.deepEqual(reply.error.data.supported, SUPPORTED_VERSIONS)
  assert.equal(reply.error.data.requested, '1900-01-01')
})

test('modern results carry resultType complete', () => {
  const reply = handle(
    { jsonrpc: '2.0', id: 4, method: 'tools/list', params: modernMeta() }, makeState(), stubDeps())
  assert.equal(reply.result.resultType, 'complete')
  assert.deepEqual(reply.result.tools, [TOOL])
})

test('modern tools/call mirrors the payload into structuredContent', () => {
  const reply = call(makeState(), stubDeps(), { text: 'modern' }, modernMeta())
  assert.equal(reply.result.resultType, 'complete')
  assert.deepEqual(reply.result.structuredContent, { recorded: true })
  assert.deepEqual(payloadOf(reply), { recorded: true },
    'the text mirror stays, for backwards compatibility')
  assert.equal(reply.result.isError, false)
})

test('EVERY modern outcome mirrors its payload into structuredContent', () => {
  // `result(payload, modern)` has four call sites inside callVent. A missed one hands a
  // modern client a refusal it cannot read structurally — and refusals are the majority
  // of a rate-limited tool's replies — so assert across the whole set, not the happy
  // path alone. The calm contract is unchanged by the era: still isError:false.
  const state = makeState()
  const good = call(state, stubDeps(), { text: 'ok' }, modernMeta())
  const limited = call(state, stubDeps(), { text: 'again' }, modernMeta())
  const bad = call(makeState(), stubDeps({ ok: false }), { text: 'x' }, modernMeta())
  const invalid = call(makeState(), stubDeps(), {}, modernMeta())
  for (const r of [good, limited, bad, invalid]) {
    assert.equal(r.result.resultType, 'complete')
    assert.equal(r.result.isError, false, 'a modern refusal is still not an error')
    assert.equal(r.error, undefined)
    assert.deepEqual(r.result.structuredContent, payloadOf(r),
      'the structured mirror and the text block must never disagree')
  }
  assert.deepEqual([good, limited, bad, invalid].map((r) => r.result.structuredContent), [
    { recorded: true },
    { recorded: false, reason: 'rate-limited' },
    { recorded: false, reason: 'sink-unavailable' },
    { recorded: false, reason: 'invalid-input' },
  ])
})

test('an unsupported version is refused BEFORE the tool runs', () => {
  // The version gate sits in front of method dispatch, so a rejected call costs nothing
  // and — more importantly — a version the server does not speak can never write a
  // record whose shape it does not understand.
  const deps = stubDeps()
  const reply = call(makeState(), deps, { text: 'should never land' }, modernMeta('1900-01-01'))
  assert.equal(reply.error.code, -32022)
  assert.equal(deps.writes.length, 0, 'nothing reaches the sink behind a rejected version')
})

test('a version rejection never replies to a notification', () => {
  // A notification carries no id, so there is nothing to answer — not even to reject.
  // The gate runs in front of every method, which is exactly where a stray reply to a
  // notification (a protocol violation) would be introduced.
  const reply = handle(
    { jsonrpc: '2.0', method: 'notifications/initialized', params: modernMeta('1900-01-01') },
    makeState(), stubDeps())
  assert.equal(reply, null)
})

test('legacy results carry NO modern-only fields', () => {
  // Claude Code is the legacy client, so this is the path that actually ships today. A
  // modern-only field leaking onto it is a wire-contract violation on the one era we
  // can observe — the era where a regression is a real outage, not a hypothetical one.
  const deps = stubDeps()
  const list = handle({ jsonrpc: '2.0', id: 5, method: 'tools/list' }, makeState(), deps)
  const init = handle(
    { jsonrpc: '2.0', id: 6, method: 'initialize', params: { protocolVersion: '2025-11-25' } },
    makeState(), deps)
  const called = call(makeState(), deps, { text: 'legacy' })
  for (const reply of [list, init, called]) {
    assert.equal(reply.result.resultType, undefined)
    assert.equal(reply.result.structuredContent, undefined)
  }
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

test('a freshly created sink is not world-readable', async () => {
  // The record carries cwd, repo, branch, session and free-form text that in practice
  // quotes paths, command output and error messages. Default creation mode is 0644 and
  // ~/.claude is 0755, so without an explicit mode this is readable by any local user.
  const dir = await mkdtemp(join(tmpdir(), 'vent-mode-'))
  const p = join(dir, 'vents.jsonl')
  try {
    assert.equal(appendVent({ text: 'x' }, p), true)
    assert.equal((await stat(p)).mode & 0o777, 0o600, 'sink is owner-only')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
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
  // Normalized, because the weekly triage groups records by this key: git stores the
  // clone URL exactly as typed (so a trailing slash is legal) and GitHub URLs are
  // case-insensitive, so both variants below name the SAME repo.
  assert.equal(parseRepo('https://github.com/schmug/agent-notes/'), 'schmug/agent-notes')
  assert.equal(parseRepo('https://github.com/Schmug/Agent-Notes.git'), 'schmug/agent-notes')
  assert.equal(parseRepo('git@github.com:Schmug/Agent-Notes.git/'), 'schmug/agent-notes')
  assert.equal(parseRepo(null), null)
})

test('parseRepo folds case on EVERY host — a knowing trade, not an oversight (#160)', () => {
  // Decision recorded in design spec §4.4: fold case unconditionally rather than per-host.
  // This key only groups a personal vent digest, and every real remote is GitHub, where
  // owner/name IS case-insensitive. The price is that a case-sensitive host's two distinct
  // repos collapse into one bucket. That price is accepted deliberately — asserted here so
  // the trade cannot be reverted, or re-litigated, without a test going red.
  assert.equal(parseRepo('git@self-hosted.example:Foo/bar.git'), 'foo/bar')
  assert.equal(parseRepo('git@self-hosted.example:foo/bar.git'), 'foo/bar')
  assert.equal(
    parseRepo('git@self-hosted.example:Foo/bar.git'),
    parseRepo('git@self-hosted.example:foo/bar.git'),
    'case-distinct repos on a case-sensitive host share one grouping key BY DESIGN',
  )
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

test('an unwritable sink does not remove the 1-per-window bound on invocations', () => {
  // The two limits bound DIFFERENT things: the 90s window bounds INVOCATIONS, the
  // per-session cap bounds RECORDS WRITTEN. Advancing `stamps` only on a successful
  // write let a broken sink (full disk, read-only home, bad VENT_SINK, CI with no
  // ~/.claude) remove the only bound on how often this runs — and every attempt still
  // pays for deps.context(), which spawns two git subprocesses.
  const state = makeState(); const deps = stubDeps({ ok: false })
  const tally = {}
  for (let i = 0; i < 43; i++) {
    const p = payloadOf(call(state, deps, { text: `burst ${i}` }))
    const k = p.recorded ? 'recorded' : p.reason
    tally[k] = (tally[k] || 0) + 1
  }
  assert.deepEqual(tally, { 'sink-unavailable': 1, 'rate-limited': 42 },
    'one attempt per window, then refused — a broken sink must not uncap invocations')
  assert.equal(deps.writes.length, 0)
  assert.equal(state.count, 0, 'and the per-session quota is still untouched by a failed write')
})

test('a dep that throws is still a calm outcome, never an error in the session', () => {
  // The invariant rests on callVent being TOTAL. index.mjs's -32603 backstop limits the
  // blast radius but is itself an error in front of the agent, so the calm contract has
  // to hold here, one level up, rather than relying on the backstop.
  const boom = {
    now: () => 1_000_000,
    context: () => { throw new Error('git exploded') },
    appendVent: () => { throw new Error('sink exploded') },
  }
  const reply = call(makeState(), boom, { text: 'x' })
  assert.equal(reply.error, undefined, 'never a JSON-RPC error')
  assert.equal(reply.result.isError, false)
  assert.equal(payloadOf(reply).recorded, false)
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

test('a context field can never shadow the clock or the agent text', () => {
  // The spread-order fix in da3afd3 shipped with NOTHING that could fail on revert: every
  // context stub returns exactly {cwd, repo, branch, session}, so `{ts, text, ...ctx}` and
  // `{...ctx, ts, text}` are deepEqual (node:assert/strict ignores key insertion order) and
  // the ordering was unobservable — while THREAT_MODEL.md §3 claimed it was tested.
  // This is the case that makes the claim true: a context that actually COLLIDES, which
  // only the spread-first ordering survives. server.mjs's own comment states the intent —
  // the guarantee should be structural, not dependent on context.mjs happening to return
  // exactly four non-colliding keys — so the test must not depend on that shape either.
  const deps = stubDeps()
  deps.context = () => ({ ts: 'FORGED-TS', text: 'FORGED-TEXT', cwd: '/p' })
  call(makeState(), deps, { text: 'the real vent' })
  assert.equal(deps.writes.length, 1)
  assert.equal(deps.writes[0].ts, new Date(1_000_000).toISOString(),
    'the clock wins over a context field named ts')
  assert.equal(deps.writes[0].text, 'the real vent',
    "the agent's text wins over a context field named text")
  assert.equal(deps.writes[0].cwd, '/p', 'other context fields still land')
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

// ---- framing: the real stdio entry point ----
//
// index.mjs owns one job — newline-delimited JSON in, newline-delimited JSON out — and
// every defect it has shipped so far lived there rather than in handle(). These tests
// spawn the real server, because the buffer, the chunk boundaries and the "skip, never
// die" rules simply do not exist at the handle() level.

// Feeds the spawned server one chunk at a time, waiting for the replies each chunk was
// supposed to draw before writing the next. Waiting on OUTPUT rather than on a timer is
// what makes a chunk boundary real: two back-to-back writes coalesce into a single
// 'data' event, and a coalesced write would prove nothing about the buffer. Each step's
// `replies` is the CUMULATIVE count expected once that chunk has been processed.
function feedChunks(steps, { timeoutMs = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ENTRY], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, VENT_SINK: NEVER_SINK },
    })
    let out = ''
    let err = ''
    let settled = false
    let pending = null
    // A hung server would otherwise hang the whole suite with no output at all.
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGKILL')
      reject(new Error(`server did not answer within ${timeoutMs}ms; stdout so far: ${JSON.stringify(out)}`))
    }, timeoutMs)
    // Count only COMPLETED lines: a half-written reply is not a reply.
    const complete = () => out.split('\n').length - 1
    child.stdout.on('data', (d) => {
      out += d.toString()
      if (pending && complete() >= pending.want) {
        const go = pending.go
        pending = null
        go()
      }
    })
    child.stderr.on('data', (d) => { err += d.toString() })
    child.on('error', (e) => { if (!settled) { settled = true; clearTimeout(timer); reject(e) } })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, out, err })
    })
    const step = (i) => {
      if (i >= steps.length) { child.stdin.end(); return }
      const { chunk, replies = 0 } = steps[i]
      child.stdin.write(chunk)
      if (replies === 0 || complete() >= replies) { step(i + 1); return }
      pending = { want: replies, go: () => step(i + 1) }
    }
    step(0)
  })
}

const idsOf = (stdout) => stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).id)

test('FRAMING: a message split across chunk boundaries is buffered, not dropped', async () => {
  // The chunk boundary falls mid-key, inside a JSON string. stdin delivers whatever the
  // pipe happened to hand over, so a reader that parsed per-chunk instead of per-line
  // would drop request 2 entirely — the silent-drop failure mode again, one layer down.
  // Waiting for reply 1 before sending the tail is what guarantees the halves arrive in
  // two separate 'data' events rather than being coalesced into one.
  const { code, out, err } = await feedChunks([
    { chunk: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n{"jsonrpc":"2.0","id":2,"met', replies: 1 },
    { chunk: 'hod":"tools/list"}\n', replies: 2 },
  ])
  assert.equal(code, 0, `server exited non-zero: ${err}`)
  assert.deepEqual(idsOf(out), [1, 2], 'the half-line survived the data-event boundary')
})

test('FRAMING: one chunk carrying blank lines, junk and several messages answers each request in order', () => {
  // Everything a client can legally (or illegally) put in a single write, at once:
  // blank and whitespace-only lines, an unparseable line, a notification, and three
  // requests. The rule is skip-and-continue — never die, never reorder, never merge.
  const input = [
    '',                                                          // a bare newline
    '   ',                                                       // whitespace only
    '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
    'not json at all',                                           // unparseable: skipped
    '{"jsonrpc":"2.0","method":"notifications/initialized"}',    // no id: no reply
    '{"jsonrpc":"2.0","id":2,"method":"tools/list"}',
    '{"jsonrpc":"2.0","id":3,"method":"nope/nope"}',             // unknown method: still a reply
  ].join('\n') + '\n'
  const proc = spawnSync(process.execPath, [ENTRY], {
    input, encoding: 'utf8', env: { ...process.env, VENT_SINK: NEVER_SINK },
  })
  assert.equal(proc.status, 0, `server exited non-zero: ${proc.stderr}`)
  const replies = proc.stdout.trim().split('\n').map((l) => JSON.parse(l))
  assert.deepEqual(replies.map((r) => r.id), [1, 2, 3],
    'three requests, three replies, in order — the junk and the notification drew none')
  assert.equal(replies[2].error.code, -32601, 'an unknown method is a protocol error, and is answered')
})

test('FRAMING: an unparseable first line does not kill the server', () => {
  // Garbage arriving before anything valid is the case that decides whether the process
  // survives to serve the session at all. A throw here would take the server down and
  // every later vent with it.
  const proc = spawnSync(process.execPath, [ENTRY], {
    input: 'not json at all\n{"jsonrpc":"2.0","id":7,"method":"tools/list"}\n',
    encoding: 'utf8',
    env: { ...process.env, VENT_SINK: NEVER_SINK },
  })
  assert.equal(proc.status, 0, `server exited non-zero: ${proc.stderr}`)
  assert.deepEqual(idsOf(proc.stdout), [7])
})

test('FRAMING: stdin ending mid-message drops the partial rather than parsing a truncation', () => {
  // Framing is newline-delimited, so an unterminated trailing message is by definition
  // incomplete — and the client that sent it has just closed the pipe, so no one is
  // left blocked on a reply. What must NOT happen is a parse of the truncation or a
  // hang: the server answers what it has and exits cleanly.
  const proc = spawnSync(process.execPath, [ENTRY], {
    input: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n{"jsonrpc":"2.0","id":2,"method":"tools/li',
    encoding: 'utf8',
    env: { ...process.env, VENT_SINK: NEVER_SINK },
  })
  assert.equal(proc.status, 0, `server exited non-zero: ${proc.stderr}`)
  assert.deepEqual(idsOf(proc.stdout), [1])
})

test('FRAMING: the modern era survives the real stdio path, and a rejected version writes nothing', async () => {
  // Still spec-shaped, not client-verified (see the modern section's header): this shows
  // the modern branch is reachable through the framing, not that a client speaks it.
  const dir = await mkdtemp(join(tmpdir(), 'vent-modern-'))
  const sink = join(dir, 'vents.jsonl')
  const input = [
    { jsonrpc: '2.0', id: 1, method: 'server/discover', params: modernMeta() },
    {
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'vent', arguments: { text: 'modern e2e' }, ...modernMeta('1900-01-01') },
    },
  ].map((m) => JSON.stringify(m)).join('\n') + '\n'
  const proc = spawnSync(process.execPath, [ENTRY], {
    input, encoding: 'utf8',
    env: { ...process.env, VENT_SINK: sink, CLAUDE_PROJECT_DIR: dir },
  })
  assert.equal(proc.status, 0, `server exited non-zero: ${proc.stderr}`)
  const [discover, rejected] = proc.stdout.trim().split('\n').map((l) => JSON.parse(l))
  assert.equal(discover.result.resultType, 'complete')
  assert.deepEqual(discover.result.supportedVersions, SUPPORTED_VERSIONS)
  assert.equal(rejected.error.code, -32022)
  await assert.rejects(() => readFile(sink, 'utf8'), /ENOENT/,
    'a call behind a rejected version must never reach the sink')
  await rm(dir, { recursive: true, force: true })
})

// ---- runner ----
let failed = 0
for (const [name, fn] of tests) {
  try { await fn(); console.log('PASS', name) }
  catch (e) { failed++; console.error('FAIL', name, '\n  ', e.message) }
}
console.log(failed ? `\n${failed}/${tests.length} FAILED` : `\nall ${tests.length} passed`)
process.exit(failed ? 1 : 0)
