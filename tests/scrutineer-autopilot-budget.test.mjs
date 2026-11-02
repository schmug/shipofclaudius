// Unit tests for the scrutineer-autopilot codexbar headroom gate and cost estimates.
// Fixtures are real codexbar output (2026-11-02) with personal fields redacted.
// Run:  node tests/scrutineer-autopilot-budget.test.mjs
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { readUsage, estimate, calibrate, canStart, diffGroupCost } from '../packages/scrutineer-autopilot/src/budget.mjs'
import { DEFAULTS } from '../packages/scrutineer-autopilot/src/config.mjs'

const tests = []
const test = (name, fn) => tests.push([name, fn])
const B = DEFAULTS.budget
const fx = (n) => readFile(new URL(`./fixtures/codexbar-${n}.json`, import.meta.url), 'utf8')
const execOf = (out) => async () => out
const MIN = 60_000

test('readUsage: real claude fixture -> ok with numeric windows', async () => {
  const raw = await fx('claude')
  const now = new Date(JSON.parse(raw)[0].usage.updatedAt).getTime() + 5 * MIN
  const u = await readUsage('claude', { exec: execOf(raw), now: () => now })
  assert.equal(u.ok, true)
  assert.equal(typeof u.weeklyUsed, 'number')
  assert.equal(u.weeklyUsed, 24)
  assert.equal(u.primaryUsed, 0)
})
test('readUsage: real codex fixture -> ok, weekly from secondary, primary missing', async () => {
  const raw = await fx('codex')
  const now = new Date(JSON.parse(raw)[0].usage.updatedAt).getTime() + 29 * MIN
  const u = await readUsage('codex', { exec: execOf(raw), now: () => now })
  assert.equal(u.ok, true)
  assert.equal(u.weeklyUsed, 1)
  assert.equal(u.primaryUsed, 0)
  assert.equal(u.primaryMissing, true)
})
test('readUsage: runs codexbar with the provider and json format', async () => {
  const raw = await fx('claude')
  let seen
  await readUsage('claude', { exec: async (c, a) => { seen = [c, ...a]; return raw }, now: () => Date.parse('2026-11-02T00:50:00Z') })
  assert.deepEqual(seen, ['codexbar', 'usage', '--provider', 'claude', '--format', 'json'])
})
test('readUsage: 31 minutes after updatedAt -> stale', async () => {
  for (const p of ['claude', 'codex']) {
    const raw = await fx(p)
    const now = new Date(JSON.parse(raw)[0].usage.updatedAt).getTime() + 31 * MIN
    const u = await readUsage(p, { exec: execOf(raw), now: () => now })
    assert.equal(u.ok, false)
    assert.match(u.reason, /stale/)
  }
})
test('readUsage: [], plain text, missing provider, missing weekly window -> ok:false', async () => {
  const now = () => Date.parse('2026-11-02T00:50:00Z')
  const codexOnly = await fx('codex')
  for (const out of ['[]', 'error: not signed in', codexOnly]) {
    const u = await readUsage('claude', { exec: execOf(out), now })
    assert.equal(u.ok, false, out.slice(0, 20))
    assert.equal(typeof u.reason, 'string')
  }
  const noWeekly = JSON.stringify([{ provider: 'claude', usage: { updatedAt: '2026-11-02T00:42:59Z', primary: { usedPercent: 3, windowMinutes: 300 } } }])
  assert.equal((await readUsage('claude', { exec: execOf(noWeekly), now })).ok, false)
})
test('readUsage: exec failure -> ok:false, never throws', async () => {
  const u = await readUsage('codex', { exec: async () => { throw new Error('ENOENT') }, now: () => 0 })
  assert.equal(u.ok, false)
})
test('readUsage: real primary window is used when present and not synthetic', async () => {
  const raw = JSON.stringify([{ provider: 'codex', usage: { updatedAt: '2026-11-02T00:42:59Z',
    primary: { usedPercent: 42, windowMinutes: 300 }, secondary: { usedPercent: 7, windowMinutes: 10080 } } }])
  const u = await readUsage('codex', { exec: execOf(raw), now: () => Date.parse('2026-11-02T00:50:00Z') })
  assert.deepEqual([u.weeklyUsed, u.primaryUsed, u.primaryMissing], [7, 42, undefined])
})

test('canStart: 60 + 2 + 5 <= 70 -> ok', () => {
  assert.equal(canStart({ ok: true, weeklyUsed: 60, primaryUsed: 10 }, 4, 0.5, B).ok, true)
})
test('canStart: 64 + 2 + 5 > 70 -> weekly reason', () => {
  const r = canStart({ ok: true, weeklyUsed: 64, primaryUsed: 10 }, 4, 0.5, B)
  assert.equal(r.ok, false)
  assert.match(r.reason, /weekly/)
})
test('canStart: 79 + 2 > 80 -> primary reason', () => {
  const r = canStart({ ok: true, weeklyUsed: 10, primaryUsed: 79 }, 4, 0.5, B)
  assert.equal(r.ok, false)
  assert.match(r.reason, /primary/)
})
test('canStart: unusable usage fails closed', () => {
  const r = canStart({ ok: false, reason: 'stale' }, 1, 0.5, B)
  assert.equal(r.ok, false)
  assert.match(r.reason, /stale/)
})
test('canStart: primaryMissing passes the primary check', () => {
  assert.equal(canStart({ ok: true, weeklyUsed: 1, primaryUsed: 0, primaryMissing: true }, 4, 0.5, B).ok, true)
})

const at = (d) => new Date(Date.parse('2026-11-01T00:00:00Z') - d * 86_400_000).toISOString()
test('calibrate: 19 samples -> seed', () => {
  const s = Array.from({ length: 19 }, (_, i) => ({ at: at(19 - i), weeklyUsed: i, dollars: 4 }))
  assert.equal(calibrate(s, Date.parse('2026-11-01T00:00:00Z')), 0.5)
})
test('calibrate: 20 linear samples at 1% per $4 -> 0.25', () => {
  const s = Array.from({ length: 20 }, (_, i) => ({ at: at(0.5 * (20 - i)), weeklyUsed: i, dollars: 4 }))
  assert.ok(Math.abs(calibrate(s, Date.parse('2026-11-01T00:00:00Z')) - 0.25) < 0.01)
})
test('calibrate: samples older than 14 days are ignored; non-positive fit -> seed', () => {
  const now = Date.parse('2026-11-01T00:00:00Z')
  const old = Array.from({ length: 20 }, (_, i) => ({ at: at(30 - i * 0.1), weeklyUsed: i, dollars: 4 }))
  assert.equal(calibrate(old, now), 0.5)
  const flat = Array.from({ length: 20 }, (_, i) => ({ at: at(0.5 * (20 - i)), weeklyUsed: 10, dollars: 4 }))
  assert.equal(calibrate(flat, now), 0.5)
})
test('calibrate: a weekly reset (usage drops) is skipped, not fitted', () => {
  const now = Date.parse('2026-11-01T00:00:00Z')
  const s = Array.from({ length: 20 }, (_, i) => ({ at: at(0.5 * (20 - i)), weeklyUsed: i < 10 ? i : i - 10, dollars: 4 }))
  assert.ok(Math.abs(calibrate(s, now) - 0.25) < 0.01)
})

const sc = (o) => ({ status: 'done', repository_id: 1, skill_name: 'patch', cost_usd: 1, created_at: '2026-10-01T00:00:00Z', ...o })
test('estimate: no history -> fallbacks (diff 5, full 15, finding skills 1)', () => {
  assert.equal(estimate([], { repoId: 1, kind: 'diff' }), 5)
  assert.equal(estimate([], { repoId: 1, kind: 'full' }), 15)
  for (const k of ['verify', 'critic', 'patch', 'reattack']) assert.equal(estimate([], { repoId: 1, kind: k }), 1)
})
test('estimate: p75 of last 10 positive costs for repo+kind, then instance-wide', () => {
  const mk = (cost, day, repo = 1) => sc({ repository_id: repo, cost_usd: cost, created_at: `2026-10-${String(day).padStart(2, '0')}T00:00:00Z` })
  // 12 repo scans; the two oldest (100) fall outside the last 10; zero costs are ignored.
  const repo = [mk(100, 1), mk(100, 2), ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((c, i) => mk(c, 3 + i)), mk(0, 20)]
  assert.equal(estimate(repo, { repoId: 1, kind: 'patch' }), 8)
  const other = [mk(10, 1, 2), mk(20, 2, 2)]
  assert.equal(estimate(other, { repoId: 1, kind: 'patch' }), 20)
  assert.equal(estimate([mk(9, 1, 2)], { repoId: 1, kind: 'verify' }), 1)
})
test('estimate: failed scans are ignored', () => {
  assert.equal(estimate([sc({ status: 'failed', cost_usd: 50 })], { repoId: 1, kind: 'patch' }), 1)
})

test('diffGroupCost: scan_group present groups on it; otherwise repo + 2h window', () => {
  const t = (h) => new Date(Date.parse('2026-10-01T00:00:00Z') + h * 3_600_000).toISOString()
  const d = (cost, h, extra = {}) => sc({ skill_name: 'security-diff-scan', cost_usd: cost, created_at: t(h), ...extra })
  const noGroup = [d(1, 0), d(2, 1), d(4, 5), d(8, 5.5), d(100, 0, { repository_id: 2 }), sc({ skill_name: 'verify', cost_usd: 50, created_at: t(0) })]
  assert.deepEqual(diffGroupCost(noGroup, 1), [3, 12])
  const grouped = [d(1, 0, { scan_group: 'g1' }), d(2, 10, { scan_group: 'g1' }), d(4, 11, { scan_group: 'g2' })]
  assert.deepEqual(diffGroupCost(grouped, 1), [3, 4])
})
test('estimate: diff uses group sums, not single scan costs', () => {
  const t = (h) => new Date(Date.parse('2026-10-01T00:00:00Z') + h * 3_600_000).toISOString()
  const s = [sc({ skill_name: 'security-diff-scan', cost_usd: 2, created_at: t(0) }), sc({ skill_name: 'security-diff-scan', cost_usd: 3, created_at: t(1) })]
  assert.equal(estimate(s, { repoId: 1, kind: 'diff' }), 5)
})

// ---- runner ----
let failed = 0
for (const [name, fn] of tests) {
  try { await fn(); console.log('PASS', name) }
  catch (e) { failed++; console.error('FAIL', name, '\n  ', e.message) }
}
console.log(failed ? `\n${failed}/${tests.length} FAILED` : `\nall ${tests.length} passed`)
process.exit(failed ? 1 : 0)
