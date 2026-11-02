// Unit tests for the scrutineer-autopilot verdict readers (pure functions over scan rows).
// Mirrors Scrutineer internal/db/remediation.go RemediationPatchStatus.
// Run:  node tests/scrutineer-autopilot-reports.test.mjs
import assert from 'node:assert/strict'
import { skillAttempts, verifyOutcome, latestPatch, patchAttemptCount, reattackStatus } from '../packages/scrutineer-autopilot/src/reports.mjs'

const tests = []
const test = (name, fn) => tests.push([name, fn])

let nextId = 1
const scan = (skill, o = {}) => ({
  id: nextId++, finding_id: 7, skill_name: skill, status: 'done',
  created_at: '2026-10-01T00:00:00Z', finished_at: '2026-10-01T00:10:00Z', report: '', ...o,
})
const variants = (n, extra = []) => [
  ...Array.from({ length: n }, (_, i) => ({ valid: true, outcome: 'blocked', origin: 'generated', input: `in-${i}` })), ...extra]
const clean = (o = {}) => JSON.stringify({
  outcome: 'failed_to_bypass', variants: variants(3),
  benign_control: { reached_sink: true, crashed: false }, ...o,
})
const patch = scan('patch', { created_at: '2026-10-02T00:00:00Z', finished_at: '2026-10-02T01:00:00Z' })
const reattack = (report, o = {}) => scan('reattack', { created_at: '2026-10-03T00:00:00Z', finished_at: '2026-10-03T00:30:00Z', report, ...o })

test('verifyOutcome: JSON string report with status confirmed', () => {
  assert.equal(verifyOutcome([scan('verify', { report: '{"status":"confirmed"}' })], 7), 'confirmed')
})
test('verifyOutcome: object report accepted', () => {
  assert.equal(verifyOutcome([scan('verify', { report: { status: 'fixed' } })], 7), 'fixed')
})
test('verifyOutcome: newest done scan wins; other findings, failed scans and other skills ignored', () => {
  const scans = [
    scan('verify', { report: '{"status":"deferred"}', finished_at: '2026-10-01T00:10:00Z' }),
    scan('verify', { report: '{"status":"fixed"}', finished_at: '2026-10-05T00:10:00Z' }),
    scan('verify', { report: '{"status":"confirmed"}', finished_at: '2026-10-09T00:00:00Z', status: 'failed' }),
    scan('verify', { report: '{"status":"confirmed"}', finished_at: '2026-10-09T00:00:00Z', finding_id: 8 }),
    scan('reattack', { report: '{"status":"confirmed"}', finished_at: '2026-10-09T00:00:00Z' }),
  ]
  assert.equal(verifyOutcome(scans, 7), 'fixed')
})
test('verifyOutcome: null when no scan, empty or unparseable report', () => {
  assert.equal(verifyOutcome([], 7), null)
  assert.equal(verifyOutcome([scan('verify', { report: '' })], 7), null)
  assert.equal(verifyOutcome([scan('verify', { report: '{nope' })], 7), null)
  assert.equal(verifyOutcome([scan('verify', { report: '{"status":"bogus"}' })], 7), null)
})

test('latestPatch / patchAttemptCount: newest done patch, counts only done', () => {
  const p1 = scan('patch', { finished_at: '2026-10-01T00:00:00Z' })
  const p2 = scan('patch', { finished_at: '2026-10-04T00:00:00Z' })
  const pf = scan('patch', { finished_at: '2026-10-09T00:00:00Z', status: 'failed' })
  assert.deepEqual(latestPatch([p1, p2, pf], 7), { scanId: p2.id, finishedAt: '2026-10-04T00:00:00Z' })
  assert.equal(patchAttemptCount([p1, p2, pf], 7), 2)
  assert.equal(latestPatch([], 7), null)
  assert.equal(patchAttemptCount([], 7), 0)
})

test('reattackStatus: null with no patch or no reattack after it', () => {
  assert.equal(reattackStatus([reattack(clean())], 7), null)
  assert.equal(reattackStatus([patch], 7), null)
})
test('reattackStatus: reattack created before the latest patch is ignored', () => {
  const old = reattack(clean(), { created_at: '2026-10-01T00:00:00Z' })
  assert.equal(reattackStatus([old, patch], 7), null)
})
test('reattackStatus: clean report with 3 valid blocked variants and passed control is verified_secure', () => {
  assert.equal(reattackStatus([patch, reattack(clean())], 7), 'verified_secure')
})
test('reattackStatus: only 2 valid blocked variants is verification_incomplete', () => {
  assert.equal(reattackStatus([patch, reattack(clean({ variants: variants(2, [{ valid: false, outcome: 'blocked' }, { valid: true, outcome: 'invalid' }]) }))], 7), 'verification_incomplete')
})
test('reattackStatus: benign control crashed or not reaching sink is verification_incomplete', () => {
  assert.equal(reattackStatus([patch, reattack(clean({ benign_control: { reached_sink: true, crashed: true } }))], 7), 'verification_incomplete')
  assert.equal(reattackStatus([patch, reattack(clean({ benign_control: { reached_sink: false, crashed: false } }))], 7), 'verification_incomplete')
  assert.equal(reattackStatus([patch, reattack(clean({ benign_control: undefined }))], 7), 'verification_incomplete')
})
test('reattackStatus: inconclusive outcome is verification_incomplete', () => {
  assert.equal(reattackStatus([patch, reattack(clean({ outcome: 'inconclusive' }))], 7), 'verification_incomplete')
})
test('reattackStatus: top-level bypassed_patch outcome', () => {
  assert.equal(reattackStatus([patch, reattack(clean({ outcome: 'bypassed_patch' }))], 7), 'bypassed_patch')
})
test('reattackStatus: any bypassed variant wins even if outcome says failed_to_bypass', () => {
  assert.equal(reattackStatus([patch, reattack(clean({ variants: variants(3, [{ valid: true, outcome: 'bypassed' }]) }))], 7), 'bypassed_patch')
})
test('reattackStatus: bypass is sticky; older bypass then newer clean report stays bypassed_patch', () => {
  const bypass = reattack(clean({ outcome: 'bypassed_patch' }), { created_at: '2026-10-03T00:00:00Z', finished_at: '2026-10-03T00:30:00Z' })
  const later = reattack(clean(), { created_at: '2026-10-04T00:00:00Z', finished_at: '2026-10-04T00:30:00Z' })
  assert.equal(reattackStatus([patch, later, bypass], 7), 'bypassed_patch')
})
test('reattackStatus: unparseable newest report fails closed; failed scans and other findings ignored', () => {
  assert.equal(reattackStatus([patch, reattack('{nope')], 7), 'verification_incomplete')
  assert.equal(reattackStatus([patch, reattack(clean(), { status: 'failed' }), reattack(clean(), { finding_id: 8 })], 7), null)
})
test('reattackStatus: compares times by Date.parse, not string order', () => {
  const p = scan('patch', { finished_at: '2026-10-02T01:00:00+02:00' }) // = 2026-10-01T23:00Z
  const r = reattack(clean(), { created_at: '2026-10-01T23:30:00Z' })   // after p, string-sorts before it
  assert.equal(reattackStatus([p, r], 7), 'verified_secure')
})

test('reattackStatus: only valid generated blocked variants count (2 generated + 1 prior_bypass is incomplete)', () => {
  const v = variants(2, [{ valid: true, outcome: 'blocked', origin: 'prior_bypass', input: 'pb' }])
  assert.equal(reattackStatus([patch, reattack(clean({ variants: v }))], 7), 'verification_incomplete')
})
test('reattackStatus: duplicate generated input after trim invalidates the report', () => {
  const v = variants(2, [{ valid: true, outcome: 'blocked', origin: 'generated', input: '  in-0 ' }])
  assert.equal(reattackStatus([patch, reattack(clean({ variants: v }))], 7), 'verification_incomplete')
})
test('reattackStatus: newest report inconclusive with an older clean report is verification_incomplete', () => {
  const older = reattack(clean(), { created_at: '2026-10-03T00:00:00Z', finished_at: '2026-10-03T00:30:00Z' })
  const newer = reattack(clean({ outcome: 'inconclusive' }), { created_at: '2026-10-04T00:00:00Z', finished_at: '2026-10-04T00:30:00Z' })
  assert.equal(reattackStatus([patch, older, newer], 7), 'verification_incomplete')
})

test('skillAttempts: counts done vs failed/cancelled for the finding and skill only', () => {
  const s = [scan('verify'), scan('verify', { status: 'failed' }), scan('verify', { status: 'cancelled' }), scan('verify', { status: 'running' }),
    scan('verify', { finding_id: 8, status: 'failed' }), scan('patch', { status: 'failed' })]
  assert.deepEqual(skillAttempts(s, 7, 'verify'), { done: 1, failed: 2 })
  assert.deepEqual(skillAttempts([], 7, 'verify'), { done: 0, failed: 0 })
})
test('skillAttempts: since keeps only scans created after it', () => {
  const s = [scan('reattack', { status: 'failed', created_at: '2026-10-01T00:00:00Z' }), scan('reattack', { status: 'failed', created_at: '2026-10-05T00:00:00Z' }),
    scan('reattack', { created_at: '2026-10-06T00:00:00Z' })]
  assert.deepEqual(skillAttempts(s, 7, 'reattack', { since: '2026-10-02T00:00:00Z' }), { done: 1, failed: 1 })
})

// ---- runner ----
let failed = 0
for (const [name, fn] of tests) {
  try { await fn(); console.log('PASS', name) }
  catch (e) { failed++; console.error('FAIL', name, '\n  ', e.message) }
}
console.log(failed ? `\n${failed}/${tests.length} FAILED` : `\nall ${tests.length} passed`)
process.exit(failed ? 1 : 0)
