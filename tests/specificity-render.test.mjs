// Contract tests for the prompt-specificity status line (packages/specificity/bin).
//
// Runs the REAL render.sh + render.jq under a temp cache dir, so the sh/jq plumbing is
// exercised rather than reimplemented. Two invariants drive the suite:
//
//   - §5.2: the renderer never computes. It reads stdin and one file, full stop.
//   - §8: every failure prints NOTHING and exits 0. A status line runs on every
//     conversation update, so one that can error makes a working session look broken.
// Run:  node tests/specificity-render.test.mjs
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, utimes } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const RENDER = fileURLToPath(new URL('../packages/specificity/bin/render.sh', import.meta.url))
const tests = []
const test = (name, fn) => tests.push([name, fn])

// jq is required by the renderer itself. Absent it, skip rather than fail — a bare dev
// box should not redden CI-green code.
let HAVE_JQ = true
try { execFileSync('sh', ['-c', 'command -v jq'], { stdio: 'ignore' }) } catch { HAVE_JQ = false }

const ESC = String.fromCharCode(27)
const plain = (s) => s.replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '')

function render(record, { sessionId = 'sess', transcriptPath = '', dir, grace, promptId } = {}) {
  const env = { ...process.env, SPECIFICITY_DIR: dir }
  if (grace !== undefined) env.SPECIFICITY_STALE_GRACE = String(grace)
  const payload = { session_id: sessionId, transcript_path: transcriptPath }
  if (promptId !== undefined) payload.prompt_id = promptId
  return execFileSync('sh', [RENDER], { input: JSON.stringify(payload), encoding: 'utf8', env })
}

async function withCache(record, sessionId = 'sess') {
  const dir = await mkdtemp(join(tmpdir(), 'spec-render-'))
  if (record) await writeFile(join(dir, `${sessionId}.json`), JSON.stringify(record))
  return dir
}

const FAST = (over = {}) => ({
  referents: [], unresolved: 0, ambiguous: 0, grounded: 0, indeterminate: 0,
  constraints: { acceptance: 0, io_spec: 0, named_files: 0, format: 0 },
  prompt_tokens: 10, log_length_baseline: 2.3, ...over,
})
const RECORD = (over = {}) => ({
  session_id: 'sess', prompt_id: 'p', written_at: Date.now() / 1000, phase: 'skipped', fast: FAST(), ...over,
})

test('renders the sampled state with bar, decimal and state word', async () => {
  if (!HAVE_JQ) return console.log('  (skipped: jq not installed)')
  const dir = await withCache(RECORD({ phase: 'complete', sampled: { delta_normalized: 0.74, state: 'carried' } }))
  const out = plain(render(null, { dir })).trim()
  assert.equal(out, 'spec ▓▓▓▓▓▓░░ .74 carried')
})

test('each of the four states gets its own word and colour', async () => {
  if (!HAVE_JQ) return console.log('  (skipped: jq not installed)')
  const expected = [['carried', 'carried', '32'], ['redundant', 'redundant', '2'],
    ['underspecified', 'underspec', '33'], ['conflicting', 'conflict', '31']]
  for (const [state, word, code] of expected) {
    const dir = await withCache(RECORD({ phase: 'complete', sampled: { delta_normalized: 0.5, state } }))
    const raw = render(null, { dir })
    assert.match(plain(raw), new RegExp(`\\b${word}\\b`), `${state} renders as ${word}`)
    assert.ok(raw.includes(`${ESC}[${code}m`), `${state} is painted ${code}`)
  }
})

test('conflict is the loud one', async () => {
  if (!HAVE_JQ) return console.log('  (skipped: jq not installed)')
  const dir = await withCache(RECORD({ phase: 'complete', sampled: { delta_normalized: 0.9, state: 'conflicting' } }))
  assert.ok(render(null, { dir }).includes(`${ESC}[31m`), 'conflict renders red')
})

test('the sampling placeholder shows while the async phase is in flight', async () => {
  if (!HAVE_JQ) return console.log('  (skipped: jq not installed)')
  const dir = await withCache(RECORD({ phase: 'sampling' }))
  assert.equal(plain(render(null, { dir })).trim(), 'spec ░░░░░░░░  ·  sampling')
})

test('a fast-only record renders fast-path fields, not a borrowed state word', async () => {
  if (!HAVE_JQ) return console.log('  (skipped: jq not installed)')
  // §8: "Sampler crashes -> the cache keeps the fast block; the status line shows the
  // fast-path fields only." M1 ships with no sampler at all, so this is the normal render.
  const dir = await withCache(RECORD({
    phase: 'skipped',
    fast: FAST({ referents: [{ status: 'grounded' }, { status: 'unresolved' }], unresolved: 1, grounded: 1 }),
  }))
  const out = plain(render(null, { dir })).trim()
  assert.equal(out, 'spec ▓▓▓▓░░░░ .50 fast ⟂1')
})

test('a turn with no referents renders a neutral marker, not a confident 1.0', async () => {
  if (!HAVE_JQ) return console.log('  (skipped: jq not installed)')
  // 24.4% of real turns carry zero referents. A full bar at 1.0 would claim perfect
  // grounding on a turn where nothing was measured at all.
  const dir = await withCache(RECORD({ fast: FAST({ referents: [] }) }))
  const out = plain(render(null, { dir })).trim()
  assert.equal(out, 'spec ░░░░░░░░  ·  no refs')
  assert.ok(!out.includes('1.0'), 'never claims a perfect score for an unmeasured turn')
})

test('the unresolved flag appears only when there is something unresolved', async () => {
  if (!HAVE_JQ) return console.log('  (skipped: jq not installed)')
  const clean = await withCache(RECORD({ fast: FAST({ referents: [{ status: 'grounded' }], grounded: 1 }) }))
  assert.ok(!plain(render(null, { dir: clean })).includes('⟂'))
  const dirty = await withCache(RECORD({ fast: FAST({ referents: [{ status: 'unresolved' }, { status: 'unresolved' }], unresolved: 2 }) }))
  assert.match(plain(render(null, { dir: dirty })), /⟂2/)
})

test('a turn whose only referents are pronouns renders neutral, not a score', async () => {
  if (!HAVE_JQ) return console.log('  (skipped: jq not installed)')
  // Indeterminate pronouns are excluded from the denominator, so there is nothing scored
  // here. Rendering .00 would read as "badly grounded"; rendering 1.0 as "perfect". Both
  // are claims the index cannot support.
  const dir = await withCache(RECORD({
    fast: FAST({ referents: [{ status: 'indeterminate' }, { status: 'indeterminate' }], indeterminate: 2 }),
  }))
  assert.equal(plain(render(null, { dir })).trim(), 'spec ░░░░░░░░  ·  no refs')
})

test('the bar is always exactly eight cells', async () => {
  if (!HAVE_JQ) return console.log('  (skipped: jq not installed)')
  for (const v of [0, 0.01, 0.5, 0.999, 1, 1.5, -0.2]) {
    const dir = await withCache(RECORD({ phase: 'complete', sampled: { delta_normalized: v, state: 'carried' } }))
    const bar = plain(render(null, { dir })).trim().split(' ')[1]
    assert.equal([...bar].length, 8, `delta_normalized ${v} still renders 8 cells`)
  }
})

test('the decimal never carries a leading zero and saturates at 1.0', async () => {
  if (!HAVE_JQ) return console.log('  (skipped: jq not installed)')
  const cases = [[0.74, '.74'], [0.05, '.05'], [1, '1.0'], [1.4, '1.0'], [0, '.00']]
  for (const [v, want] of cases) {
    const dir = await withCache(RECORD({ phase: 'complete', sampled: { delta_normalized: v, state: 'carried' } }))
    assert.equal(plain(render(null, { dir })).trim().split(' ')[2], want, `${v} renders ${want}`)
  }
})

test('a transcript newer than the record by more than the grace renders (stale)', async () => {
  if (!HAVE_JQ) return console.log('  (skipped: jq not installed)')
  // §5.4 — the status line has no prompt_id of its own, so a confidently wrong number is
  // the failure mode to avoid.
  const nowSec = Math.floor(Date.now() / 1000)
  const dir = await withCache(RECORD({ written_at: nowSec - 600, phase: 'complete', sampled: { delta_normalized: 0.61, state: 'carried' } }))
  const transcript = join(dir, 'transcript.jsonl')
  await writeFile(transcript, '{}\n')
  await utimes(transcript, nowSec, nowSec)
  assert.match(plain(render(null, { dir, transcriptPath: transcript })), /\(stale\)$/m)
})

test('a transcript within the grace window is not called stale', async () => {
  if (!HAVE_JQ) return console.log('  (skipped: jq not installed)')
  const nowSec = Math.floor(Date.now() / 1000)
  const dir = await withCache(RECORD({ written_at: nowSec - 5, phase: 'complete', sampled: { delta_normalized: 0.61, state: 'carried' } }))
  const transcript = join(dir, 'transcript.jsonl')
  await writeFile(transcript, '{}\n')
  await utimes(transcript, nowSec, nowSec)
  assert.ok(!plain(render(null, { dir, transcriptPath: transcript })).includes('(stale)'))
})

test('an unknown transcript mtime is treated as fresh, not cried wolf over', async () => {
  if (!HAVE_JQ) return console.log('  (skipped: jq not installed)')
  const dir = await withCache(RECORD({ written_at: 1, phase: 'complete', sampled: { delta_normalized: 0.6, state: 'carried' } }))
  assert.ok(!plain(render(null, { dir, transcriptPath: '/definitely/not/here.jsonl' })).includes('(stale)'))
})

test('a prompt_id that differs from the record marks it stale, exactly', async () => {
  if (!HAVE_JQ) return console.log('  (skipped: jq not installed)')
  // The status-line payload carries prompt_id, so this is a comparison rather than the
  // mtime guess §5.4 was written around. No transcript is involved at all here.
  const dir = await withCache(RECORD({ prompt_id: 'turn-1', phase: 'complete', sampled: { delta_normalized: 0.6, state: 'carried' } }))
  assert.match(plain(render(null, { dir, promptId: 'turn-2' })), /\(stale\)/)
  assert.ok(!plain(render(null, { dir, promptId: 'turn-1' })).includes('(stale)'), 'the matching id is fresh')
})

test('an exact prompt_id match beats a stale-looking mtime', async () => {
  if (!HAVE_JQ) return console.log('  (skipped: jq not installed)')
  // A long-running turn can leave written_at far behind the transcript while still being
  // the CURRENT turn. The heuristic calls that stale; the exact comparison does not, and
  // the exact answer must win.
  const nowSec = Math.floor(Date.now() / 1000)
  const dir = await withCache(RECORD({ prompt_id: 'turn-7', written_at: nowSec - 3600, phase: 'complete', sampled: { delta_normalized: 0.6, state: 'carried' } }))
  const transcript = join(dir, 'transcript.jsonl')
  await writeFile(transcript, '{}\n')
  await utimes(transcript, nowSec, nowSec)
  assert.ok(!plain(render(null, { dir, transcriptPath: transcript, promptId: 'turn-7' })).includes('(stale)'))
})

test('the mtime fallback still engages when the host sends no prompt_id', async () => {
  if (!HAVE_JQ) return console.log('  (skipped: jq not installed)')
  // Not every installed version is guaranteed to send the field, so the heuristic has to
  // survive as a fallback rather than being deleted outright.
  const nowSec = Math.floor(Date.now() / 1000)
  const dir = await withCache(RECORD({ prompt_id: 'turn-9', written_at: nowSec - 600, phase: 'complete', sampled: { delta_normalized: 0.6, state: 'carried' } }))
  const transcript = join(dir, 'transcript.jsonl')
  await writeFile(transcript, '{}\n')
  await utimes(transcript, nowSec, nowSec)
  assert.match(plain(render(null, { dir, transcriptPath: transcript })), /\(stale\)/)
})

test('a missing cache file prints nothing at all, not an error string', async () => {
  if (!HAVE_JQ) return console.log('  (skipped: jq not installed)')
  const dir = await withCache(null)
  assert.equal(render(null, { dir }), '')
})

test('a malformed cache file prints nothing rather than jq noise', async () => {
  if (!HAVE_JQ) return console.log('  (skipped: jq not installed)')
  const dir = await mkdtemp(join(tmpdir(), 'spec-render-bad-'))
  await writeFile(join(dir, 'sess.json'), '{ truncated')
  assert.equal(render(null, { dir }), '')
})

test('a traversal session_id is refused before any path is built', async () => {
  if (!HAVE_JQ) return console.log('  (skipped: jq not installed)')
  const dir = await withCache(RECORD())
  for (const bad of ['../../etc/passwd', 'a/b', 'a b']) {
    assert.equal(render(null, { dir, sessionId: bad }), '', `${bad} renders nothing`)
  }
})

test('absent stdin fields render nothing and exit 0', () => {
  if (!HAVE_JQ) return console.log('  (skipped: jq not installed)')
  const out = execFileSync('sh', [RENDER], { input: '{}', encoding: 'utf8' })
  assert.equal(out, '')
})

test('the renderer never shells out to git or the network', async () => {
  // §5.2 is a hard constraint, not a preference: this runs on every conversation update.
  const src = (await import('node:fs/promises').then((fs) => fs.readFile(RENDER, 'utf8')))
    .split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')  // comments describe the rule; code obeys it
  for (const forbidden of ['git ', 'curl', 'wget', 'node ', 'python']) {
    assert.ok(!src.includes(forbidden), `render.sh must not invoke ${forbidden.trim()}`)
  }
})

test('output is a single line — the status line takes the first and drops the rest', async () => {
  if (!HAVE_JQ) return console.log('  (skipped: jq not installed)')
  const dir = await withCache(RECORD({ phase: 'complete', sampled: { delta_normalized: 0.74, state: 'carried' } }))
  assert.equal(render(null, { dir }).trimEnd().split('\n').length, 1)
})

// ---- runner ----
let failed = 0
for (const [name, fn] of tests) {
  try { await fn(); console.log('PASS', name) }
  catch (e) { failed++; console.error('FAIL', name, '\n  ', e.message) }
}
console.log(failed ? `\n${failed}/${tests.length} FAILED` : `\nall ${tests.length} passed`)
process.exit(failed ? 1 : 0)
