// Offline contract test for hooks/hooks.json — the question-board SessionStart hook.
// Node built-ins only; zero token cost. Runs the *real* hook command under a stubbed
// `gh` on PATH, so the shell/jq plumbing is exercised without a network call. Run:
//   node tests/ask-board-hook.test.mjs
//
// The invariant this suite exists to protect: the hook must emit its additionalContext
// on EVERY run, including when the board is empty. An empty board that emits nothing
// makes the board invisible exactly when it needs advertising — which is how it sat
// unused for a week with 0 skill invocations across 471 sessions.
import { readFile, mkdtemp, writeFile, chmod } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

const ROOT = new URL('../', import.meta.url)
const read = (rel) => readFile(new URL(rel, ROOT), 'utf8')

const tests = []
const test = (name, fn) => tests.push([name, fn])

const hooksJson = JSON.parse(await read('hooks/hooks.json'))
const groups = [].concat(hooksJson.hooks?.SessionStart || [])
const entries = groups.flatMap((g) => [].concat(g.hooks || []))
const COMMAND = entries[0]?.command || ''

// `jq` is required by the hook itself. Absent it, the plumbing tests cannot run --
// skip rather than fail, so a bare dev box does not redden CI-green code.
let HAVE_JQ = true
try { execFileSync('sh', ['-c', 'command -v jq'], { stdio: 'ignore' }) } catch { HAVE_JQ = false }

// A stub `gh` that prints canned pre-filtered lines (the hook consumes gh's own
// --jq output) and exits with a canned status.
const STUB_DIR = await mkdtemp(join(tmpdir(), 'ask-board-hook-'))
await writeFile(join(STUB_DIR, 'gh'), '#!/bin/sh\n[ -n "$STUB_GH_OUT" ] && printf \'%s\\n\' "$STUB_GH_OUT"\nexit ${STUB_GH_RC:-0}\n')
await chmod(join(STUB_DIR, 'gh'), 0o755)

// Runs the real hook command with the stub first on PATH. Returns parsed stdout.
function runHook({ out = '', rc = 0 } = {}) {
  const stdout = execFileSync('sh', ['-c', COMMAND], {
    env: { ...process.env, PATH: `${STUB_DIR}:${process.env.PATH}`, STUB_GH_OUT: out, STUB_GH_RC: String(rc) },
    encoding: 'utf8',
  })
  return stdout.trim()
}

function contextOf(stdout) {
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
  if (!HAVE_JQ) return console.log('  (skipped: jq not installed)')
  const ctx = contextOf(runHook({ out: '' }))
  assert.match(ctx, /shipofclaudius:ask-board/, 'names the skill that posts to the board')
})

test('the empty-board message does not read as an error', () => {
  if (!HAVE_JQ) return console.log('  (skipped: jq not installed)')
  const ctx = contextOf(runHook({ out: '' }))
  assert.match(ctx, /no open questions/i, 'says the board is empty, plainly')
})

test('lists open questions when the board has them', () => {
  if (!HAVE_JQ) return console.log('  (skipped: jq not installed)')
  const ctx = contextOf(runHook({ out: '#7 Does a bounced send count against quota?' }))
  assert.match(ctx, /#7 Does a bounced send count against quota\?/, 'passes the question through verbatim')
  assert.doesNotMatch(ctx, /no open questions/i, 'does not also claim the board is empty')
})

test('a broken or absent gh does not fabricate an empty board', () => {
  if (!HAVE_JQ) return console.log('  (skipped: jq not installed)')
  // rc!=0 with no output is indistinguishable from "board is empty" unless the hook
  // checks the exit status. Reporting "no open questions" here is a silent false negative.
  const ctx = contextOf(runHook({ out: '', rc: 127 }))
  assert.doesNotMatch(ctx, /no open questions/i, 'must not claim an empty board when the read failed')
})

test('the hook still exits 0 when gh fails', () => {
  if (!HAVE_JQ) return console.log('  (skipped: jq not installed)')
  runHook({ out: '', rc: 127 })  // execFileSync throws on non-zero
})

test("gh's --jq filter drops answered questions and flags misfiled ones", () => {
  if (!HAVE_JQ) return console.log('  (skipped: jq not installed)')
  const m = COMMAND.match(/--jq '([^']*)'/)
  assert.ok(m, 'the command passes a --jq filter to gh')
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

// ---- runner ----
let failed = 0
for (const [name, fn] of tests) {
  try { await fn(); console.log('PASS', name) }
  catch (e) { failed++; console.error('FAIL', name, '\n  ', e.message) }
}
console.log(failed ? `\n${failed}/${tests.length} FAILED` : `\nall ${tests.length} passed`)
process.exit(failed ? 1 : 0)
