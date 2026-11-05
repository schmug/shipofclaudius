// Unit tests for scrutineer-autopilot GitHub polling (exec stubbed) and tier choice.
// Run:  node tests/scrutineer-autopilot-tiers.test.mjs
import assert from 'node:assert/strict'
import { pollRepo, requiredChecks, prState, prForBranch } from '../packages/scrutineer-autopilot/src/github.mjs'
import { chooseTiers, dueScan } from '../packages/scrutineer-autopilot/src/tiers.mjs'

const tests = []
const test = (name, fn) => tests.push([name, fn])
const NOW = Date.parse('2026-11-01T12:00:00Z')
const DAY = 86400e3

// routes: substring of the joined args -> string | Error | fn
const stub = (routes) => {
  const calls = []
  const exec = async (cmd, args) => {
    const line = [cmd, ...args].join(' ')
    calls.push(line)
    for (const [frag, v] of Object.entries(routes)) {
      if (!line.includes(frag)) continue
      const r = typeof v === 'function' ? v() : v
      if (r instanceof Error) throw r
      return r
    }
    throw new Error(`unrouted: ${line}`)
  }
  return { exec, calls }
}
const ghErr = (stderr) => Object.assign(new Error('Command failed'), { stderr })

const repoRoutes = (visibility = 'public', pulls = [], rels = []) => ({
  'api repos/o/app/commits/main': 'abc123\n',
  'api repos/o/app/pulls': JSON.stringify(pulls),
  'api repos/o/app/releases': JSON.stringify(rels),
  'api repos/o/app': JSON.stringify({ default_branch: 'main', visibility }),
})

test('pollRepo excludes autopilot finding PRs, keeps others', async () => {
  const { exec } = stub(repoRoutes('public', [
    { number: 12, merged_at: '2026-10-30T00:00:00Z', head: { ref: 'scrutineer/finding-12', repo: { full_name: 'o/app' } } },
    { number: 13, merged_at: '2026-10-31T00:00:00Z', head: { ref: 'feat/x' } },
    { number: 14, merged_at: null, head: { ref: 'feat/closed' } },
  ], [{ tag_name: 'v1', published_at: '2026-10-29T00:00:00Z' }]))
  const ev = await pollRepo('o/app', { sha: 'abc123' }, { exec })
  assert.deepEqual(ev.mergedPrs, [{ number: 13, mergedAt: '2026-10-31T00:00:00Z', headRef: 'feat/x' }])
  assert.deepEqual(ev.releases, [{ tag: 'v1', publishedAt: '2026-10-29T00:00:00Z' }])
  assert.equal(ev.pushed, false)
  assert.equal(ev.headSha, 'abc123')
  assert.equal(ev.defaultBranch, 'main')
})
test('pollRepo: internal -> private; since cursors filter old PRs and releases; new sha -> pushed', async () => {
  const { exec } = stub(repoRoutes('internal', [
    { number: 1, merged_at: '2026-10-01T00:00:00Z', head: { ref: 'a' } },
    { number: 2, merged_at: '2026-10-31T00:00:00Z', head: { ref: 'b' } },
  ], [{ tag_name: 'v0', published_at: '2026-10-01T00:00:00Z' }]))
  const ev = await pollRepo('o/app', { sha: 'old', prMergedAt: '2026-10-15T00:00:00Z', releaseAt: '2026-10-15T00:00:00Z' }, { exec })
  assert.equal(ev.visibility, 'private')
  assert.deepEqual(ev.mergedPrs.map((p) => p.number), [2])
  assert.deepEqual(ev.releases, [])
  assert.equal(ev.pushed, true)
})
test('requiredChecks merges rulesets and classic, dedupes', async () => {
  const { exec } = stub({
    'rules/branches/main': JSON.stringify([
      { type: 'deletion' },
      { type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'test' }, { context: 'lint' }] } },
    ]),
    'protection/required_status_checks': JSON.stringify({ contexts: ['test'], checks: [{ context: 'build' }] }),
  })
  assert.deepEqual((await requiredChecks('o/app', 'main', { exec })).sort(), ['build', 'lint', 'test'])
})
test('requiredChecks: 404 on both -> [] (no gate)', async () => {
  const { exec } = stub({
    'rules/branches/main': ghErr('gh: Not Found (HTTP 404)'),
    'protection/required_status_checks': ghErr('gh: Branch not protected (HTTP 404)'),
  })
  assert.deepEqual(await requiredChecks('o/app', 'main', { exec }), [])
})
test('requiredChecks: auth failure propagates from either endpoint', async () => {
  const auth = ghErr('gh: Bad credentials (HTTP 401)')
  await assert.rejects(requiredChecks('o/app', 'main', { exec: stub({ 'rules/branches': auth }).exec }), /Command failed/)
  await assert.rejects(requiredChecks('o/app', 'main', {
    exec: stub({ 'rules/branches': '[]', 'protection/required_status_checks': ghErr('gh: Forbidden (HTTP 403)') }).exec,
  }), /Command failed/)
})
test('prState returns {state, mergeSha}', async () => {
  const { exec, calls } = stub({ 'pr view 7': JSON.stringify({ state: 'MERGED', mergeCommit: { oid: 'deadbeef' } }) })
  assert.deepEqual(await prState('o/app', 7, { exec }), { state: 'MERGED', mergeSha: 'deadbeef' })
  assert.match(calls[0], /gh pr view 7 -R o\/app --json state,mergeCommit/)
  const open = stub({ 'pr view': JSON.stringify({ state: 'OPEN', mergeCommit: null }) })
  assert.deepEqual(await prState('o/app', 8, { exec: open.exec }), { state: 'OPEN', mergeSha: null })
})
// REST pulls rows (gh api repos/{key}/pulls?head=owner:branch).
const pull = (o) => ({ number: 9, state: 'closed', merged_at: null, created_at: '2026-10-29T00:00:00Z', merge_commit_sha: 'test-merge', head: { ref: 'scrutineer/finding-3', repo: { full_name: 'o/app' } }, ...o })
test('prForBranch filters server-side by head=owner:branch, separate argv, and maps REST state', async () => {
  const { exec, calls } = stub({ 'pulls': JSON.stringify([pull({ merged_at: '2026-10-30T00:00:00Z', merge_commit_sha: 'cafe' })]) })
  assert.deepEqual(await prForBranch('o/app', 'scrutineer/finding-3', { exec }), { number: 9, state: 'MERGED', mergeSha: 'cafe', mergedAt: '2026-10-30T00:00:00Z', createdAt: '2026-10-29T00:00:00Z' })
  assert.equal(calls[0], 'gh api --method GET repos/o/app/pulls -f head=o:scrutineer/finding-3 -f state=all -f per_page=5')
  const one = async (row) => prForBranch('o/app', 'scrutineer/finding-3', { exec: stub({ 'pulls': JSON.stringify([row]) }).exec })
  assert.deepEqual(await one(pull({ state: 'open' })), { number: 9, state: 'OPEN', mergeSha: null, mergedAt: null, createdAt: '2026-10-29T00:00:00Z' })
  assert.deepEqual(await one(pull()), { number: 9, state: 'CLOSED', mergeSha: null, mergedAt: null, createdAt: '2026-10-29T00:00:00Z' })
  assert.deepEqual(await one(pull({ created_at: undefined })), { number: 9, state: 'CLOSED', mergeSha: null, mergedAt: null, createdAt: null })
  assert.equal(await prForBranch('o/app', 'nope', { exec: stub({ 'pulls': '[]' }).exec }), null)
})
test('prForBranch ignores fork PRs with the branch name even if the server returns them', async () => {
  const fork = pull({ number: 4, merged_at: '2026-10-30T00:00:00Z', head: { ref: 'scrutineer/finding-3', repo: { full_name: 'mallory/app' } } })
  const run = (rows) => prForBranch('o/app', 'scrutineer/finding-3', { exec: stub({ 'pulls': JSON.stringify(rows) }).exec })
  assert.equal(await run([fork]), null)
  assert.equal(await run([pull({ head: { ref: 'scrutineer/finding-3', repo: null } })]), null) // head repo deleted
  assert.deepEqual(await run([fork, pull({ number: 8, state: 'open' })]), { number: 8, state: 'OPEN', mergeSha: null, mergedAt: null, createdAt: '2026-10-29T00:00:00Z' })
})
test('pollRepo counts a fork PR named scrutineer/finding-* as a rescan trigger', async () => {
  const { exec } = stub(repoRoutes('public', [
    { number: 20, merged_at: '2026-10-31T00:00:00Z', head: { ref: 'scrutineer/finding-1', repo: { full_name: 'mallory/app' } } },
    { number: 21, merged_at: '2026-10-31T00:00:00Z', head: { ref: 'scrutineer/finding-2', repo: { full_name: 'O/App' } } },
  ]))
  const ev = await pollRepo('o/app', { sha: 'abc123' }, { exec })
  assert.deepEqual(ev.mergedPrs.map((p) => p.number), [20])
})

test('chooseTiers: $10, estDiff 3 -> first diff (6), second weekly', () => {
  const t = chooseTiers([
    { key: 'o/b', openHigh: 0, eventsPerWeek: { push: 5, pr: 0, release: 0 }, estDiff: 3 },
    { key: 'o/a', openHigh: 1, eventsPerWeek: { push: 2, pr: 0, release: 0 }, estDiff: 3 },
  ], 10)
  assert.deepEqual(t, { 'o/a': 'diff', 'o/b': 'weekly' })
})
test('chooseTiers: $0 -> everything monthly', () => {
  const t = chooseTiers([
    { key: 'o/a', openHigh: 1, eventsPerWeek: { push: 2, pr: 1, release: 1 }, estDiff: 3 },
    { key: 'o/b', openHigh: 0, eventsPerWeek: { push: 5, pr: 0, release: 0 }, estDiff: 3 },
  ], 0)
  assert.deepEqual(t, { 'o/a': 'monthly', 'o/b': 'monthly' })
})

const state = { lastFullAt: NOW - 10 * DAY, scrutineerVersion: '1.0', lastScannedSha: 'abc' }
const ev = (o = {}) => ({ headSha: 'abc', pushed: false, mergedPrs: [], releases: [], ...o })
test('dueScan: weekly with unchanged head -> null; changed head -> diff', () => {
  assert.equal(dueScan(state, ev(), 'weekly', NOW), null)
  assert.equal(dueScan(state, ev({ headSha: 'new' }), 'monthly', NOW), 'diff')
})
test('dueScan: full at day 91, not at day 89', () => {
  assert.equal(dueScan({ ...state, lastFullAt: NOW - 91 * DAY }, ev(), 'weekly', NOW), 'full')
  assert.equal(dueScan({ ...state, lastFullAt: NOW - 89 * DAY }, ev(), 'weekly', NOW), null)
})
test('dueScan: version change -> full; event tiers fire on their trigger', () => {
  assert.equal(dueScan(state, ev({ scrutineerVersion: '2.0' }), 'diff', NOW), 'full')
  assert.equal(dueScan(state, ev({ pushed: true }), 'diff', NOW), 'diff')
  assert.equal(dueScan(state, ev({ pushed: true }), 'pr', NOW), null)
  assert.equal(dueScan(state, ev({ mergedPrs: [{ number: 1 }] }), 'pr', NOW), 'diff')
  assert.equal(dueScan(state, ev({ releases: [{ tag: 'v1' }] }), 'release', NOW), 'diff')
})

let failed = 0
for (const [name, fn] of tests) {
  try { await fn(); console.log('PASS', name) }
  catch (e) { failed++; console.error('FAIL', name, '\n  ', e.message) }
}
console.log(failed ? `\n${failed}/${tests.length} FAILED` : `\nall ${tests.length} passed`)
process.exit(failed ? 1 : 0)
