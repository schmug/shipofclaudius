# Agent Vent Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give agents a one-call, zero-gate way to report friction with Cory's own agent tooling, so that friction becomes fixable instead of evaporating at the end of a session.

**Architecture:** A dual-era MCP stdio server bundled in this plugin via a root `.mcp.json` exposes one tool, `vent`, taking only `{text}`. The server auto-captures context and appends a JSON line to `~/.claude/vents.jsonl`. A weekly scheduled task clusters vents and files one issue per cluster. Protocol dispatch is a pure function (`server.mjs`) with all I/O injected, so nearly every case is unit-testable without spawning a process.

**Tech Stack:** Node 20/22, ES modules, **Node built-ins only**. JSON-RPC 2.0 over stdio, hand-rolled.

**Spec:** `docs/specs/2026-08-24-vent-tool-design.md` (commit `40d3308`). Read it before Task 1; this plan argues from it.

## Global Constraints

Every task's requirements implicitly include this section.

- **Zero npm dependencies. No lockfile. No install step in CI.** Production and test code may import only `node:*` builtins. Adding a dependency breaks the build by design.
- **`tests/vent-server.test.mjs` MUST be appended to the `&&`-chain in `package.json`'s `test` script**, or CI never runs it. `tests/plugin-integrity.test.mjs` enforces this.
- **Never pin a test total** into README, `CLAUDE.md`, or anywhere else. `plugin-integrity` fails the build if one appears. The suite count only ever goes UP.
- **MCP current revision is `2026-07-28`** (modern, stateless, `_meta`-bearing). **Claude Code 2.1.241 is a legacy client** speaking `2025-11-25` via the `initialize` handshake. The server serves both.
- **The modern path cannot be verified against a real client** — none exists yet. Its tests prove *our* responses match the written spec, nothing more. Never describe it as verified end-to-end.
- **All four `vent` outcomes return `isError: false`.** `isError: true` is reserved for errors a model should self-correct from; a dropped vent is not one.
- Tool name `vent`; input is `{text}` and nothing else. Rate limit 1 per 90s and 10 per session. Sink is `~/.claude/vents.jsonl`.
- Work on branch `feat/vent-tool` (already exists, carries the two spec commits). Commit test and implementation **together**. Conventional prefixes. End commits with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`. **Never** add a `Signed-off-by` or set Cory as author.
- **Anything under `~/.claude` is a guardrail edit and needs Cory's explicit approval before it is written.** That applies to Task 7 and to nothing else in this plan.
- Full gate is `npm test` from the repo root. Report counts, not "tests pass".

## File Structure

| File | Responsibility |
|---|---|
| `packages/vent-server/server.mjs` | Pure protocol dispatch. Exports constants, `makeState()`, `handle(msg, state, deps)`. No I/O — every side effect arrives through `deps`. |
| `packages/vent-server/context.mjs` | Reads env + git into a context record. Exports `captureContext(env, gitFn)`, `parseRepo(url)`. |
| `packages/vent-server/sink.mjs` | Append-only JSONL writer that never throws. Exports `DEFAULT_SINK`, `appendVent(record, path)`. |
| `packages/vent-server/index.mjs` | Thin entry point: stdin/stdout framing, wires real deps into `handle`. |
| `.mcp.json` | Plugin-root server registration. |
| `tests/vent-server.test.mjs` | The whole suite. Unit tests import the modules directly; two integration tests spawn `index.mjs` for real framing. |
| `package.json` | Test-chain registration only. |

`tests/` must stay a sibling of `packages/` — the suite imports across that boundary, same as `factory-gate`.

---

### Task 1: Walking skeleton — legacy contract, plugin wiring, and the end-to-end gate

Closes spec §10 open item 1. **Do this first.** If plugin-bundled stdio does not surface a tool, nothing else in this plan is worth building.

**Files:**
- Create: `packages/vent-server/server.mjs`
- Create: `packages/vent-server/index.mjs`
- Create: `.mcp.json`
- Create: `tests/vent-server.test.mjs`
- Modify: `package.json` (test chain)

**Interfaces:**
- Consumes: nothing.
- Produces: `SUPPORTED_VERSIONS: string[]`, `SERVER_INFO: {name,version}`, `TOOL: {name,description,inputSchema}`, `makeState(): {stamps:number[], count:number}`, `handle(msg: object, state: object, deps: object): object|null` — returns `null` when no reply must be sent (notifications), otherwise a complete JSON-RPC response object. `deps` is `{now(): number, appendVent(record): boolean, context(): object}`.

- [ ] **Step 1: Write the failing test**

Create `tests/vent-server.test.mjs`:

```javascript
// Contract test for packages/vent-server — the agent vent tool.
// Node built-ins only; zero token cost. Unit tests drive the pure dispatcher
// directly; two integration tests spawn the real server for stdio framing.
//   node tests/vent-server.test.mjs
//
// The invariant this suite exists to protect: a vent must NEVER error into a
// session. Every outcome an agent can cause returns isError:false with a calm
// {recorded:false, reason} payload. A vent that fails loudly trains agents to
// stop calling it, which is the failure mode the question board already had.
import assert from 'node:assert/strict'
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/vent-server.test.mjs`
Expected: FAIL — `Cannot find module '.../packages/vent-server/server.mjs'`

- [ ] **Step 3: Write minimal implementation**

Create `packages/vent-server/server.mjs`. The `description` is copied verbatim from spec §4.2 — it *is* the bar, and adding eligibility criteria to it reintroduces the failure mode this whole tool exists to avoid.

```javascript
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
  const record = { ts: new Date(deps.now()).toISOString(), text: args.text, ...deps.context() }
  deps.appendVent(record)
  return result({ recorded: true })
}
```

Create `packages/vent-server/index.mjs`:

```javascript
#!/usr/bin/env node
// Thin stdio entry point. Framing only — all decisions live in server.mjs.
import { handle, makeState } from './server.mjs'
import { StringDecoder } from 'node:string_decoder'

const state = makeState()
const deps = {
  now: () => Date.now(),
  appendVent: () => true,
  context: () => ({}),
}

// Stateful decode: a chunk boundary inside a multi-byte UTF-8 sequence would otherwise
// silently become U+FFFD. See #154 — this doc prescribed the defective form.
const decoder = new StringDecoder('utf8')
let buf = ''
process.stdin.on('data', (chunk) => {
  buf += decoder.write(chunk)
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim()
    buf = buf.slice(i + 1)
    if (!line) continue
    let msg
    try { msg = JSON.parse(line) } catch { continue }
    let reply = null
    try { reply = handle(msg, state, deps) } catch { reply = null }
    if (reply) process.stdout.write(JSON.stringify(reply) + '\n')
  }
})
process.stdin.resume()
```

Create `.mcp.json` at the repo root. `${CLAUDE_PLUGIN_ROOT}` templating is confirmed working in three shipped plugins:

```json
{
  "mcpServers": {
    "vent": {
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/packages/vent-server/index.mjs"]
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/vent-server.test.mjs`
Expected: PASS, `all 6 passed`

- [ ] **Step 5: Register the suite in the test chain**

Append ` && node tests/vent-server.test.mjs` to the end of the `test` script in `package.json`. A suite not in that chain never runs in CI.

Run: `npm test`
Expected: green, with the chain total exactly **one higher** than a run on the base commit.
Do not pin the number here or anywhere else — check it by running `npm test` on `origin/main`
and comparing. The repo's standing rule is that the count only ever goes UP and no total is
written down, because a suite cannot verify a number about itself. (The first draft of this
plan hardcoded "23" against a base that had since moved to 24 suites — exactly the drift the
rule exists to prevent.)

- [ ] **Step 6: THE GATE — verify plugin-bundled stdio end-to-end**

This is the one thing no offline test can prove, and the reason this task is first.

```bash
claude --plugin-dir /Users/cory/shipofclaudius -p "List your available tools whose name contains 'vent'. Do not call anything."
```

Expected: the response names an `mcp__vent__vent` tool.

If the tool does not appear, **stop and report**. Do not continue building. Diagnose in this order: (a) is `.mcp.json` at the plugin root rather than under `.claude-plugin/`; (b) does `${CLAUDE_PLUGIN_ROOT}` expand — hardcode the absolute path temporarily to isolate; (c) does `node packages/vent-server/index.mjs` respond to a hand-fed `initialize` line. Note that `claude -p` needs a live login; if it reports `OAuth session expired`, that is an auth problem and not a wiring failure — say so rather than concluding the wiring is broken.

- [ ] **Step 7: Commit**

```bash
git add packages/vent-server/server.mjs packages/vent-server/index.mjs .mcp.json tests/vent-server.test.mjs package.json
git commit -m "feat(vent): add vent tool skeleton with legacy MCP contract

Closes the spec's first open item: plugin-bundled stdio verified to
surface the tool in a real session.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: The sink — append-only JSONL that never throws

**Files:**
- Create: `packages/vent-server/sink.mjs`
- Modify: `tests/vent-server.test.mjs` (add cases before the runner block)

**Interfaces:**
- Consumes: nothing.
- Produces: `DEFAULT_SINK: string` (absolute path to `~/.claude/vents.jsonl`), `appendVent(record: object, path?: string): boolean` — returns `false` on any failure and **never throws**.

- [ ] **Step 1: Write the failing test**

Add to `tests/vent-server.test.mjs` — the import goes at the top with the others, the tests go immediately before the `// ---- runner ----` comment:

```javascript
import { appendVent, DEFAULT_SINK } from '../packages/vent-server/sink.mjs'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
```

```javascript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/vent-server.test.mjs`
Expected: FAIL — `Cannot find module '.../sink.mjs'`

- [ ] **Step 3: Write minimal implementation**

Create `packages/vent-server/sink.mjs`:

```javascript
// Append-only JSONL sink. A single small O_APPEND write, so concurrent sessions
// interleave whole lines rather than corrupting each other. Never read-modify-write.
import { appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const DEFAULT_SINK = join(homedir(), '.claude', 'vents.jsonl')

export function appendVent(record, path = DEFAULT_SINK) {
  try {
    appendFileSync(path, JSON.stringify(record) + '\n')
    return true
  } catch {
    return false
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/vent-server.test.mjs`
Expected: PASS, `all 9 passed`

- [ ] **Step 5: Commit**

```bash
git add packages/vent-server/sink.mjs tests/vent-server.test.mjs
git commit -m "feat(vent): add append-only JSONL sink that never throws

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Context capture — env first, git best-effort

**Files:**
- Create: `packages/vent-server/context.mjs`
- Modify: `tests/vent-server.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `captureContext(env?: object, gitFn?: function): {cwd, repo, branch, session}` — every field is `string|null`, never undefined. `parseRepo(url: string|null): string|null` returns `owner/name`. `gitFn(cwd, args) => string|null` is injected so tests need no real repo.

- [ ] **Step 1: Write the failing test**

Add the import and these cases:

```javascript
import { captureContext, parseRepo } from '../packages/vent-server/context.mjs'
```

```javascript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/vent-server.test.mjs`
Expected: FAIL — `Cannot find module '.../context.mjs'`

- [ ] **Step 3: Write minimal implementation**

Create `packages/vent-server/context.mjs`:

```javascript
// Context the agent never has to supply. Git is best-effort and time-bounded:
// a slow or absent git must degrade to null, never hang the tool call.
import { execFileSync } from 'node:child_process'

function realGit(cwd, args) {
  try {
    const out = execFileSync('git', args, {
      cwd, encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'],
    })
    return out.trim() || null
  } catch {
    return null
  }
}

export function parseRepo(url) {
  if (!url) return null
  const m = String(url).match(/[:/]([^/:]+)\/([^/]+?)(?:\.git)?$/)
  return m ? `${m[1]}/${m[2]}` : null
}

export function captureContext(env = process.env, gitFn = realGit) {
  const cwd = env.CLAUDE_PROJECT_DIR || null
  const session = env.CLAUDE_CODE_SESSION_ID || null
  if (!cwd) return { cwd: null, repo: null, branch: null, session }
  let repo = null
  let branch = null
  try {
    repo = parseRepo(gitFn(cwd, ['config', '--get', 'remote.origin.url']))
    branch = gitFn(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']) || null
  } catch {
    repo = null
    branch = null
  }
  return { cwd, repo, branch, session }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/vent-server.test.mjs`
Expected: PASS, `all 13 passed`

- [ ] **Step 5: Wire the real deps into the entry point**

In `packages/vent-server/index.mjs`, replace the stub `deps` object with:

```javascript
import { captureContext } from './context.mjs'
import { appendVent } from './sink.mjs'

const deps = {
  now: () => Date.now(),
  appendVent: (record) => appendVent(record),
  context: () => captureContext(),
}
```

- [ ] **Step 6: Commit**

```bash
git add packages/vent-server/context.mjs packages/vent-server/index.mjs tests/vent-server.test.mjs
git commit -m "feat(vent): capture session context from env with best-effort git

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Rate limiting and the calm-failure contract

Spec §4.5 and §4.6. Rate limiting is normatively required — the MCP spec's Security Considerations say servers **MUST** rate limit tool invocations — and Lovable shipped theirs only after an agent fired 43 vents from one project during an apology spiral.

**Files:**
- Modify: `packages/vent-server/server.mjs` (`callVent`)
- Modify: `tests/vent-server.test.mjs`

**Interfaces:**
- Consumes: `handle`, `makeState`, `RATE_WINDOW_MS`, `MAX_PER_SESSION` from Task 1.
- Produces: no new exports. `callVent` now returns one of four payloads: `{recorded:true}`, `{recorded:false,reason:'rate-limited'}`, `{recorded:false,reason:'sink-unavailable'}`, `{recorded:false,reason:'invalid-input'}` — all with `isError:false`.

- [ ] **Step 1: Write the failing test**

Add the import for the constants and these cases:

```javascript
import { RATE_WINDOW_MS, MAX_PER_SESSION } from '../packages/vent-server/server.mjs'
```

```javascript
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
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/vent-server.test.mjs`
Expected: FAIL — the rate-limit cases report `{recorded:true}` where `rate-limited` is expected.

- [ ] **Step 3: Write minimal implementation**

Replace `callVent` in `packages/vent-server/server.mjs`:

```javascript
function callVent(args, state, deps) {
  const text = args?.text
  if (typeof text !== 'string' || text.trim() === '') {
    return result({ recorded: false, reason: 'invalid-input' })
  }
  const now = deps.now()
  state.stamps = state.stamps.filter((t) => now - t < RATE_WINDOW_MS)
  if (state.stamps.length > 0 || state.count >= MAX_PER_SESSION) {
    return result({ recorded: false, reason: 'rate-limited' })
  }
  const record = { ts: new Date(now).toISOString(), text, ...deps.context() }
  if (!deps.appendVent(record)) {
    return result({ recorded: false, reason: 'sink-unavailable' })
  }
  state.stamps.push(now)
  state.count += 1
  return result({ recorded: true })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/vent-server.test.mjs`
Expected: PASS, `all 19 passed`

- [ ] **Step 5: Commit**

```bash
git add packages/vent-server/server.mjs tests/vent-server.test.mjs
git commit -m "feat(vent): rate limit to 1/90s and 10/session, never error into a session

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: The modern (2026-07-28) era

**Written to spec, not to observation.** No modern client exists to test against; these tests prove our responses match the published shapes and nothing more. Do not describe this path as verified end-to-end, in a commit message, a PR body, or the README.

**Files:**
- Modify: `packages/vent-server/server.mjs`
- Modify: `tests/vent-server.test.mjs`

**Interfaces:**
- Consumes: everything from Tasks 1 and 4.
- Produces: no new exports. `handle` gains `server/discover`, `_meta` version dispatch, and `-32022` rejection. Modern results additionally carry `resultType: 'complete'`, and `tools/call` results carry `structuredContent`.

- [ ] **Step 1: Write the failing test**

```javascript
const MV = 'io.modelcontextprotocol/protocolVersion'
const modernMeta = (v = '2026-07-28') => ({ _meta: { [MV]: v } })

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

test('legacy results carry NO modern-only fields', () => {
  const reply = handle({ jsonrpc: '2.0', id: 5, method: 'tools/list' }, makeState(), stubDeps())
  assert.equal(reply.result.resultType, undefined)
  assert.equal(reply.result.structuredContent, undefined)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/vent-server.test.mjs`
Expected: FAIL — `server/discover` returns a `-32601` Method not found.

- [ ] **Step 3: Write minimal implementation**

In `packages/vent-server/server.mjs`, replace `handle`, `result`, and the `callVent` signature so the era flows through:

```javascript
export function handle(msg, state, deps) {
  const { method, id, params } = msg
  const isNotification = id === undefined
  const requestedVersion = params?._meta?.[META_VERSION]

  // Modern: every request declares its version and is accepted or rejected alone.
  if (requestedVersion && !SUPPORTED_VERSIONS.includes(requestedVersion)) {
    if (isNotification) return null
    return err(id, -32022, 'Unsupported protocol version', {
      supported: SUPPORTED_VERSIONS, requested: requestedVersion,
    })
  }
  const modern = Boolean(requestedVersion)

  if (method === 'server/discover') {
    return ok(id, {
      resultType: 'complete',
      supportedVersions: SUPPORTED_VERSIONS,
      capabilities: { tools: {} },
      _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
    })
  }
  if (method === 'initialize') {
    const requested = params?.protocolVersion
    return ok(id, {
      protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25',
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    })
  }
  if (method === 'notifications/initialized') return null
  if (method === 'tools/list') {
    return ok(id, modern ? { resultType: 'complete', tools: [TOOL] } : { tools: [TOOL] })
  }
  if (method === 'tools/call') {
    if (params?.name !== TOOL.name) return err(id, -32602, `Unknown tool: ${params?.name}`)
    return ok(id, callVent(params?.arguments, state, deps, modern))
  }
  if (isNotification) return null
  return err(id, -32601, `Method not found: ${method}`)
}

function result(payload, modern) {
  const body = { content: [{ type: 'text', text: JSON.stringify(payload) }], isError: false }
  return modern ? { resultType: 'complete', structuredContent: payload, ...body } : body
}
```

Then thread `modern` through `callVent` — change its signature to `callVent(args, state, deps, modern)` and pass `modern` as the second argument to all four `result(...)` calls.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS, `all 24 passed` in the vent suite, and the whole chain green.

- [ ] **Step 5: Commit**

```bash
git add packages/vent-server/server.mjs tests/vent-server.test.mjs
git commit -m "feat(vent): serve the modern 2026-07-28 era alongside legacy

server/discover, per-request _meta version dispatch, -32022 rejection,
resultType and structuredContent on modern results.

Written to spec, NOT verified against a real modern client — none exists
yet. Claude Code 2.1.241 is a legacy client. Delete the legacy branch
when that stops being true rather than maintaining both forever.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: Integration — real stdio framing end to end

Every prior test drove `handle` directly. This one proves the framing in `index.mjs` actually works: newline-delimited, no reply to notifications, real file written.

**Files:**
- Modify: `tests/vent-server.test.mjs`

**Interfaces:**
- Consumes: `packages/vent-server/index.mjs`.
- Produces: nothing.

- [ ] **Step 1: Write the failing test**

```javascript
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
```

```javascript
test('INTEGRATION: a real spawned server handshakes, lists, and writes a vent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vent-e2e-'))
  const sink = join(dir, 'vents.jsonl')
  const entry = fileURLToPath(new URL('../packages/vent-server/index.mjs', import.meta.url))
  const lines = [
    '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-11-25"}}',
    '{"jsonrpc":"2.0","method":"notifications/initialized"}',
    '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
    '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"vent","arguments":{"text":"e2e"}}}',
  ].join('\n') + '\n'

  const stdout = execFileSync('node', [entry], {
    input: lines, encoding: 'utf8',
    env: { ...process.env, VENT_SINK: sink, CLAUDE_PROJECT_DIR: dir, CLAUDE_CODE_SESSION_ID: 'e2e-1' },
  })
  const replies = stdout.trim().split('\n').map((l) => JSON.parse(l))

  assert.equal(replies.length, 3, 'exactly 3 replies — the notification draws none')
  assert.deepEqual(replies.map((r) => r.id), [0, 1, 2])
  assert.equal(replies[1].result.tools[0].name, 'vent')
  assert.deepEqual(JSON.parse(replies[2].result.content[0].text), { recorded: true })

  const written = JSON.parse((await readFile(sink, 'utf8')).trim())
  assert.equal(written.text, 'e2e')
  assert.equal(written.session, 'e2e-1')
  assert.equal(written.cwd, dir)
  assert.ok(written.ts, 'a timestamp is always stamped')
})

test('INTEGRATION: a malformed line is skipped without killing the server', () => {
  const entry = fileURLToPath(new URL('../packages/vent-server/index.mjs', import.meta.url))
  const stdout = execFileSync('node', [entry], {
    input: 'not json at all\n{"jsonrpc":"2.0","id":7,"method":"tools/list"}\n',
    encoding: 'utf8',
  })
  const replies = stdout.trim().split('\n').map((l) => JSON.parse(l))
  assert.equal(replies.length, 1)
  assert.equal(replies[0].id, 7)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/vent-server.test.mjs`
Expected: FAIL — the sink file does not exist, because `index.mjs` still writes to `DEFAULT_SINK` and ignores `VENT_SINK`.

- [ ] **Step 3: Write minimal implementation**

In `packages/vent-server/index.mjs`, make the sink path overridable so the integration test can point it at a temp file:

```javascript
const SINK = process.env.VENT_SINK || undefined
const deps = {
  now: () => Date.now(),
  appendVent: (record) => appendVent(record, SINK),
  context: () => captureContext(),
}
```

`appendVent`'s `path` parameter already defaults to `DEFAULT_SINK`, so passing `undefined` keeps production behaviour unchanged.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS, `all 26 passed` in the vent suite, whole chain green.

- [ ] **Step 5: Commit**

```bash
git add packages/vent-server/index.mjs tests/vent-server.test.mjs
git commit -m "test(vent): cover real stdio framing end to end

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

- [ ] **Step 6: Open the PR**

```bash
git push -u origin feat/vent-tool
```

Open a PR against `main` whose body contains the actual `npm test` output with counts, links the spec, and states plainly that the modern era is unverified against a real client. Per the repo's merge rules, squash-merge or enable auto-merge only once required checks are green.

---

### Task 7: Weekly triage task

**Requires Cory's explicit approval before writing anything** — this creates persistent configuration under `~/.claude`. Present the task prompt and wait for a yes. Do not create it as part of an unattended run.

**Files:**
- Create: `~/.claude/scheduled-tasks/vent-triage/SKILL.md` (via the `create_scheduled_task` tool, not by hand)

**Interfaces:**
- Consumes: `~/.claude/vents.jsonl` written by Tasks 2–6.
- Produces: `~/.claude/vents.triaged` (watermark file holding the ISO timestamp of the newest triaged vent).

- [ ] **Step 1: Confirm there is anything to triage**

```bash
wc -l ~/.claude/vents.jsonl 2>/dev/null || echo "no vents yet"
```

If the file does not exist or is empty, **stop and say so**. A weekly task that reports "0 vents" every week is noise, and spec §9 sets the kill criterion: fewer than five vents in three weeks means delete the tool rather than build more around it.

- [ ] **Step 2: Get approval for the scheduled task**

Show Cory the exact `cronExpression`, the full prompt text from Step 3, and where the watermark lives. Wait for an explicit yes.

- [ ] **Step 3: Create the task**

Use `create_scheduled_task` with `taskId: "vent-triage"`, `cronExpression: "17 9 * * 1"` (Mondays, off the :00 mark), and a prompt containing all of the following, since each run starts with no memory:

- Read `~/.claude/vents.jsonl`; process only records whose `ts` is newer than the value in `~/.claude/vents.triaged`.
- Cluster by underlying cause, not by wording. Expect roughly a 50% false-positive rate — that is the accepted cost of a zero-gate write path, so discard freely.
- For clusters about **this plugin** (skills, workflows, its hooks): file **one** issue per cluster in `schmug/shipofclaudius`, bodied as a Claude Code prompt per the `/issue` skill.
- For clusters about **`~/.claude`** (global `CLAUDE.md`, `settings.json` hooks, `hooks/git-push-guard.py`): summarize in the run report and **do not file**. `~/.claude` is not a git repo and those are guardrail edits needing Cory's approval.
- One issue per cluster, never per vent.
- Write the newest processed `ts` to `~/.claude/vents.triaged` only after filing completes.
- Report counts: vents read, clusters found, issues filed, `~/.claude` items summarized.
- State the §9 kill criterion in the report when the three-week total is under five.

- [ ] **Step 4: Verify it registered**

```bash
ls ~/.claude/scheduled-tasks/vent-triage/SKILL.md && echo registered
```

---

## Self-Review

**Spec coverage.** §4.1/§4.1.1 dual-era wire contract → Tasks 1 and 5. §4.2 verbatim description → Task 1 Step 3. §4.3 `{text}`-only schema → Task 1, asserted explicitly. §4.4 auto-captured context → Task 3. §4.5 rate limiting → Task 4. §4.6 four return shapes, all `isError:false` → Task 4. §5 sink format → Task 2. §6 triage split → Task 7. §7 testing requirements → Tasks 1–6, registered in the chain at Task 1 Step 5. §9 kill criterion → Task 7 Steps 1 and 3. §10 open item 1 → Task 1 Step 6, the gate. §10 open item 2 → Task 5's header and commit message. §10 open item 3 → resolved before this plan was written; the shape is in Task 5's test.

**Type consistency.** `handle(msg, state, deps)` returns `object|null` throughout. `deps` is `{now, appendVent, context}` in every task. `appendVent(record, path?)` returns `boolean` in both `sink.mjs` and the stub. `captureContext(env, gitFn)` returns four always-`string|null` fields, matching what `callVent` spreads into the record. `callVent` gains a fourth parameter in Task 5 and every call site is updated in the same step.

**Known gap, deliberate.** §8 forbids changes to the question board, and no task touches it.
