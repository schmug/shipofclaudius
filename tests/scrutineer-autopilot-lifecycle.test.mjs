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
test('High confirmed, no revalidate verdict -> park with exact note', () => {
  assert.deepEqual(run(snap({}, { verify: 'confirmed' })), { type: 'park', note: 'autopilot: no revalidate verdict on a High/Critical finding; revalidate cannot be started from the operator API — triage by hand' })
})
test('verified_secure with workflow-outcome stage: failed/unknown -> park verbatim; skipped -> wait; triaged-like -> fix', () => {
  const s = snap({ status: 'triaged', production_viability: 'VIABLE' }, { patchAttempts: 1, reattack: 'verified_secure' })
  assert.deepEqual(run(s, { stage: 'failed' }), { type: 'park', note: "autopilot: fix workflow ended 'failed'" })
  assert.deepEqual(run(s, { stage: 'weird' }), { type: 'park', note: "autopilot: fix workflow ended 'weird'" })
  assert.equal(run(s, { stage: 'skipped' }).type, 'wait')
  assert.equal(run(s, { stage: 'skipped' }, { prState: 'OPEN' }).type, 'wait')
  for (const stage of [undefined, 'triaged', 'patching', 'reattacking']) assert.equal(run(s, { stage }).type, 'fix')
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
test('a finished patch with no gated fix parks with its reason instead of asking for a reattack', () => {
  const f = { status: 'triaged', production_viability: 'VIABLE', suggested_fix: '' }
  assert.deepEqual(run(snap(f, { patchAttempts: 1, patchRefused: 'finding already fixed upstream; no duplicate patch produced' })),
    { type: 'park', note: 'autopilot: patch produced no fix: finding already fixed upstream; no duplicate patch produced' })
  assert.deepEqual(run(snap(f, { patchAttempts: 1 })), { type: 'park', note: 'autopilot: patch produced no fix: no gated suggested_fix' })
  assert.equal(run(snap({ ...f, suggested_fix: 'diff --git a/x b/x' }, { patchAttempts: 1 })).type, 'reattack')
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
test('stage merged + PR MERGED -> mark_fixed; fixed + marked_fixed -> mark_published', () => {
  assert.equal(run(snap({ status: 'triaged' }), { stage: 'merged', recordedAt: '2026-10-19T23:00:00Z' }, { prState: 'MERGED' }).type, 'mark_fixed')
  assert.equal(run(snap({ status: 'fixed' }), { stage: 'marked_fixed' }).type, 'mark_published')
})
test('I1: stage merged without GitHub MERGED proof -> wait; after 24h -> park; CLOSED -> park', () => {
  const s = snap({ status: 'triaged' })
  const fresh = { stage: 'merged', recordedAt: '2026-10-19T12:00:00Z' } // 12h before ctx.now
  for (const prState of [null, 'OPEN']) assert.equal(run(s, fresh, { prState }).type, 'wait', String(prState))
  const old = { stage: 'merged', recordedAt: '2026-10-18T23:00:00Z' } // 25h before ctx.now
  assert.deepEqual(run(s, old, { prState: null }), { type: 'park', note: 'autopilot: recorded merge not confirmed on GitHub' })
  assert.deepEqual(run(s, { stage: 'merged' }, { prState: null }), { type: 'park', note: 'autopilot: recorded merge not confirmed on GitHub' })
  assert.deepEqual(run(s, fresh, { prState: 'CLOSED' }), { type: 'park', note: 'autopilot: fix PR closed unmerged' })
})
test('I4: stage failed with an OPEN PR -> wait (not park); with a MERGED PR -> mark_fixed; no PR -> park', () => {
  const s = snap({ status: 'triaged', production_viability: 'VIABLE' }, { patchAttempts: 1, reattack: 'verified_secure' })
  assert.equal(run(s, { stage: 'failed' }, { prState: 'OPEN' }).type, 'wait')
  assert.equal(run(s, { stage: 'failed' }, { prState: 'MERGED' }).type, 'mark_fixed')
  assert.deepEqual(run(s, { stage: 'failed' }, { prState: null }), { type: 'park', note: "autopilot: fix workflow ended 'failed'" })
})
test('I6: stage fixing -> wait for 6h, then park; a MERGED PR -> mark_fixed; an old CLOSED PR does not park', () => {
  const s = snap({ status: 'triaged', production_viability: 'VIABLE' }, { patchAttempts: 1, reattack: 'verified_secure' })
  const fresh = { stage: 'fixing', emittedAt: '2026-10-19T20:00:00Z' } // 4h before ctx.now
  assert.equal(run(s, fresh).type, 'wait')
  assert.equal(run(s, fresh, { prState: 'CLOSED' }).type, 'wait')
  assert.equal(run(s, fresh, { prState: 'MERGED', prCreatedAt: '2026-10-19T21:00:00Z' }).type, 'mark_fixed')
  const old = { stage: 'fixing', emittedAt: '2026-10-19T17:00:00Z' } // 7h before ctx.now
  assert.deepEqual(run(s, old), { type: 'park', note: 'autopilot: fix workflow never recorded an outcome' })
  assert.deepEqual(run(s, old, { prState: 'CLOSED' }), { type: 'park', note: 'autopilot: fix workflow never recorded an outcome' })
  assert.equal(run(s, old, { prState: 'MERGED', prCreatedAt: '2026-10-19T18:00:00Z' }).type, 'mark_fixed')
})
test('B: merge proof is bound to the attempt for fixing/failed: a PR created before emittedAt does not mark fixed', () => {
  const s = snap({ status: 'triaged', production_viability: 'VIABLE' }, { patchAttempts: 1, reattack: 'verified_secure' })
  const emittedAt = '2026-10-19T20:00:00Z'
  const oldPr = { prState: 'MERGED', prCreatedAt: '2026-10-01T00:00:00Z', prMergedAt: '2026-10-02T00:00:00Z' }
  const newPr = { prState: 'MERGED', prCreatedAt: '2026-10-19T21:00:00Z', prMergedAt: '2026-10-19T22:00:00Z' }
  assert.equal(run(s, { stage: 'fixing', emittedAt }, oldPr).type, 'wait')
  assert.equal(run(s, { stage: 'fixing', emittedAt }, newPr).type, 'mark_fixed')
  assert.notEqual(run(s, { stage: 'fixing' }, newPr).type, 'mark_fixed', 'fixing without emittedAt never accepts a merge')
  assert.notEqual(run(s, { stage: 'fixing', emittedAt }, { prState: 'MERGED' }).type, 'mark_fixed', 'unknown createdAt fails closed')
  assert.deepEqual(run(s, { stage: 'failed', emittedAt }, oldPr), { type: 'park', note: "autopilot: fix workflow ended 'failed'" })
  assert.equal(run(s, { stage: 'failed', emittedAt }, newPr).type, 'mark_fixed')
  assert.equal(run(snap({ status: 'triaged' }), { stage: 'awaiting_ci', emittedAt }, oldPr).type, 'mark_fixed', 'tick-recorded PR stages unchanged')
})
test('I6 follow-up: stale fixing with an OPEN PR -> wait and adopt stage stopped (no park)', () => {
  const s = snap({ status: 'triaged', production_viability: 'VIABLE' }, { patchAttempts: 1, reattack: 'verified_secure' })
  const a = run(s, { stage: 'fixing', emittedAt: '2026-10-19T17:00:00Z' }, { prState: 'OPEN' })
  assert.deepEqual(a, { type: 'wait', reason: 'fix workflow never recorded an outcome; PR open', setStage: 'stopped' })
})
test('I8 Ruling 12: parked, parkedAt older than updated_at, verified_secure -> fix', () => {
  const s = snap({ status: 'triaged', production_viability: 'VIABLE', updated_at: '2026-10-15T00:00:00Z' }, { patchAttempts: 1, reattack: 'verified_secure' })
  assert.equal(run(s, { stage: 'parked', parkedAt: '2026-10-12T00:00:00Z' }).type, 'fix')
  assert.equal(run(s, { stage: 'parked', parkedAt: '2026-10-16T00:00:00Z' }).type, 'skip')
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
test('skipped + MERGED -> mark_fixed; skipped + CLOSED -> park', () => {
  const s = snap({ status: 'triaged', production_viability: 'VIABLE' }, { patchAttempts: 1, reattack: 'verified_secure' })
  assert.equal(run(s, { stage: 'skipped' }, { prState: 'MERGED' }).type, 'mark_fixed')
  assert.deepEqual(run(s, { stage: 'skipped' }, { prState: 'CLOSED' }), { type: 'park', note: 'autopilot: fix PR closed unmerged' })
})
test('held + OPEN PR + branch missing -> wait; held + MERGED + branch missing -> mark_fixed', () => {
  const s = snap({ status: 'triaged' })
  assert.equal(run(s, { stage: 'held' }, { heldBranchExists: false, prState: 'OPEN' }).type, 'wait')
  assert.equal(run(s, { stage: 'held' }, { heldBranchExists: false, prState: 'MERGED' }).type, 'mark_fixed')
})
const att = (skill, failed, done = 0) => ({ attempts: { verify: { done: 0, failed: 0 }, critic: { done: 0, failed: 0 }, patch: { done: 0, failed: 0 }, reattack: { done: 0, failed: 0 }, [skill]: { done, failed } } })
test('verify failed twice -> park; once -> still verify', () => {
  assert.deepEqual(run(snap({}, att('verify', 2))), { type: 'park', note: 'autopilot: verify scan failed 2 times' })
  assert.equal(run(snap({}, att('verify', 1))).type, 'verify')
})
test('patch failed twice -> park', () => {
  const f = { status: 'triaged', production_viability: 'VIABLE' }
  assert.deepEqual(run(snap(f, att('patch', 2))), { type: 'park', note: 'autopilot: patch scan failed 2 times' })
})
test('critic done but viability still empty -> park; critic failed twice -> park', () => {
  assert.deepEqual(run(snap({ severity: 'Medium' }, { verify: 'confirmed', ...att('critic', 0, 1) })),
    { type: 'park', note: 'autopilot: critic finished without a production_viability verdict' })
  assert.equal(run(snap({ status: 'triaged' }, att('critic', 2))).type, 'park')
})
test('reattack failed once -> still reattack', () => {
  const f = { status: 'triaged', production_viability: 'VIABLE' }
  assert.equal(run(snap(f, { patchAttempts: 1, ...att('reattack', 1) })).type, 'reattack')
})

let failed = 0
for (const [name, fn] of tests) {
  try { await fn(); console.log('PASS', name) }
  catch (e) { failed++; console.error('FAIL', name, '\n  ', e.message) }
}
console.log(failed ? `\n${failed}/${tests.length} FAILED` : `\nall ${tests.length} passed`)
process.exit(failed ? 1 : 0)
