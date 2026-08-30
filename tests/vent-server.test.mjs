// Contract test for packages/vent-server — the agent vent tool.
// Node built-ins only; zero token cost. Unit tests drive the pure dispatcher
// directly; the integration tests spawn the real server, because the wiring in
// index.mjs is exactly what a unit test on handle() cannot see.
//   node tests/vent-server.test.mjs
//
// The invariant this suite exists to protect: a vent must NEVER error into a
// session. Every outcome an agent can cause returns isError:false with a calm
// {recorded:false, reason} payload. A vent that fails loudly trains agents to
// stop calling it, which is the failure mode the question board already had.
// All four outcomes are live as of n2 (#142) — recorded, rate-limited,
// sink-unavailable, invalid-input — and one test asserts the contract across
// the whole set at once. A fifth cannot be added quietly because `a fifth vent
// outcome cannot be added quietly` reads the refusal reasons back out of
// server.mjs and fails on any this suite does not exercise (#158 item 2).
//
// Two eras are served (n3, #143). The legacy one is observed fact; the modern
// 2026-07-28 one is written to the published spec and has never met a client —
// see the honesty note above its section, and do not upgrade that claim.
import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { writeSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  handle, makeState, TOOL, SERVER_INFO, SUPPORTED_VERSIONS, MODERN_VERSIONS, LEGACY_VERSIONS,
  RATE_WINDOW_MS, MAX_PER_SESSION,
} from '../packages/vent-server/server.mjs'
import { makeFramer } from '../packages/vent-server/framing.mjs'
import { appendVent, defaultSink, DEFAULT_SINK } from '../packages/vent-server/sink.mjs'
import { captureContext, parseRepo, NULL_CONTEXT } from '../packages/vent-server/context.mjs'

const tests = []
const test = (name, fn) => tests.push([name, fn])

// The shipped stdio entry point. `launchServer` below is the only thing that names it.
const ENTRY = fileURLToPath(new URL('../packages/vent-server/index.mjs', import.meta.url))

// ---- suite discipline: sanctioned regions ----
//
// Two properties this file has to hold, both made STRUCTURAL rather than asserted in a
// comment or approximated by a proximity scan:
//   1. No spawned server can reach the operator's real ~/.claude/vents.jsonl (#156).
//   2. No test leaves a temp directory behind (#158 item 14).
// Each is held by making ONE function the only sanctioned way to do the thing, and the
// SUITE DISCIPLINE tests at the bottom of this file reject any call site that skips it.
// What this replaces: a two-substring proximity scan over a 6-line window, which a
// comment, the detector line itself, or a VENT_SINK aimed at the real sink all satisfied
// without the property holding.
//
// Every sanctioned function below takes PLAIN parameters on purpose: the audit finds a
// region by brace-matching from the first `{` after its name, and a destructured
// parameter would claim that brace instead of the body.

const tmpDirs = []
// Every mkdtemp in this file goes through here, so the runner can remove them all — and
// so every temp path the suite produces is inside SAFE_ROOT, which is what makes the
// containment check in launchServer a single test.
let SAFE_ROOT = null
async function tmpDir(prefix) {
  const d = await mkdtemp(join(SAFE_ROOT || tmpdir(), prefix))
  tmpDirs.push(d)
  return d
}
// One unpredictable root per run. mkdtemp gives 0700 and a name nobody can guess, which
// is what makes NEVER_SINK's "the parent directory does not exist" property un-flippable:
// the old fixed path under tmpdir() could be pre-created by any local user, after which
// the framing tests would have started writing real files (#156).
SAFE_ROOT = await tmpDir('vent-suite-')
// A sink whose PARENT is absent by construction, for the spawns that never call the tool:
// should one ever reach the sink, the write fails into a calm sink-unavailable.
const NEVER_SINK = join(SAFE_ROOT, 'never-written', 'vents.jsonl')
// Stamped into every vent text this suite sends to a spawned server, so the sentinel test
// at the bottom can prove none of them landed in the operator's real sink. A fresh uuid
// per run means a pre-existing file cannot contain it, and a concurrent session's own
// legitimate vent cannot be mistaken for one of ours.
const RUN_MARKER = `vent-suite-${randomUUID()}`
const ventText = (s) => `${s} [${RUN_MARKER}]`

const within = (root, p) => resolve(p) === resolve(root) || resolve(p).startsWith(resolve(root) + sep)

// THE only way this suite starts the server. It decides the child's sink itself — applied
// AFTER the caller's env, so a caller cannot override it — and refuses any sink outside
// SAFE_ROOT, which is what makes "a VENT_SINK pointed at the real sink" fail rather than
// pass. `sink: null` selects the production path (VENT_SINK unset, so the child derives
// DEFAULT_SINK from HOME) and therefore REQUIRES a redirected HOME inside SAFE_ROOT —
// that is the same guarantee held one layer further out (#158 item 6).
function launchServer(mode, opts) {
  const o = opts || {}
  const env = { ...process.env, ...(o.env || {}) }
  delete env.VENT_SINK
  if (o.sink === null) {
    assert.ok(o.home && within(SAFE_ROOT, o.home),
      `sink:null needs a HOME inside the per-run temp root, got ${o.home}`)
    env.HOME = o.home
    env.USERPROFILE = o.home
  } else {
    const sink = o.sink || NEVER_SINK
    assert.ok(within(SAFE_ROOT, sink),
      `VENT_SINK must stay inside the per-run temp root, got ${sink}`)
    env.VENT_SINK = sink
  }
  if (mode === 'async') {
    return spawn(process.execPath, [ENTRY], { stdio: ['pipe', 'pipe', 'pipe'], env })
  }
  if (mode === 'shell') {
    return spawnSync('sh', ['-c', o.shell, process.execPath, ENTRY],
      { input: o.input, encoding: 'utf8', env })
  }
  return spawnSync(process.execPath, [ENTRY], { input: o.input, encoding: 'utf8', env })
}
const runServer = (opts) => launchServer('sync', opts)
const startServer = () => launchServer('async', {})

// Sanctioned separately from launchServer because it can never start the server: the
// executable is the literal 'git' and the cwd is always a per-run temp dir. Config is
// isolated so the operator's own gitconfig (signing, templates, hooks) cannot reach it.
function runGit(cwd, args) {
  execFileSync('git', args, {
    cwd,
    stdio: 'ignore',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  })
}

// A throwaway repo with a known remote and branch, so the SHIPPED realGit can be driven
// for real instead of always being replaced by a stub (#158 item 4).
async function probeRepo() {
  const dir = await tmpDir('vent-git-')
  runGit(dir, ['init', '-q'])
  runGit(dir, ['remote', 'add', 'origin', 'git@github.com:schmug/vent-probe.git'])
  runGit(dir, ['-c', 'user.email=probe@example.invalid', '-c', 'user.name=probe',
    '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-q', '-m', 'probe'])
  runGit(dir, ['branch', '-M', 'probe-branch'])
  return dir
}

// A deps stub with a controllable clock, an in-memory sink, and a call tally. The tally is
// how "a refusal is cheap" and "a rejected version never reaches the tool" become
// assertions instead of prose: both are claims about deps that were NOT called.
function stubDeps({ now = 1_000_000, writes = [], ok = true } = {}) {
  const d = {
    now: () => { d.calls.now++; return d._now },
    appendVent: (r) => { d.calls.appendVent++; if (!ok) return false; writes.push(r); return true },
    context: () => {
      d.calls.context++
      return { cwd: '/p', repo: 'schmug/x', branch: 'main', session: 's1' }
    },
    calls: { now: 0, appendVent: 0, context: 0 },
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
  const proc = runServer({ input })
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
  // CLAUDE_PROJECT_DIR points at a REAL git repo with a known remote and branch, so the
  // context assertions below are facts about what the shipped realGit produced rather
  // than "every field is present and may well be null" (#158 item 4).
  const dir = await probeRepo()
  const sink = join(dir, 'vents.jsonl')
  const text = ventText('real vent')
  const input = JSON.stringify(
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'vent', arguments: { text } } }) + '\n'
  // Assert the exit status BEFORE parsing: a crashed server otherwise surfaces as a
  // confusing JSON parse failure instead of as the crash it actually is (#155).
  const proc = runServer({
    input, sink, env: { CLAUDE_PROJECT_DIR: dir, CLAUDE_CODE_SESSION_ID: 'sess-e2e' },
  })
  assert.equal(proc.status, 0, `server exited non-zero: ${proc.stderr}`)
  const reply = JSON.parse(proc.stdout.trim())
  assert.equal(reply.error, undefined)
  assert.equal(reply.result.isError, false)
  assert.deepEqual(JSON.parse(reply.result.content[0].text), { recorded: true })

  const lines = (await readFile(sink, 'utf8')).trim().split('\n')
  assert.equal(lines.length, 1, 'one vent is one line')
  const record = JSON.parse(lines[0])
  assert.equal(record.text, text)
  assert.equal(record.cwd, dir, 'cwd comes from CLAUDE_PROJECT_DIR, not process.cwd()')
  assert.equal(record.session, 'sess-e2e')
  assert.equal(record.repo, 'schmug/vent-probe', 'the remote was read by the real git, not a stub')
  assert.equal(record.branch, 'probe-branch')
  assert.ok(!Number.isNaN(Date.parse(record.ts)), `ts must be a real timestamp: ${record.ts}`)
  assert.ok(Math.abs(Date.parse(record.ts) - Date.now()) < 60_000,
    `ts comes from the real clock, not a placeholder: ${record.ts}`)
  assert.deepEqual(Object.keys(record).sort(), ['branch', 'cwd', 'repo', 'session', 'text', 'ts'],
    'exactly the assembled fields — no more, no fewer')
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

  const proc = startServer()
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
  const proc = launchServer('shell', {
    input, shell: '{ "$0" "$1"; echo "SERVER_EXIT:$?" >&2; } | head -c 1',
  })
  assert.doesNotMatch(proc.stderr, /Unhandled 'error' event/,
    'EPIPE reached the default handler and crashed the process')
  assert.match(proc.stderr, /SERVER_EXIT:0/,
    `server must exit 0 on a closed pipe. stderr was:\n${proc.stderr}`)
})

test('every SUPPORTED_VERSION is genuinely served, and its era decides the shape (#158 item 8)', () => {
  // What this replaces: a bare deepEqual of the constant against its own literal, which
  // restated the list without proving a single version in it is served, or served the
  // shape its era implies. Advertising a version through server/discover and then
  // rejecting it is precisely the drift worth catching.
  for (const v of SUPPORTED_VERSIONS) {
    const deps = stubDeps()
    const list = handle(
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: modernMeta(v) }, makeState(), deps)
    assert.equal(list.error, undefined, `${v} is advertised by server/discover but rejected`)
    assert.deepEqual(list.result.tools, [TOOL])
    const modern = MODERN_VERSIONS.includes(v)
    assert.equal(list.result.resultType, modern ? 'complete' : undefined)
    const called = call(makeState(), deps, { text: 'x' }, modernMeta(v))
    assert.equal(called.result.isError, false)
    assert.deepEqual(called.result.structuredContent, modern ? { recorded: true } : undefined)
  }
  // The ORDER is a wire fact — server/discover advertises this list verbatim, most
  // preferred first — but derive the pin from the two era lists rather than restating a
  // literal, so it stays true as versions come and go.
  assert.deepEqual(SUPPORTED_VERSIONS, [...MODERN_VERSIONS, ...LEGACY_VERSIONS])
})

test('initialize answers EVERY requested version with a legacy one (#158 item 8)', () => {
  // The third negotiation path, and the only one a real client walks today. Covered
  // paths were "modern _meta" and "absent _meta"; what initialize does with each
  // possible protocolVersion — supported-modern, supported-legacy, unknown, absent —
  // was asserted for one value at a time and never as the whole space.
  for (const requested of [...SUPPORTED_VERSIONS, '1900-01-01', undefined]) {
    const params = requested === undefined ? {} : { protocolVersion: requested }
    const r = handle({ jsonrpc: '2.0', id: 0, method: 'initialize', params }, makeState(), stubDeps())
    assert.equal(r.error, undefined, 'initialize is the legacy door and never rejects')
    assert.ok(LEGACY_VERSIONS.includes(r.result.protocolVersion),
      `initialize answered ${JSON.stringify(requested)} with ${r.result.protocolVersion}, which is not a legacy version`)
    if (LEGACY_VERSIONS.includes(requested)) {
      assert.equal(r.result.protocolVersion, requested, 'a legacy request is echoed, not overridden')
    }
  }
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

test('NO method answers a notification, including ones added later (#158 items 9, 11)', async () => {
  // server/discover was added ABOVE the trailing isNotification guard, so it answered a
  // notification with an id-less response that index.mjs would write to stdout — a
  // protocol violation. The guard now sits in FRONT of dispatch so every method inherits
  // it, including any added after this.
  //
  // "including ones added later" used to be enforced by a HARDCODED list — which is
  // exactly the thing a method added later is absent from. Derive the list from the
  // dispatcher instead, so a new `method === '...'` branch is covered the moment it is
  // written rather than the moment somebody remembers to edit this array.
  const src = await readFile(new URL('../packages/vent-server/server.mjs', import.meta.url), 'utf8')
  const dispatched = [...new Set([...src.matchAll(/method === '([^']+)'/g)].map((m) => m[1]))]
  assert.ok(dispatched.length >= 4,
    `the dispatcher's methods could not be read from server.mjs: ${JSON.stringify(dispatched)}`)
  for (const known of ['server/discover', 'initialize', 'tools/list', 'tools/call']) {
    assert.ok(dispatched.includes(known), `${known} vanished from the dispatcher — or the scan broke`)
  }
  // Plus the notifications a real client actually sends. notifications/cancelled and
  // notifications/progress reach the same guard as notifications/initialized, and until
  // now only the last of the three was ever fed to it.
  for (const method of [...dispatched, 'notifications/initialized', 'notifications/cancelled',
                        'notifications/progress', 'no/such/method']) {
    const reply = handle(
      { jsonrpc: '2.0', method, params: { name: 'vent', arguments: { text: 'x' } } },
      makeState(), stubDeps())
    assert.equal(reply, null, `${method} as a notification must draw no reply`)
  }
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
  const state = makeState()
  const reply = call(state, deps, { text: 'should never land' }, modernMeta('1900-01-01'))
  assert.equal(reply.error.code, -32022)
  assert.equal(deps.writes.length, 0, 'nothing reaches the sink behind a rejected version')
  // Asserting only "nothing was written" passes just as happily when the gate DOES run
  // the tool and the write merely fails. What "BEFORE the tool runs" means is that
  // callVent was never entered at all: no clock read, no context capture (two git
  // subprocesses), no sink call — and no rate-limit window spent on a request the
  // server refused, which is the part an unsupported-version flood would exploit.
  assert.deepEqual(deps.calls, { now: 0, context: 0, appendVent: 0 },
    'a rejected version reached callVent')
  assert.deepEqual(state, makeState(), 'a rejected version must not consume the 90s window')
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
  const dir = await tmpDir('vent-sink-')
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

test('a freshly created sink is not world-readable, under a PERMISSIVE umask (#158 item 7)', async () => {
  // The record carries cwd, repo, branch, session and free-form text that in practice
  // quotes paths, command output and error messages. Default creation mode is 0644 and
  // ~/.claude is 0755, so without an explicit mode this is readable by any local user.
  //
  // The umask is the whole difficulty. Creation mode is masked by it, so under a
  // restrictive one (0077 is common) a file created with NO explicit mode is already
  // 0600 — the assertion below then passes whether or not appendVent asks for 0600, and
  // silently stops pinning the fix. Forcing umask 0 makes the mode argument the only
  // thing that can produce 0600, and the control file proves the umask really is
  // permissive so this cannot pass for the wrong reason either way.
  const dir = await tmpDir('vent-mode-')
  const p = join(dir, 'vents.jsonl')
  const control = join(dir, 'control.txt')
  const prev = process.umask(0o000)
  try {
    await writeFile(control, 'x')
    assert.equal((await stat(control)).mode & 0o777, 0o666,
      'umask is not permissive here, so the 0600 assertion below would be vacuous')
    assert.equal(appendVent({ text: 'x' }, p), true)
    assert.equal((await stat(p)).mode & 0o777, 0o600, 'sink is owner-only')
  } finally {
    process.umask(prev)
  }
})

test('DEFAULT_SINK is ~/.claude/vents.jsonl', () => {
  assert.ok(DEFAULT_SINK.endsWith('/.claude/vents.jsonl'), DEFAULT_SINK)
})

test('a short write cannot corrupt the NEXT record (#159)', async () => {
  // DURABILITY. The sink is read back line-by-line, so an unterminated fragment is worse
  // than a lost record: the next append concatenates onto it and BOTH records become one
  // unparseable line — while the caller only ever reported `sink-unavailable` for the
  // first. A write can end short without throwing (ENOSPC partway, a signal), so the
  // returned byte count is the only signal there is, and appendFileSync discards it.
  const dir = await tmpDir('vent-short-')
  const p = join(dir, 'vents.jsonl')
  {
    // The kernel accepting half the bytes, simulated at the one seam that can express it.
    // Only the FIRST write is short: the terminator that closes the damaged line has to
    // go through the same seam, so a stub that truncated everything would prove nothing.
    let n = 0
    const shortOnce = (fd, buf, off, len) => {
      n += 1
      return writeSync(fd, buf, off, n === 1 ? Math.floor(len / 2) : len)
    }
    assert.equal(appendVent({ ts: 'T1', text: 'a'.repeat(40) }, p, shortOnce), false,
      'a short write is a failure, not the silent success appendFileSync would report')
    assert.equal(appendVent({ ts: 'T2', text: 'b' }, p), true)

    const lines = (await readFile(p, 'utf8')).split('\n').filter((l) => l !== '')
    assert.equal(lines.length, 2, 'the fragment did not swallow the record that followed it')
    assert.throws(() => JSON.parse(lines[0]),
      'the truncated fragment stays unparseable ON ITS OWN — one line lost, not two')
    assert.deepEqual(JSON.parse(lines[1]), { ts: 'T2', text: 'b' },
      'and the next record parses independently, unaffected by the damage before it')
  }
})

test('a write that throws outright is still a calm false, never an exception', async () => {
  // The repair path must not become a new way to throw: if the disk is full, the
  // terminator write fails too, and appendVent's contract is `false` either way.
  const dir = await tmpDir('vent-throw-')
  const p = join(dir, 'vents.jsonl')
  {
    const boom = () => { throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' }) }
    assert.equal(appendVent({ ts: 'T1', text: 'x' }, p, boom), false)
    assert.equal((await readFile(p, 'utf8')), '', 'a failed write leaves no partial line behind')
  }
})

test('an empty homedir() yields NO sink, never a cwd-relative one (#159)', async () => {
  // os.homedir() can return '' — a container or CI runner with no HOME and no passwd
  // entry. join('', '.claude', 'vents.jsonl') is '.claude/vents.jsonl', a path relative
  // to whatever directory the host happened to spawn the server in. That is not a
  // theoretical miss: it RESOLVES inside any repo with a .claude/ directory, this one
  // included, so vents would land in the working tree instead of the operator's home.
  assert.equal(defaultSink(''), null, 'no home means no sink')
  assert.equal(defaultSink('relative/home'), null, 'a relative home is no home either')
  assert.notEqual(defaultSink(''), join('.claude', 'vents.jsonl'))
  assert.equal(defaultSink('/home/someone'), join('/home/someone', '.claude', 'vents.jsonl'))

  // ...and the null sink is a clean refusal, not a write into the process cwd.
  const dir = await tmpDir('vent-home-')
  await mkdir(join(dir, '.claude'))
  const cwd = process.cwd()
  try {
    process.chdir(dir)
    assert.equal(appendVent({ ts: 'T1', text: 'x' }, defaultSink('')), false)
    await assert.rejects(() => readFile(join(dir, '.claude', 'vents.jsonl'), 'utf8'), /ENOENT/,
      'nothing was written into the cwd .claude/ that a relative default would have found')
  } finally {
    process.chdir(cwd)
  }
})

test('a vent text carrying newlines cannot forge a second JSONL record', async () => {
  // SECURITY. `text` is the one field an agent controls, and the sink is read back
  // line-by-line by the weekly triage. A raw newline reaching the file would let one
  // vent plant a whole second record that triage reads as independently reported.
  // JSON.stringify escapes it, so one record is always exactly one line.
  const dir = await tmpDir('vent-forge-')
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

test('NULL_CONTEXT is exactly the shape captureContext returns, so the two cannot drift', () => {
  // NULL_CONTEXT is what the server falls back to when deps.context() throws, so it has
  // to stay the SAME four keys context.mjs actually produces. captureContext builds every
  // return from it, which is what makes that structural rather than a promise; this pins
  // it from the outside so a fifth field added to one and not the other goes red.
  const shape = Object.keys(NULL_CONTEXT).sort()
  assert.deepEqual(shape, ['branch', 'cwd', 'repo', 'session'], 'the §4.4 context shape')
  assert.deepEqual(Object.keys(captureContext({}, () => null)).sort(), shape)
  assert.deepEqual(
    Object.keys(captureContext({ CLAUDE_PROJECT_DIR: '/p', CLAUDE_CODE_SESSION_ID: 's' }, () => 'x')).sort(),
    shape)
  for (const [k, v] of Object.entries(NULL_CONTEXT)) assert.equal(v, null, `${k} defaults to null`)
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

test('a throwing context() records explicit nulls, not a record missing every field (#159)', () => {
  // The totality guard absorbed the throw into `ctx = {}`, which is right — but the
  // record that came out carried NO cwd/repo/branch/session key at all, breaking the
  // §4.4 contract that every context field is string-or-null and never undefined. The
  // weekly triage reads these line-by-line; a record silently missing the grouping key
  // is worse than one that says `null`, because only the second is legible as "unknown".
  const writes = []
  const deps = {
    now: () => 1_000_000,
    context: () => { throw new Error('git exploded') },
    appendVent: (r) => { writes.push(r); return true },
  }
  assert.deepEqual(payloadOf(call(makeState(), deps, { text: 'x' })), { recorded: true })
  assert.equal(writes.length, 1)
  assert.deepEqual(writes[0], {
    cwd: null, repo: null, branch: null, session: null,
    ts: new Date(1_000_000).toISOString(), text: 'x',
  })
})

test('a context() returning only SOME fields is completed to the four-key shape', () => {
  // Same contract, reached the other way: a context that returns without throwing but
  // omits a field would otherwise emit a record with that key simply absent. Normalizing
  // on the way in makes the record shape structural rather than dependent on every
  // caller of deps.context() being well-behaved.
  const deps = stubDeps()
  deps.context = () => ({ cwd: '/p' })
  call(makeState(), deps, { text: 'partial' })
  assert.deepEqual(deps.writes[0], {
    cwd: '/p', repo: null, branch: null, session: null,
    ts: new Date(1_000_000).toISOString(), text: 'partial',
  })
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
    const child = startServer()
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
    '{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":1}}',
    '{"jsonrpc":"2.0","id":2,"method":"tools/list"}',
    '{"jsonrpc":"2.0","id":3,"method":"nope/nope"}',             // unknown method: still a reply
  ].join('\n') + '\n'
  const proc = runServer({ input })
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
  const proc = runServer({ input: 'not json at all\n{"jsonrpc":"2.0","id":7,"method":"tools/list"}\n' })
  assert.equal(proc.status, 0, `server exited non-zero: ${proc.stderr}`)
  assert.deepEqual(idsOf(proc.stdout), [7])
})

test('FRAMING: stdin ending mid-message drops the partial rather than parsing a truncation', () => {
  // Framing is newline-delimited, so an unterminated trailing message is by definition
  // incomplete — and the client that sent it has just closed the pipe, so no one is
  // left blocked on a reply. What must NOT happen is a parse of the truncation or a
  // hang: the server answers what it has and exits cleanly.
  const proc = runServer({
    input: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n{"jsonrpc":"2.0","id":2,"method":"tools/li',
  })
  assert.equal(proc.status, 0, `server exited non-zero: ${proc.stderr}`)
  assert.deepEqual(idsOf(proc.stdout), [1])
})

test('FRAMING: the modern era survives the real stdio path, and a rejected version writes nothing', async () => {
  // Still spec-shaped, not client-verified (see the modern section's header): this shows
  // the modern branch is reachable through the framing, not that a client speaks it.
  const dir = await tmpDir('vent-modern-')
  const sink = join(dir, 'vents.jsonl')
  const text = ventText('modern e2e')
  const input = [
    { jsonrpc: '2.0', id: 1, method: 'server/discover', params: modernMeta() },
    {
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'vent', arguments: { text }, ...modernMeta() },
    },
    {
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'vent', arguments: { text: ventText('never') }, ...modernMeta('1900-01-01') },
    },
  ].map((m) => JSON.stringify(m)).join('\n') + '\n'
  const proc = runServer({ input, sink, env: { CLAUDE_PROJECT_DIR: dir } })
  assert.equal(proc.status, 0, `server exited non-zero: ${proc.stderr}`)
  const [discover, recorded, rejected] = proc.stdout.trim().split('\n').map((l) => JSON.parse(l))
  assert.equal(discover.result.resultType, 'complete')
  assert.deepEqual(discover.result.supportedVersions, SUPPORTED_VERSIONS)
  // The modern SUCCESS path had never crossed the real entry point: the only modern
  // tools/call down here was the version-rejected one below, so the modern result shape
  // was proved by unit tests on handle() and by nothing that framed a reply on stdout
  // (#158 item 13).
  assert.equal(recorded.result.resultType, 'complete')
  assert.deepEqual(recorded.result.structuredContent, { recorded: true })
  assert.equal(recorded.result.isError, false)
  assert.deepEqual(JSON.parse(recorded.result.content[0].text), { recorded: true })
  assert.equal(rejected.error.code, -32022)
  const lines = (await readFile(sink, 'utf8')).trim().split('\n')
  assert.equal(lines.length, 1, 'a call behind a rejected version must never reach the sink')
  assert.equal(JSON.parse(lines[0]).text, text)
})

// ---- suite discipline: the audit ----
//
// A PURE function over source text, so each of the five documented ways to satisfy the
// old proximity scan without the property holding can be fed to it as a fixture and shown
// to fail (#156). It works on source with comments, strings, template literals and regex
// literals blanked out, which kills three of the five at a stroke: a comment cannot
// satisfy it, the detector's own patterns cannot match themselves, and the fixtures below
// cannot flag the very file that holds them.
//
// The rule is a WHITELIST, not a proximity heuristic: every call that can start a child
// process must sit inside a region that is allowed to make it. Distance, call shape and
// argument spelling are all irrelevant, which is what closes the "line-local 6-line
// window" and "only two literal call shapes" holes together.
const SPAWN_FNS = ['spawnSync', 'spawn', 'execFileSync', 'execFile', 'execSync', 'exec', 'fork']
const MKDTEMP_FNS = ['mkdtempSync', 'mkdtemp']
const SANCTIONED = [
  { anchor: 'function launchServer', allows: SPAWN_FNS, requires: ['VENT_SINK'], forbids: ['DEFAULT_SINK'] },
  { anchor: 'function runGit', allows: ['execFileSync'], requires: [], forbids: [] },
  { anchor: 'function tmpDir', allows: MKDTEMP_FNS, requires: [], forbids: [] },
]

// Held as data rather than a character class so the class brackets cannot themselves
// confuse the stripper when it is run over this very file.
const REGEX_MAY_FOLLOW = ['(', ',', '=', ':', '[', '!', '&', '|', '?', ';', '+', '\n', '{', '}']
// Blanks comments and every literal, preserving length and newlines so offsets and line
// numbers survive. Length preservation is what lets the brace matcher below run on the
// stripped text and still describe the real file.
function stripNonCode(src) {
  const out = src.split('')
  const blank = (from, to) => {
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== '\n') out[k] = ' '
  }
  let i = 0
  // A `/` opens a regex literal, rather than a division, only where a value cannot
  // precede it. Tracking the last significant character is the standard heuristic and is
  // exact for the constructs this file uses.
  let prev = '\n'
  while (i < src.length) {
    const c = src[i]
    if (c === '/' && src[i + 1] === '/') {
      let j = src.indexOf('\n', i)
      if (j < 0) j = src.length
      blank(i, j); i = j; continue
    }
    if (c === '/' && src[i + 1] === '*') {
      let j = src.indexOf('*/', i + 2)
      j = j < 0 ? src.length : j + 2
      blank(i, j); i = j; continue
    }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1
      while (j < src.length) {
        if (src[j] === '\\') { j += 2; continue }
        if (src[j] === c) break
        j++
      }
      blank(i, j + 1); i = j + 1; prev = 'x'; continue
    }
    if (c === '/' && REGEX_MAY_FOLLOW.includes(prev)) {
      let j = i + 1
      let cls = false
      let end = -1
      while (j < src.length) {
        const d = src[j]
        if (d === '\\') { j += 2; continue }
        if (d === '\n') break
        if (d === '[') cls = true
        else if (d === ']') cls = false
        else if (d === '/' && !cls) { end = j; break }
        j++
      }
      if (end > 0) { blank(i, end + 1); i = end + 1; prev = 'x'; continue }
    }
    if (!/\s/.test(c)) prev = c
    i++
  }
  return out.join('')
}

// The body of the named function, as [start, end] offsets into the STRIPPED source.
// Anchored on the name and brace-matched from the first following `{` — which is why
// every sanctioned function takes plain, un-destructured parameters.
function bodyRange(code, anchor) {
  const at = code.indexOf(anchor)
  if (at < 0) return null
  const open = code.indexOf('{', at)
  if (open < 0) return null
  let depth = 0
  for (let i = open; i < code.length; i++) {
    if (code[i] === '{') depth++
    else if (code[i] === '}' && --depth === 0) return [at, i]
  }
  return null
}

function auditSuiteSource(src) {
  const code = stripNonCode(src)
  const lineOf = (idx) => code.slice(0, idx).split('\n').length
  const ranges = SANCTIONED.map((rule) => [rule, bodyRange(code, rule.anchor)])
  const bad = []
  for (const [rule, range] of ranges) {
    if (!range) continue
    const body = code.slice(range[0], range[1])
    for (const needle of rule.requires) {
      if (!body.includes(needle)) bad.push(`${rule.anchor} no longer sets ${needle}`)
    }
    for (const needle of rule.forbids) {
      if (body.includes(needle)) bad.push(`${rule.anchor} references ${needle}`)
    }
  }
  for (const name of [...SPAWN_FNS, ...MKDTEMP_FNS]) {
    const re = new RegExp(String.raw`\b${name}\s*\(`, 'g')
    for (const m of code.matchAll(re)) {
      const home = ranges.find(([rule, range]) =>
        range && m.index > range[0] && m.index < range[1] && rule.allows.includes(name))
      if (!home) bad.push(`line ${lineOf(m.index)}: ${name}( outside every sanctioned region`)
    }
  }
  return bad
}

// A minimal conforming source: a sanctioned region that owns its spawn and sets the sink.
const CONFORMING = [
  'function launchServer(mode, opts) {',
  '  const env = { ...process.env, VENT_SINK: opts.sink }',
  '  return spawnSync(process.execPath, [ENTRY], { env })',
  '}',
].join('\n')

// Each entry is a source the audit MUST reject: the five ways, documented in #156, of
// satisfying the old two-substring proximity scan while the property does not hold.
const BYPASSES = [
  ['1. the detector line matches itself', CONFORMING + '\n' + [
    'const scan = (l) => l.includes("spawnSync(process.execPath") && l.includes("VENT_SINK")',
    'const proc = spawnSync(process.execPath, [ENTRY], { input })',
  ].join('\n')],
  ['2. a comment inside the window satisfies it', CONFORMING + '\n' + [
    '// VENT_SINK is surely set somewhere around here',
    'const proc = spawnSync(process.execPath, [ENTRY], { input })',
  ].join('\n')],
  ['3. VENT_SINK pointed at the operator real sink', [
    'function launchServer(mode, opts) {',
    '  const env = { ...process.env, VENT_SINK: DEFAULT_SINK }',
    '  return spawnSync(process.execPath, [ENTRY], { env })',
    '}',
  ].join('\n')],
  ['4. the env sits outside the fixed 6-line window', CONFORMING + '\n' + [
    'const proc = spawnSync(process.execPath, [ENTRY], {',
    '  input,', '  encoding: "utf8",', '  //', '  //', '  //', '  //', '  //',
    '  env: { VENT_SINK: sink },',
    '})',
  ].join('\n')],
  ['5. a spawn form the scan never recognised', CONFORMING + '\n' + [
    'const proc = execFileSync(process.execPath, [ENTRY], { env: { VENT_SINK: sink } })',
  ].join('\n')],
  ['6. a sanctioned region that stopped setting the sink', [
    'function launchServer(mode, opts) {',
    '  return spawnSync(process.execPath, [ENTRY], { env: process.env })',
    '}',
  ].join('\n')],
]

test('SUITE DISCIPLINE: this file starts the server only through launchServer (#156)', async () => {
  const src = await readFile(fileURLToPath(import.meta.url), 'utf8')
  assert.deepEqual(auditSuiteSource(src), [],
    'a spawn or a mkdtemp in this file skips its sanctioned region')
})

test('SUITE DISCIPLINE: the audit rejects every documented bypass of the old scan (#156)', () => {
  // The negative control comes FIRST and is not optional: an audit that returned a
  // violation for everything would satisfy the loop below while enforcing nothing, which
  // is the same "passes for the wrong reason" defect the rest of this work is about.
  assert.deepEqual(auditSuiteSource(CONFORMING), [], 'a conforming source must be accepted')
  // ...and distance inside a sanctioned region is irrelevant, where the old scan gave up
  // after six lines.
  const farApart = [
    'function launchServer(mode, opts) {',
    '  const sink = opts.sink',
    ...Array.from({ length: 20 }, () => '  //'),
    '  const env = { ...process.env, VENT_SINK: sink }',
    '  return spawnSync(process.execPath, [ENTRY], { env })',
    '}',
  ].join('\n')
  assert.deepEqual(auditSuiteSource(farApart), [], 'a sanctioned region is not line-local')

  for (const [name, src] of BYPASSES) {
    assert.ok(auditSuiteSource(src).length > 0, `bypass was accepted: ${name}`)
  }
})

test('SUITE DISCIPLINE: launchServer refuses any sink outside the per-run temp root (#156)', () => {
  // The runtime half of bypass 3. A source scan can only ever see the SPELLING of a sink;
  // this rejects the VALUE, before any child is spawned, so no argument about what the
  // path is called can get a spawn past it.
  // DEFAULT_SINK is null on a host with no usable home (#159), where there is no real
  // sink to aim at; name the path it WOULD be so this stays a test either way.
  const realSink = DEFAULT_SINK || defaultSink('/home/operator')
  assert.throws(() => launchServer('sync', { sink: realSink }), /temp root/,
    'the operator real sink must be refused outright')
  assert.throws(() => launchServer('sync', { sink: join(tmpdir(), 'vents.jsonl') }), /temp root/,
    'a temp path outside THIS run is still not ours to write')
  assert.throws(() => launchServer('sync', { sink: null }), /HOME inside/,
    'the production sink path needs a redirected HOME, or it lands in ~/.claude')
  assert.throws(() => launchServer('sync', { sink: null, home: tmpdir() }), /HOME inside/)
})

// ---- the test-strength sweep (#158) ----
//
// Each test below replaces a claim that was made in a comment, a doc, or an assertion
// that could not fail. The bar every one of them had to clear: revert the behaviour it
// describes and watch it go red. Where a claim was already enforced elsewhere it is NOT
// restated here — a redundant test is not coverage either.

// Item 1: the -32603 backstop is unreachable from any stdin a test can write, because
// handle() is total today. The catch could be deleted with the suite staying green while
// THREAT_MODEL.md §1 listed it as a control. Driving the framer with an INJECTED dispatch
// is what makes it testable at all — which is why framing.mjs exists.

test('a throwing dispatch answers an id-bearing request with -32603 (#158 item 1)', () => {
  const out = []
  const feed = makeFramer({ dispatch: () => { throw new Error('boom') }, write: (l) => out.push(l) })
  feed(Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/list' }) + '\n'))
  assert.equal(out.length, 1, 'a request bearing an id must ALWAYS draw a reply')
  assert.deepEqual(JSON.parse(out[0]),
    { jsonrpc: '2.0', id: 4, error: { code: -32603, message: 'Internal error' } })
})

test('a throwing dispatch still answers NOTHING to a notification (#158 item 1)', () => {
  // The backstop must not overcorrect: a reply with no id is a protocol violation, and
  // index.mjs would write it straight to stdout.
  const out = []
  const feed = makeFramer({ dispatch: () => { throw new Error('boom') }, write: (l) => out.push(l) })
  feed(Buffer.from(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled' }) + '\n'))
  assert.deepEqual(out, [])
})

test('a fifth vent outcome cannot be added quietly (#158 item 2)', async () => {
  // Asserted in three places and enforced by nothing: the four-outcome tests pin the four
  // they already know, and a FIFTH refusal reason would not have made any of them fail.
  // Read the reasons out of the dispatcher instead, so the claim is about server.mjs
  // rather than about this file's memory of it.
  const src = await readFile(new URL('../packages/vent-server/server.mjs', import.meta.url), 'utf8')
  const reasons = [...new Set([...src.matchAll(/reason: '([a-z-]+)'/g)].map((m) => m[1]))].sort()
  assert.deepEqual(reasons, ['invalid-input', 'rate-limited', 'sink-unavailable'],
    'server.mjs produces a refusal reason this suite never exercises')
  const state = makeState()
  const seen = [
    call(state, stubDeps(), { text: 'ok' }),
    call(state, stubDeps(), { text: 'again' }),
    call(makeState(), stubDeps({ ok: false }), { text: 'x' }),
    call(makeState(), stubDeps(), {}),
  ].map(payloadOf)
  assert.equal(seen.filter((o) => o.recorded === true).length, 1, 'exactly one success outcome')
  assert.deepEqual([...new Set(seen.filter((o) => !o.recorded).map((o) => o.reason))].sort(), reasons,
    'every refusal reason server.mjs can produce is exercised right here')
})

test('a refusal never pays for deps.context() (#158 item 3)', () => {
  // "Refusals are cheap" is an availability control, not a nicety: deps.context() spawns
  // two git subprocesses, so a refusal that still called it would hand the 43-vent
  // apology spiral on record roughly 700ms of real work per REJECTED vent. Nothing
  // asserted the skip, so moving the context capture above the guards stayed green.
  const invalid = stubDeps()
  call(makeState(), invalid, { text: '   ' })
  assert.deepEqual(invalid.calls, { now: 0, context: 0, appendVent: 0 },
    'invalid-input is decided before the clock is even read')

  const state = makeState()
  const limited = stubDeps()
  call(state, limited, { text: 'first' })
  assert.equal(limited.calls.context, 1, 'the accepted vent does capture context')
  call(state, limited, { text: 'second' })
  assert.equal(limited.calls.context, 1, 'the rate-limited refusal captured none')
  assert.equal(limited.calls.appendVent, 1, 'and never reached the sink')
})

test('captureContext runs the REAL git against a real repo (#158 item 4)', async () => {
  // Every other context test replaces realGit with a stub, so the shipped git path was
  // never executed on a success path and the e2e context assertions could only say
  // "present, possibly null". This calls captureContext with NO gitFn argument.
  const dir = await probeRepo()
  assert.deepEqual(captureContext({ CLAUDE_PROJECT_DIR: dir, CLAUDE_CODE_SESSION_ID: 's' }), {
    cwd: dir, repo: 'schmug/vent-probe', branch: 'probe-branch', session: 's',
  })
})

test('session state is process-lifetime, proved in ONE spawned process (#158 item 5)', async () => {
  // MAX_PER_SESSION means what it says only because the host spawns one server per
  // session, so process-lifetime state IS session state. Every rate-limit test drove
  // handle() with a state object the test itself owned, which proves the limiter and
  // nothing about the wiring: a per-message state in index.mjs would have recorded both
  // of the vents below and stayed green.
  //
  // The 90s window is what makes the per-session CAP unreachable here without waiting it
  // out ten times over; the cap itself stays a unit test, and this pins the sharing.
  const dir = await tmpDir('vent-session-')
  const sink = join(dir, 'vents.jsonl')
  const input = [1, 2].map((i) => JSON.stringify({
    jsonrpc: '2.0', id: i, method: 'tools/call',
    params: { name: 'vent', arguments: { text: ventText(`vent ${i}`) } },
  })).join('\n') + '\n'
  const proc = runServer({ input, sink, env: { CLAUDE_PROJECT_DIR: dir } })
  assert.equal(proc.status, 0, `server exited non-zero: ${proc.stderr}`)
  const payloads = proc.stdout.trim().split('\n')
    .map((l) => JSON.parse(JSON.parse(l).result.content[0].text))
  assert.deepEqual(payloads, [{ recorded: true }, { recorded: false, reason: 'rate-limited' }],
    'the second vent saw the first one state; a fresh state per message would record both')
  const lines = (await readFile(sink, 'utf8')).trim().split('\n')
  assert.equal(lines.length, 1, 'and only the accepted vent reached the sink')
})

test('with VENT_SINK unset the server writes to DEFAULT_SINK under HOME (#158 item 6)', async () => {
  // The PRODUCTION sink path. Every other integration test sets VENT_SINK, so the
  // `process.env.VENT_SINK || undefined` fallback — the branch every real session takes —
  // had no coverage at all: appendVent's default parameter could have been dropped and
  // the suite would not have noticed.
  //
  // HOME is redirected into the per-run temp root instead, which is how this exercises
  // the real fallback without appending to the operator's own ~/.claude/vents.jsonl.
  const home = await tmpDir('vent-home-')
  await mkdir(join(home, '.claude'))
  const text = ventText('production sink path')
  const input = JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'vent', arguments: { text } },
  }) + '\n'
  const proc = runServer({ input, sink: null, home, env: { CLAUDE_PROJECT_DIR: home } })
  assert.equal(proc.status, 0, `server exited non-zero: ${proc.stderr}`)
  assert.deepEqual(JSON.parse(JSON.parse(proc.stdout.trim()).result.content[0].text), { recorded: true })
  const written = await readFile(join(home, '.claude', 'vents.jsonl'), 'utf8')
  assert.equal(JSON.parse(written.trim()).text, text,
    'the vent landed at homedir()/.claude/vents.jsonl, with no VENT_SINK in sight')
})

// Registered LAST on purpose: it is the whole-run verdict on the property the sanctioned
// launcher exists to hold. RUN_MARKER is minted fresh each run, so a pre-existing file
// cannot contain it and a concurrent session's own legitimate vent cannot be mistaken for
// one of ours — the check stays exact without being flaky.
test("SUITE DISCIPLINE: nothing this run wrote reached the operator's real sink (#156)", async () => {
  const marked = []
  const walk = async (dir) => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, e.name)
      if (e.isDirectory()) { if (e.name !== '.git') await walk(full); continue }
      if ((await readFile(full, 'utf8')).includes(RUN_MARKER)) marked.push(full)
    }
  }
  await walk(SAFE_ROOT)
  // Anti-vacuity: if no sink in this run carries the marker, the assertion below is
  // asserting nothing at all.
  assert.ok(marked.length >= 3,
    `expected several marked sinks under the per-run root, found ${marked.length}`)
  const real = DEFAULT_SINK ? await readFile(DEFAULT_SINK, 'utf8').catch(() => '') : ''
  assert.ok(!real.includes(RUN_MARKER),
    `this suite appended to the operator's real sink at ${DEFAULT_SINK}`)
})

// ---- runner ----
let failed = 0
for (const [name, fn] of tests) {
  try { await fn(); console.log('PASS', name) }
  catch (e) { failed++; console.error('FAIL', name, '\n  ', e.message) }
}
// #158 item 14: three tests used to leave their mkdtemp directories behind on every run.
// Removing SAFE_ROOT removes every temp path the suite made, because tmpDir puts them all
// inside it; the loop is belt-and-braces for the root itself.
for (const d of tmpDirs) await rm(d, { recursive: true, force: true })
console.log(failed ? `\n${failed}/${tests.length} FAILED` : `\nall ${tests.length} passed`)
process.exit(failed ? 1 : 0)
