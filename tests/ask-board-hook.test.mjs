// Offline contract test for hooks/hooks.json + hooks/board-session-start.sh — the
// question-board SessionStart hook. Node built-ins only; zero token cost. Runs the
// *real* hook command (which invokes the real script) under a stubbed `gh` on PATH,
// so the shell/jq plumbing is exercised without a network call. Run:
//   node tests/ask-board-hook.test.mjs
//
// The invariant this suite exists to protect: the hook must emit its additionalContext
// on EVERY run, including when the board is empty. An empty board that emits nothing
// makes the board invisible exactly when it needs advertising — which is how it sat
// unused for a week with 0 skill invocations across 471 sessions.
//
// The script serves three distinguishable states (issue #205): live (fresh gh fetch),
// cached (gh failed but a cache within TTL served the last list, with its age), and
// unavailable (no live fetch and no cache within TTL). The cache file the tests use is
// always a fresh path under a suite-local temp dir, so a run can never touch the real
// ~/.claude/board-cache.json.
import { readFile, writeFile, chmod } from 'node:fs/promises'
import { mkdtempSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const ROOT = new URL('../', import.meta.url)
const REPO_ROOT = fileURLToPath(ROOT)
const read = (rel) => readFile(new URL(rel, ROOT), 'utf8')

const tests = []
const test = (name, fn) => tests.push([name, fn])

const hooksJson = JSON.parse(await read('hooks/hooks.json'))
const groups = [].concat(hooksJson.hooks?.SessionStart || [])
const entries = groups.flatMap((g) => [].concat(g.hooks || []))
const COMMAND = entries[0]?.command || ''
const SCRIPT = await read('hooks/board-session-start.sh')

// `jq` is required by the hook itself, and `perl` runs the portable alarm the script
// kills a hung gh with. Absent either, the plumbing tests cannot run -- skip rather
// than fail, so a bare dev box does not redden CI-green code.
let HAVE_JQ = true
let HAVE_PERL = true
try { execFileSync('sh', ['-c', 'command -v jq'], { stdio: 'ignore' }) } catch { HAVE_JQ = false }
try { execFileSync('sh', ['-c', 'command -v perl'], { stdio: 'ignore' }) } catch { HAVE_PERL = false }
const SKIP = !HAVE_JQ || !HAVE_PERL
const skipNote = () => console.log(`  (skipped: ${!HAVE_JQ ? 'jq' : 'perl'} not installed)`)

// A stub `gh` that sleeps a canned time (emulating a hung fetch), prints canned
// pre-filtered lines (the hook consumes gh's own --jq output), and exits with a
// canned status. Sleep's output is redirected on purpose: a real hung gh is a single
// process that dies at the script's alarm, closing the capture pipe; a shell-script
// stub that leaves `sleep` alive as a grandchild holding that pipe would hang the
// hook's command substitution past the kill even though the production script is
// correct — so the stub emulates gh's death by not holding the pipe itself.
const TMP = mkdtempSync(join(tmpdir(), 'ask-board-hook-'))
await writeFile(join(TMP, 'gh'), [
  '#!/bin/sh',
  '[ -n "$STUB_GH_SLEEP" ] && sleep "$STUB_GH_SLEEP" >/dev/null 2>&1',
  '[ -n "$STUB_GH_OUT" ] && printf \'%s\\n\' "$STUB_GH_OUT"',
  'exit ${STUB_GH_RC:-0}',
  '',
].join('\n'))
await chmod(join(TMP, 'gh'), 0o755)

// A fresh cache path per hook run, so no run ever reads or writes another run's
// cache — or the real ~/.claude/board-cache.json.
let cacheSeq = 0
const freshCache = () => join(TMP, `cache-${++cacheSeq}.json`)

// Runs the real hook command with the stub first on PATH. Returns parsed stdout,
// the cache path used, and the wall time of the run.
function runHook({ out = '', rc = 0, sleep, ghTimeout, cache, timeout = 10_000 } = {}) {
  const cacheFile = cache ?? freshCache()
  const t0 = Date.now()
  const stdout = execFileSync('sh', ['-c', COMMAND], {
    env: {
      ...process.env,
      PATH: `${TMP}:${process.env.PATH}`,
      STUB_GH_OUT: out,
      STUB_GH_RC: String(rc),
      ...(sleep ? { STUB_GH_SLEEP: String(sleep) } : {}),
      ...(ghTimeout != null ? { BOARD_GH_TIMEOUT: String(ghTimeout) } : {}),
      CLAUDE_PLUGIN_ROOT: REPO_ROOT,
      BOARD_CACHE_FILE: cacheFile,
    },
    encoding: 'utf8',
    timeout,
  })
  return { stdout: stdout.trim(), cacheFile, elapsed: Date.now() - t0 }
}

function contextOf(run) {
  const stdout = run.stdout ?? run
  assert.ok(stdout.length > 0, 'hook emitted nothing at all')
  const parsed = JSON.parse(stdout)
  const ctx = parsed?.hookSpecificOutput?.additionalContext
  assert.equal(parsed?.hookSpecificOutput?.hookEventName, 'SessionStart', 'declares hookEventName SessionStart')
  assert.ok(typeof ctx === 'string' && ctx.length > 0, 'carries a non-empty additionalContext')
  return ctx
}

test('fires on the context-losing start modes, not just startup', () => {
  // `clear` and `compact` wipe or summarize context, dropping any earlier injection.
  // Matching only "startup" means a long session -- exactly the kind that accumulates
  // durable unknowns -- loses the board the moment it compacts.
  const matchers = groups.map((g) => g.matcher || '')
  const covered = (mode) => matchers.some((m) => m.split('|').map((s) => s.trim()).includes(mode))
  for (const mode of ['startup', 'clear', 'compact']) {
    assert.ok(covered(mode), `SessionStart matcher covers "${mode}" (have: ${JSON.stringify(matchers)})`)
  }
})

test('emits the board reminder even when there are no open questions', () => {
  if (SKIP) return skipNote()
  const ctx = contextOf(runHook({ out: '' }))
  assert.match(ctx, /shipofclaudius:ask-board/, 'names the skill that posts to the board')
})

test('the empty-board message does not read as an error', () => {
  if (SKIP) return skipNote()
  const ctx = contextOf(runHook({ out: '' }))
  assert.match(ctx, /no open questions/i, 'says the board is empty, plainly')
})

test('lists open questions when the board has them', () => {
  if (SKIP) return skipNote()
  const ctx = contextOf(runHook({ out: '#7 Does a bounced send count against quota?' }))
  assert.match(ctx, /#7 Does a bounced send count against quota\?/, 'passes the question through verbatim')
  assert.doesNotMatch(ctx, /no open questions/i, 'does not also claim the board is empty')
})

test('a broken or absent gh does not fabricate an empty board', () => {
  if (SKIP) return skipNote()
  // rc!=0 with no output and no cache is indistinguishable from "board is empty" unless
  // the hook checks the exit status. Reporting "no open questions" here is a silent
  // false negative.
  const ctx = contextOf(runHook({ out: '', rc: 127 }))
  assert.doesNotMatch(ctx, /no open questions/i, 'must not claim an empty board when the read failed')
  assert.match(ctx, /unreachable this session/, 'says plainly that the read failed')
})

test('the hook still exits 0 when gh fails', () => {
  if (SKIP) return skipNote()
  runHook({ out: '', rc: 127 })  // execFileSync throws on non-zero
})

test("gh's --jq filter drops answered questions and flags misfiled ones", () => {
  if (!HAVE_JQ) return console.log('  (skipped: jq not installed)')
  // The filter lives in the script now, not in hooks.json's one-line command.
  const m = SCRIPT.match(/--jq '([^']*)'/)
  assert.ok(m, 'the script passes a --jq filter to gh')
  const payload = JSON.stringify({
    discussions: [
      { number: 1, title: 'Already answered', answered: true, category: { name: 'Q&A' } },
      { number: 2, title: 'Still open', answered: false, category: { name: 'Q&A' } },
      { number: 3, title: 'Wrong category', answered: false, category: { name: 'Ideas' } },
    ],
  })
  const out = execFileSync('jq', ['-r', m[1]], { input: payload, encoding: 'utf8' }).trim().split('\n')
  assert.deepEqual(out, [
    '#2 Still open',
    '#3 Wrong category  [!! MISFILED in Ideas - cannot be answered, move to Q&A]',
  ])
})

// ---- issue #205: the cache fallback ----

test('a live fetch writes the cache file with fetched_at and q', async () => {
  if (SKIP) return skipNote()
  const q = '#7 Does a bounced send count against quota?'
  const { cacheFile } = runHook({ out: q })
  const doc = JSON.parse(await readFile(cacheFile, 'utf8'))
  assert.equal(doc.q, q, 'stores the raw filtered gh output verbatim')
  const now = Math.floor(Date.now() / 1000)
  assert.ok(Math.abs(doc.fetched_at - now) < 30, 'fetched_at is a fetch timestamp near now, not pre-formatted age')
})

test('a failed gh call with a cache within TTL serves the cached list with its age', async () => {
  if (SKIP) return skipNote()
  const q = '#9 Which wrangler config does the preview deploy use?'
  const cache = freshCache()
  await writeFile(cache, JSON.stringify({ fetched_at: Math.floor(Date.now() / 1000), q }))
  const ctx = contextOf(runHook({ out: '', rc: 127, cache }))
  assert.match(ctx, /live fetch failed; served from cache/, 'names the cached state, distinguishable from live')
  assert.match(ctx, /min old/, 'carries the cache age label')
  assert.ok(ctx.includes(q), 'carries the cached question verbatim')
  assert.doesNotMatch(ctx, /unreachable this session/, 'does not claim the board is unreachable when it served')
})

test('a cache older than the TTL does not resurrect the cached list', async () => {
  if (SKIP) return skipNote()
  // fetched_at = now-3600 is 60 min old; against the shipped 15-min default TTL that
  // is stale, and a stale list resurrecting an answered question is worse than an
  // honest gap.
  assert.match(SCRIPT, /BOARD_CACHE_TTL:-900/, 'the 15-min default is what makes a 60-min-old cache stale')
  const q = '#9 answered since the cache was written'
  const cache = freshCache()
  await writeFile(cache, JSON.stringify({ fetched_at: Math.floor(Date.now() / 1000) - 3600, q }))
  const ctx = contextOf(runHook({ out: '', rc: 127, cache }))
  assert.match(ctx, /unreachable this session/, 'falls through to the honest gap')
  assert.match(ctx, /no fresh cache/, 'says why the cached list was not served')
  assert.ok(!ctx.includes(q), 'does not resurrect the stale question')
  assert.doesNotMatch(ctx, /served from cache/, 'does not claim it served from cache')
})

test('a hung gh is killed at the alarm and the hook falls back to the cache within ~2 s', async () => {
  if (SKIP) return skipNote()
  const q = '#11 Does a hung fetch fall back to the cache in time?'
  const cache = freshCache()
  await writeFile(cache, JSON.stringify({ fetched_at: Math.floor(Date.now() / 1000), q }))
  // The stub sleeps 3 s; the script's BOARD_GH_TIMEOUT=1 alarm must kill it and still
  // emit well inside the 10 s hook kill (and inside this 5 s exec bound).
  const run = runHook({ sleep: 3, ghTimeout: 1, cache, timeout: 5000 })
  assert.ok(run.elapsed < 2000, `fell back within ~2 s (took ${run.elapsed} ms)`)
  const ctx = contextOf(run)
  assert.match(ctx, /live fetch failed; served from cache/, 'the fallback served from cache')
  assert.ok(ctx.includes(q), 'the cached question is in the injected text')
})

// ---- runner ----
let failed = 0
for (const [name, fn] of tests) {
  try { await fn(); console.log('PASS', name) }
  catch (e) { failed++; console.error('FAIL', name, '\n  ', e.message) }
}
console.log(failed ? `\n${failed}/${tests.length} FAILED` : `\nall ${tests.length} passed`)
process.exit(failed ? 1 : 0)
