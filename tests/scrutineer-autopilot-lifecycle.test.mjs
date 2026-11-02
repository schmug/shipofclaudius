// Unit tests for the scrutineer-autopilot lifecycle state machine (pure; spec section 6).
// Run:  node tests/scrutineer-autopilot-lifecycle.test.mjs
import assert from 'node:assert/strict'
import { nextAction } from '../packages/scrutineer-autopilot/src/lifecycle.mjs'

const tests = []
const test = (name, fn) => tests.push([name, fn])

const finding = (o = {}) => ({
  status: 'new', severity: 'High', last_revalidate_verdict: '', production_viability: '',
  breaking_change: '', updated_at: '2026-10-10T00:00:00Z', ...o,
})
const snap = (f = {}, o = {}) => ({ finding: finding(f), verify: null, reattack: null, patchAttempts: 0, openScan: false, ...o })
const ctx = (o = {}) => ({ policy: 'auto', repoHasOpenFixPr: false, prState: null, heldBranchExists: false, now: '2026-10-20T00:00:00Z', ...o })
const run = (s, e = {}, c = {}) => nextAction(s, e, ctx(c))

test('new, no verification, no open scan -> verify', () => {
  assert.equal(run(snap()).type, 'verify')
})
test('new, open scan -> wait (before any enqueue)', () => {
  assert.equal(run(snap({}, {}), {}, {}).type, 'verify')
  assert.equal(run(snap({}, { openScan: true })).type, 'wait')
  assert.equal(run(snap({ status: 'triaged' }, { openScan: true })).type, 'wait')
})
test('High true_positive + confirmed -> triage with exact note', () => {
  const a = run(snap({ last_revalidate_verdict: 'true_positive' }, { verify: 'confirmed' }))
  assert.deepEqual(a, { type: 'triage', note: 'autopilot: revalidate and verify agree' })
})
test('High confirmed, revalidate not yet recorded -> wait', () => {
  assert.equal(run(snap({}, { verify: 'confirmed' })).type, 'wait')
})
test('Medium confirmed with empty viability -> critic; VIABLE -> triage with exact note', () => {
  assert.equal(run(snap({ severity: 'Medium' }, { verify: 'confirmed' })).type, 'critic')
  const a = run(snap({ severity: 'Medium', production_viability: 'VIABLE' }, { verify: 'confirmed' }))
  assert.deepEqual(a, { type: 'triage', note: 'autopilot: verify confirmed; no revalidate for this severity' })
})
test('CONDITIONAL_VIABLE proceeds', () => {
  assert.equal(run(snap({ severity: 'Low', production_viability: 'CONDITIONAL_VIABLE' }, { verify: 'confirmed' })).type, 'triage')
})
for (const rv of ['false_positive', 'uncertain', 'inconclusive']) {
  test(`revalidate ${rv} -> park quoting both verdicts`, () => {
    const a = run(snap({ last_revalidate_verdict: rv }, { verify: 'confirmed' }))
    assert.equal(a.type, 'park')
    assert.ok(a.note.startsWith('autopilot: '))
    assert.ok(a.note.includes(rv) && a.note.includes('confirmed'))
  })
}
test('verify inconclusive -> park quoting both verdicts', () => {
  const a = run(snap({ last_revalidate_verdict: 'true_positive' }, { verify: 'inconclusive' }))
  assert.equal(a.type, 'park')
  assert.ok(a.note.includes('true_positive') && a.note.includes('inconclusive'))
})
test('disagreement (verify fixed vs true_positive, already_fixed) -> park', () => {
  assert.equal(run(snap({ last_revalidate_verdict: 'true_positive' }, { verify: 'fixed' })).type, 'park')
  assert.equal(run(snap({ last_revalidate_verdict: 'already_fixed' }, { verify: 'confirmed' })).type, 'park')
})
test('NON_VIABLE and SAMPLE_OR_TEST -> park', () => {
  for (const v of ['NON_VIABLE', 'SAMPLE_OR_TEST']) {
    const a = run(snap({ status: 'triaged', production_viability: v }, { patchAttempts: 1 }))
    assert.equal(a.type, 'park'); assert.ok(a.note.startsWith('autopilot: ') && a.note.includes(v))
  }
})
test('triaged, empty viability -> critic', () => {
  assert.equal(run(snap({ status: 'triaged', severity: 'Low' })).type, 'critic')
})
test('triaged with patchAttempts 0 -> patch; with patch and reattack null -> reattack', () => {
  const f = { status: 'triaged', production_viability: 'VIABLE' }
  assert.equal(run(snap(f)).type, 'patch')
  assert.equal(run(snap(f, { patchAttempts: 1 })).type, 'reattack')
})
test('verified_secure: no open fix PR -> fix; open fix PR -> wait', () => {
  const s = snap({ status: 'triaged', production_viability: 'VIABLE' }, { patchAttempts: 1, reattack: 'verified_secure' })
  assert.equal(run(s).type, 'fix')
  assert.equal(run(s, {}, { repoHasOpenFixPr: true }).type, 'wait')
})
test('bypassed_patch: <2 attempts -> patch; >=2 -> park', () => {
  const f = { status: 'triaged', production_viability: 'VIABLE' }
  assert.equal(run(snap(f, { patchAttempts: 1, reattack: 'bypassed_patch' })).type, 'patch')
  const a = run(snap(f, { patchAttempts: 2, reattack: 'bypassed_patch' }))
  assert.equal(a.type, 'park'); assert.ok(a.note.startsWith('autopilot: '))
})
test('verification_incomplete: first time -> reattack; after one retry -> park', () => {
  const s = snap({ status: 'triaged', production_viability: 'VIABLE' }, { patchAttempts: 1, reattack: 'verification_incomplete' })
  assert.equal(run(s).type, 'reattack')
  assert.equal(run(s, { reattackRetries: 1 }).type, 'park')
})
test('parked and not updated since -> skip; updated after parkedAt -> resumes', () => {
  const e = { stage: 'parked', parkedAt: '2026-10-10T00:00:00Z' }
  assert.equal(run(snap(), e).type, 'skip')
  assert.equal(run(snap({ updated_at: '2026-10-11T00:00:00Z' }), e).type, 'verify')
})
test('stopped/opened/awaiting_ci: MERGED -> mark_fixed; CLOSED -> park with exact note; OPEN -> wait', () => {
  for (const stage of ['stopped', 'opened', 'awaiting_ci']) {
    const s = snap({ status: 'triaged' })
    assert.equal(run(s, { stage }, { prState: 'MERGED' }).type, 'mark_fixed')
    assert.deepEqual(run(s, { stage }, { prState: 'CLOSED' }), { type: 'park', note: 'autopilot: fix PR closed unmerged' })
    assert.equal(run(s, { stage }, { prState: 'OPEN' }).type, 'wait')
  }
})
test('held: branch gone -> park with exact note; PR merged -> mark_fixed; branch present -> wait', () => {
  const s = snap({ status: 'triaged' })
  assert.deepEqual(run(s, { stage: 'held' }, { heldBranchExists: false }), { type: 'park', note: 'autopilot: held fix discarded' })
  assert.equal(run(s, { stage: 'held' }, { heldBranchExists: false, prState: 'MERGED' }).type, 'mark_fixed')
  assert.equal(run(s, { stage: 'held' }, { heldBranchExists: true }).type, 'wait')
})
test('stage merged -> mark_fixed; fixed + marked_fixed -> mark_published', () => {
  assert.equal(run(snap({ status: 'triaged' }), { stage: 'merged' }).type, 'mark_fixed')
  assert.equal(run(snap({ status: 'fixed' }), { stage: 'marked_fixed' }).type, 'mark_published')
})
test('stage published -> skip', () => {
  assert.equal(run(snap({ status: 'fixed' }), { stage: 'published' }).type, 'skip')
})
test('acknowledged without an entry -> skip', () => {
  assert.equal(run(snap({ status: 'acknowledged' })).type, 'skip')
})
test('policy exclude -> skip, ahead of everything', () => {
  assert.equal(run(snap(), {}, { policy: 'exclude' }).type, 'skip')
  assert.equal(run(snap({ status: 'fixed' }), { stage: 'marked_fixed' }, { policy: 'exclude' }).type, 'skip')
})
test('rejected/duplicate/published status -> skip', () => {
  for (const status of ['rejected', 'duplicate', 'published']) assert.equal(run(snap({ status })).type, 'skip')
})
test('verify fixed or already_fixed -> park with autopilot note', () => {
  const a = run(snap({}, { verify: 'fixed' }))
  assert.equal(a.type, 'park'); assert.ok(a.note.startsWith('autopilot: '))
})

let failed = 0
for (const [name, fn] of tests) {
  try { await fn(); console.log('PASS', name) }
  catch (e) { failed++; console.error('FAIL', name, '\n  ', e.message) }
}
console.log(failed ? `\n${failed}/${tests.length} FAILED` : `\nall ${tests.length} passed`)
process.exit(failed ? 1 : 0)
