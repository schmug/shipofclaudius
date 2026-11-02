// Finding lifecycle state machine (spec section 6). Pure: no I/O, no clock. Time comes from ctx.now if ever needed.
// nextAction(snap, entry, ctx) returns exactly one Action { type, note?, reason? }.
// RULES is an ordered list of [predicate, action]; the first match wins, so code order is table order, with these
// deliberate hoists: skip/exclude/parked checks first; PR-state and stage rows before the openScan wait (they enqueue
// nothing); openScan -> wait before every enqueue action; NON_VIABLE/SAMPLE_OR_TEST park before any enqueue.
// park actions always carry a note starting "autopilot: ".

const OUT_OF_SCOPE = new Set(['rejected', 'duplicate', 'published'])
const PR_STAGES = new Set(['stopped', 'opened', 'awaiting_ci', 'skipped'])
const BAD_VIABILITY = new Set(['NON_VIABLE', 'SAMPLE_OR_TEST'])
const GOOD_VIABILITY = new Set(['VIABLE', 'CONDITIONAL_VIABLE'])
const BAD_REVALIDATE = new Set(['false_positive', 'uncertain', 'inconclusive'])
// Stages from which a verified_secure finding may go to the fix workflow. 'parked' is here because a parked entry only
// reaches this point once the finding was updated after the park (a human or Scrutineer acted).
const FIXABLE_STAGES = new Set([undefined, 'triaged', 'patching', 'reattacking', 'parked'])
// Stages whose PR the tick resolves by branch (ctx.prState). A GitHub MERGED state is the only proof of a merge.
const BRANCH_STAGES = new Set([...PR_STAGES, 'held', 'merged', 'failed', 'fixing'])
// 'fixing' is left out: an older closed PR on the same branch must not park a fix that is still in flight.
const CLOSABLE_STAGES = new Set([...PR_STAGES, 'held', 'merged', 'failed'])
const MERGE_PROOF_MS = 24 * 3600e3 // stage 'merged' (from --record) without a MERGED PR for this long parks
const FIXING_MS = 6 * 3600e3 // stage 'fixing' (set when the tick emits a fix item) without a --record for this long parks
const MAX_PATCH_ATTEMPTS = 2
const MAX_REATTACK_RETRIES = 1

const NOTE_AGREE = 'autopilot: revalidate and verify agree'
const NOTE_NO_REVALIDATE = 'autopilot: verify confirmed; no revalidate for this severity'

const act = (type, extra = {}) => ({ type, ...extra })
const park = (note) => act('park', { note: `autopilot: ${note}` })
const time = (s) => { const t = Date.parse(s); return Number.isNaN(t) ? null : t }
// true when `at` is more than `ms` before `now`; unparseable times count as old (fail closed: park, never act).
const olderThan = (at, now, ms) => { const a = time(at), n = time(now); return a === null || n === null || n - a > ms }
const verdicts = (f, verify) => `revalidate=${f.last_revalidate_verdict || 'none'} verify=${verify ?? 'none'}`

function parkedUnchanged(f, entry) {
  if (entry.stage !== 'parked') return false
  const updated = time(f.updated_at)
  const parkedAt = time(entry.parkedAt)
  if (updated === null || parkedAt === null) return true // fail closed: cannot show a human acted
  return updated <= parkedAt
}

// Enqueue guard (Ruling 13): a skill whose scans failed twice is parked; a critic that finished but left
// production_viability empty is parked. snap.attempts may be absent (all zeros).
const MAX_FAILED_SCANS = 2
const attemptsOf = (s, skill) => ({ done: 0, failed: 0, ...(s.attempts?.[skill] ?? {}) })
function enqueue(skill) {
  return (s) => {
    const a = attemptsOf(s, skill)
    if (skill === 'critic' && a.done >= 1) return park('critic finished without a production_viability verdict')
    if (a.failed >= MAX_FAILED_SCANS) return park(`${skill} scan failed ${a.failed} times`)
    return act(skill)
  }
}

const isHigh = (f) => f.severity === 'High' || f.severity === 'Critical'
const isNew = (f) => f.status === 'new' || f.status === 'enriched'

// Each rule: [name, predicate(snap, entry, ctx), action(snap, entry, ctx)]
const RULES = [
  // ---- skip / exclude / parked ----
  ['out of scope status', (s) => OUT_OF_SCOPE.has(s.finding.status), () => act('skip', { reason: 'out of scope' })],
  ['published stage', (s, e) => e.stage === 'published', () => act('skip', { reason: 'already published' })],
  ['policy exclude', (s, e, c) => c.policy === 'exclude', () => act('skip', { reason: 'repo excluded' })],
  ['parked, finding unchanged', (s, e) => parkedUnchanged(s.finding, e), () => act('skip', { reason: 'parked; finding not updated since' })],
  ['acknowledged by hand', (s, e) => s.finding.status === 'acknowledged' && !e.stage, () => act('skip', { reason: 'acknowledged by hand' })],

  // ---- post-fix stages (no enqueue) ----
  ['fix PR merged', (s, e, c) => BRANCH_STAGES.has(e.stage) && c.prState === 'MERGED', () => act('mark_fixed')],
  ['fix PR closed unmerged', (s, e, c) => CLOSABLE_STAGES.has(e.stage) && c.prState === 'CLOSED', () => park('fix PR closed unmerged')],
  ['held fix discarded', (s, e, c) => e.stage === 'held' && !c.heldBranchExists && c.prState !== 'OPEN', () => park('held fix discarded')],
  ['fix PR open or held, waiting for a human', (s, e) => PR_STAGES.has(e.stage) || e.stage === 'held', () => act('wait', { reason: 'fix PR awaiting human' })],
  ['failed with an open fix PR', (s, e, c) => e.stage === 'failed' && c.prState === 'OPEN', () => act('wait', { reason: 'fix PR open after a failed workflow run' })],
  ['stage merged, no MERGED proof', (s, e) => e.stage === 'merged',
    (s, e, c) => (olderThan(e.recordedAt, c.now, MERGE_PROOF_MS) ? park('recorded merge not confirmed on GitHub') : act('wait', { reason: 'recorded merge not yet confirmed on GitHub' }))],
  ['fix workflow in flight', (s, e) => e.stage === 'fixing',
    (s, e, c) => (olderThan(e.emittedAt, c.now, FIXING_MS) ? park('fix workflow never recorded an outcome') : act('wait', { reason: 'fix workflow in flight' }))],
  ['fixed and marked', (s, e) => s.finding.status === 'fixed' && e.stage === 'marked_fixed', () => act('mark_published')],
  ['fixed otherwise', (s) => s.finding.status === 'fixed', () => act('skip', { reason: 'fixed; nothing to do' })],

  // ---- scans in flight: wait before any enqueue ----
  ['open scan', (s) => s.openScan, () => act('wait', { reason: 'open scan on finding' })],

  // ---- viability (any status) ----
  ['non-viable', (s) => BAD_VIABILITY.has(s.finding.production_viability),
    (s) => park(`production viability ${s.finding.production_viability}; no release build affected`)],

  // ---- new / enriched ----
  ['new: already fixed', (s) => isNew(s.finding) && (s.verify === 'fixed' || s.finding.last_revalidate_verdict === 'already_fixed'),
    (s) => park(`already fixed (${verdicts(s.finding, s.verify)})`)],
  ['new: not verified yet', (s) => isNew(s.finding) && s.verify === null, enqueue('verify')],
  ['new: verify not confirmed', (s) => isNew(s.finding) && s.verify !== 'confirmed',
    (s) => park(`verify did not confirm (${verdicts(s.finding, s.verify)})`)],
  ['new: revalidate bad', (s) => isNew(s.finding) && BAD_REVALIDATE.has(s.finding.last_revalidate_verdict),
    (s) => park(`verdicts do not support a fix (${verdicts(s.finding, s.verify)})`)],
  ['new High: no revalidate verdict', (s) => isNew(s.finding) && isHigh(s.finding) && !s.finding.last_revalidate_verdict,
    () => park('no revalidate verdict on a High/Critical finding; revalidate cannot be started from the operator API — triage by hand')],
  ['new High: agree', (s) => isNew(s.finding) && isHigh(s.finding) && s.finding.last_revalidate_verdict === 'true_positive',
    () => act('triage', { note: NOTE_AGREE })],
  ['new High: disagree', (s) => isNew(s.finding) && isHigh(s.finding),
    (s) => park(`verdicts disagree (${verdicts(s.finding, s.verify)})`)],
  ['new Medium/Low: critic first', (s) => isNew(s.finding) && !s.finding.production_viability, enqueue('critic')],
  ['new Medium/Low: viable', (s) => isNew(s.finding) && GOOD_VIABILITY.has(s.finding.production_viability),
    () => act('triage', { note: NOTE_NO_REVALIDATE })],
  ['new Medium/Low: unknown viability', (s) => isNew(s.finding),
    (s) => park(`unrecognised production viability ${s.finding.production_viability}`)],

  // ---- triaged ----
  ['triaged: critic first', (s) => s.finding.status === 'triaged' && !s.finding.production_viability, enqueue('critic')],
  ['triaged: unknown viability', (s) => s.finding.status === 'triaged' && !GOOD_VIABILITY.has(s.finding.production_viability),
    (s) => park(`unrecognised production viability ${s.finding.production_viability}`)],
  ['triaged: no patch', (s) => s.finding.status === 'triaged' && s.patchAttempts === 0, enqueue('patch')],
  ['triaged: no reattack', (s) => s.finding.status === 'triaged' && s.reattack === null, enqueue('reattack')],
  ['triaged: verified_secure, fix workflow ended', (s, e) => s.finding.status === 'triaged' && s.reattack === 'verified_secure' && !FIXABLE_STAGES.has(e.stage),
    (s, e) => park(`fix workflow ended '${e.stage}'`)],
  ['triaged: verified_secure, repo busy', (s, e, c) => s.finding.status === 'triaged' && s.reattack === 'verified_secure' && c.repoHasOpenFixPr,
    () => act('wait', { reason: 'repo already has an open fix PR' })],
  ['triaged: verified_secure', (s) => s.finding.status === 'triaged' && s.reattack === 'verified_secure', () => act('fix')],
  ['triaged: bypassed, retry patch', (s) => s.finding.status === 'triaged' && s.reattack === 'bypassed_patch' && s.patchAttempts < MAX_PATCH_ATTEMPTS,
    enqueue('patch')],
  ['triaged: bypassed, out of attempts', (s) => s.finding.status === 'triaged' && s.reattack === 'bypassed_patch',
    (s) => park(`patch bypassed after ${s.patchAttempts} attempts`)],
  ['triaged: incomplete, retry reattack', (s, e) => s.finding.status === 'triaged' && s.reattack === 'verification_incomplete' && (e.reattackRetries ?? 0) < MAX_REATTACK_RETRIES,
    enqueue('reattack')],
  ['triaged: incomplete, out of retries', (s) => s.finding.status === 'triaged' && s.reattack === 'verification_incomplete',
    () => park('reattack verification incomplete after retry')],
]

export function nextAction(snap, entry, ctx) {
  const e = entry ?? {}
  for (const [, pred, action] of RULES) if (pred(snap, e, ctx)) return action(snap, e, ctx)
  return act('skip', { reason: 'no rule matched' })
}
