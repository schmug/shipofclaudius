// One autopilot tick (spec §5–§11). Model-free: Scrutineer through the injected client, gh / codexbar /
// `scrutineer --version` through the injected exec, the clock through `now`.
// Invariants:
// - One function per order step (step1..step8 below); runTick only sequences them.
// - Before every finding POST, re-read the finding: skip if status or updated_at moved since the list read,
//   or if its repository_id does not map to an allowlisted <owner>/<name> key (spec §11). The ledger's
//   own `repo` field is never trusted for a write.
// - Dry run and paused do every GET, no POST and no ledger save; the client is wrapped by dryRunClient so a
//   stray POST throws. Aborts (scrutineer-down / -too-old / budget-unavailable) save nothing and write no run file.
// - The operator token lives only inside the client; nothing here can see it.
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { repoKey, policyFor } from './config.mjs'
import { ScrutineerTooOld } from './client.mjs'
import { verifyOutcome, latestPatch, patchAttemptCount, reattackStatus, skillAttempts } from './reports.mjs'
import { readUsage, estimate, calibrate, canStart } from './budget.mjs'
import { nextAction } from './lifecycle.mjs'
import { openLedger, acquireLock, isPaused, writeRun } from './ledger.mjs'
import { pollRepo, requiredChecks, prForBranch } from './github.mjs'
import { chooseTiers, dueScan } from './tiers.mjs'

const DAY = 86400e3
const OUT_OF_SCOPE = new Set(['rejected', 'duplicate', 'published'])
const PR_STAGES = new Set(['stopped', 'opened', 'awaiting_ci', 'skipped', 'held'])
const OPEN_FIX_STAGES = new Set(['stopped', 'opened', 'awaiting_ci', 'held'])
const ENQUEUE = new Set(['verify', 'critic', 'patch', 'reattack'])
const SEVERITY_RANK = { Critical: 0, High: 1, Medium: 2, Low: 3 }
const OPEN = new Set(['queued', 'running'])
const TERMINAL = new Set(['done', 'failed', 'cancelled'])
const REQUIRED = ['last_revalidate_verdict', 'production_viability', 'suggested_fix', 'breaking_change']
// The scan export shows no queued/running rows (observed 2026-11-01), so our own enqueues count as open
// until a terminal row appears, capped so a lost scan cannot stall a finding or the instance forever.
const PENDING_SCAN_MS = 24 * 3600e3
const PENDING_GROUP_MS = 6 * 3600e3
const EVENT_WINDOW_MS = 28 * DAY
const CADENCE_MS = { weekly: 7 * DAY, monthly: 30 * DAY }
const NOTE_PUBLISHED = 'autopilot: fix PR is the record; no advisory'
const POST_METHODS = ['runFindingSkill', 'setStatus', 'addNote', 'scanRepo']
export const RELAY_FIELDS = Object.freeze(['title', 'severity', 'location', 'cwe', 'suggested_fix', 'suggested_fix_commit', 'breaking_change', 'breaking_change_rationale'])
export const OUTCOMES = Object.freeze(['merged', 'awaiting_ci', 'held', 'stopped', 'failed', 'skipped'])
export const STOP_RULES = Object.freeze(['security_review', 'breaking_change', 'behaviour', 'no_gate', 'merge_escalated', 'policy_stop'])
export const EXIT = Object.freeze({ ok: 0, paused: 0, locked: 0, 'scrutineer-too-old': 2, 'scrutineer-down': 2, 'budget-unavailable': 2 })

const toMs = (now) => (typeof now === 'function' ? now() : now instanceof Date ? now.getTime() : now ?? Date.now())
const isoOf = (ms) => (ms == null || !Number.isFinite(ms) ? undefined : new Date(ms).toISOString())
const msg = (e) => String(e?.message ?? e).split('\n')[0]
const exists = (p) => access(p).then(() => true, () => false)
const ownBranch = (id) => `scrutineer/finding-${id}`

export function relayFields(f) {
  return Object.fromEntries(RELAY_FIELDS.map((k) => [k, f[k] ?? '']))
}

// `tick.mjs --record <findingId> <outcome-json>` (Ruling 18): store a scrutineer-fix-pr outcome as the entry's stage.
// Only the outcome enum, the stop_rule enum, the first line of reason (restricted to [A-Za-z0-9 ._:/-], 200 chars) and a held_path computed from stateDir
// are kept. A PR number or URL in the outcome JSON is never stored: the tick resolves the PR by branch. Invalid input
// throws RecordError and writes nothing.
export class RecordError extends Error {}
export async function recordOutcome(stateDir, findingId, outcomeJson, { now = Date.now() } = {}) {
  const id = String(findingId)
  if (!/^\d+$/.test(id)) throw new RecordError(`finding id must be digits, got ${JSON.stringify(id).slice(0, 40)}`)
  let o
  try { o = typeof outcomeJson === 'string' ? JSON.parse(outcomeJson) : outcomeJson } catch { throw new RecordError('outcome is not valid JSON') }
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw new RecordError('outcome must be a JSON object')
  if (!OUTCOMES.includes(o.outcome)) throw new RecordError(`outcome must be one of ${OUTCOMES.join(', ')}`)
  if (o.stop_rule != null && !STOP_RULES.includes(o.stop_rule)) throw new RecordError(`stop_rule must be one of ${STOP_RULES.join(', ')}`)
  const lock = await acquireLock(stateDir, { now: toMs(now) })
  if (!lock.ok) throw new Error('a tick is running (locked); retry after it finishes')
  try {
    const ledger = await openLedger(stateDir)
    const e = (ledger.data.findings[id] ??= {})
    e.stage = o.outcome
    for (const k of ['stop_rule', 'reason', 'held_path']) delete e[k]
    if (o.stop_rule) e.stop_rule = o.stop_rule
    const reason = typeof o.reason === 'string' ? o.reason.split('\n')[0].replace(/[^A-Za-z0-9 ._:/-]/g, '').trim().slice(0, 200) : ''
    if (reason) e.reason = reason
    if (o.outcome === 'held') e.held_path = join(stateDir, 'held', id)
    e.recordedAt = isoOf(toMs(now))
    await ledger.save()
    return e
  } finally {
    await lock.release()
  }
}

// `tick.mjs --digest-sent`: the skill sends at most one waiting-items digest per day, tracked here.
export async function markDigestSent(stateDir, { now = Date.now() } = {}) {
  const lock = await acquireLock(stateDir, { now: toMs(now) })
  if (!lock.ok) throw new Error('a tick is running (locked); retry after it finishes')
  try {
    const ledger = await openLedger(stateDir)
    ledger.data.lastDigestAt = isoOf(toMs(now))
    await ledger.save()
    return ledger.data.lastDigestAt
  } finally {
    await lock.release()
  }
}

// Backstop for dry runs: every POST method throws instead of reaching Scrutineer.
export function dryRunClient(client) {
  const refuse = (m) => async () => { throw new Error(`dry-run: refused POST via ${m}`) }
  return { ...client, ...Object.fromEntries(POST_METHODS.map((m) => [m, refuse(m)])) }
}

// Transport-level guard for the CLI: any non-GET request throws before it leaves the process.
export function dryRunFetch(fetch = globalThis.fetch) {
  return async (url, init = {}) => {
    const method = String(init.method ?? 'GET').toUpperCase()
    if (method !== 'GET') throw new Error(`dry-run: refused ${method} request`)
    return fetch(url, init)
  }
}

export async function runTick({ config, client, exec, now = Date.now(), dryRun = false }) {
  const t = toMs(now)
  const R = { status: 'ok', dryRun: !!dryRun, actions: [], agentItems: [], parked: [], stopped: [], notes: [] }
  const lock = await acquireLock(config.stateDir, { now: t })
  if (!lock.ok) return { ...R, status: 'locked' }
  try {
    const tk = { config, exec, t, iso: isoOf(t), R, budget: config.budget, enqueues: 0, spent: { codex: 0, claude: 0 } }
    const abort = await step1PausedCheck(tk, client, dryRun)
      ?? await step2FeatureDetect(tk)
      ?? await step3Budget(tk)
      ?? await step4Repos(tk)
      ?? await step5Lifecycle(tk)
    if (abort) return { ...R, status: abort }
    await step6Rescans(tk)
    await step7AgentItems(tk)
    await step8Persist(tk)
    return R
  } finally {
    await lock.release()
  }
}

// ---- step 1: lock is held by runTick; paused forces read-only ----
async function step1PausedCheck(tk, client, dryRun) {
  tk.paused = await isPaused(tk.config.stateDir)
  tk.dry = !!dryRun || tk.paused
  tk.client = tk.dry ? dryRunClient(client) : client
  if (tk.paused) { tk.R.status = 'paused'; tk.R.notes.push('paused: read only, nothing written') }
  tk.ledger = await openLedger(tk.config.stateDir)
  return null
}

// ---- step 2: config is already loaded; feature-detect on one finding ----
async function step2FeatureDetect(tk) {
  try {
    const [row] = await tk.client.listFindings({ limit: '1' })
    if (row) await tk.client.getFinding(row.id)
  } catch (e) {
    tk.R.notes.push(msg(e))
    return e instanceof ScrutineerTooOld ? 'scrutineer-too-old' : 'scrutineer-down'
  }
  try { tk.version = (await tk.exec('scrutineer', ['--version'])).trim() || null } catch { tk.version = null } // unknown = unchanged
  return null
}

// ---- step 3: codex and claude usage; the budget sample is appended in step 5 once scan costs are known ----
async function step3Budget(tk) {
  const usage = {}
  for (const p of ['codex', 'claude']) {
    usage[p] = await readUsage(p, { exec: tk.exec, now: tk.t })
    if (!usage[p].ok) tk.R.notes.push(`${p}: usage unavailable (${usage[p].reason}); nothing it pays for starts`)
    else if (usage[p].primaryMissing) tk.R.notes.push(`${p}: 5-hour window missing from codexbar; only the weekly limit gates`)
  }
  tk.usage = usage
  tk.ppd = { codex: calibrate(tk.ledger.data.budgetSamples, tk.t, tk.budget), claude: tk.budget.pctPerDollarSeed }
  tk.R.budget = Object.fromEntries(['codex', 'claude'].map((p) => [p, usage[p].ok
    ? { weeklyUsed: usage[p].weeklyUsed, primaryUsed: usage[p].primaryUsed, primaryMissing: !!usage[p].primaryMissing, pctPerDollar: tk.ppd[p] }
    : { unavailable: usage[p].reason }]))
  return usage.codex.ok ? null : 'budget-unavailable'
}

function check(tk, provider, est) {
  const u = tk.usage[provider]
  const extra = tk.spent[provider] * tk.ppd[provider]
  const cur = u.ok ? { ...u, weeklyUsed: u.weeklyUsed + extra, primaryUsed: u.primaryUsed + extra } : u
  return canStart(cur, est, tk.ppd[provider], tk.budget)
}

// ---- step 4: allowlisted repos (Ruling 1: no scan_schedule refusal; the field is not exposed) ----
async function step4Repos(tk) {
  let rows
  try { rows = await tk.client.listRepositories() } catch (e) { tk.R.notes.push(msg(e)); return 'scrutineer-down' }
  tk.repos = new Map()
  for (const r of rows) {
    const key = repoKey(r.url)
    if (key && inScopeKey(tk, key)) tk.repos.set(r.id, { id: r.id, key, policy: policyFor(tk.config, key) })
  }
  const found = new Set([...tk.repos.values()].map((r) => r.key))
  for (const k of tk.config.allowlist) if (!found.has(k)) tk.R.notes.push(`${k}: allowlisted but not a Scrutineer repository`)
  return null
}

const inScopeKey = (tk, key) => key.startsWith(`${tk.config.owner}/`) && tk.config.allowlist.includes(key)

// ---- step 5: in-scope findings and scans, then lifecycle actions (highest severity first) ----
async function step5Lifecycle(tk) {
  tk.findings = []; tk.scans = []
  try {
    for (const repo of tk.repos.values()) {
      const q = { repository_id: String(repo.id) }
      for (const f of await tk.client.listFindings(q)) if (f.repository_id === repo.id && !OUT_OF_SCOPE.has(f.status)) tk.findings.push({ f, repo })
      for (const s of await tk.client.listScans(q)) if (s.repository_id === repo.id) tk.scans.push(s)
    }
  } catch (e) { tk.R.notes.push(msg(e)); return 'scrutineer-down' }
  appendBudgetSample(tk)
  for (const repo of tk.repos.values()) seedRepo(tk, repo)

  const items = []
  tk.busyRepos = new Set()
  for (const it of tk.findings) {
    try { items.push(await prepare(tk, it)) } catch (e) {
      tk.R.actions.push({ findingId: it.f.id, repo: it.repo.key, type: 'prepare', result: 'failed', error: msg(e) })
      if (PR_STAGES.has(entryOf(tk, it.f.id).stage)) tk.busyRepos.add(it.repo.key) // fail closed: PR state unknown
    }
  }
  for (const i of items) if (repoBusy(i)) tk.busyRepos.add(i.repo.key)
  items.sort((a, b) => (SEVERITY_RANK[a.f.severity] ?? 9) - (SEVERITY_RANK[b.f.severity] ?? 9) || a.f.id - b.f.id)
  tk.fixCandidates = []
  for (const it of items) {
    it.action = nextAction(it.snap, it.entry, { ...it.ctx, repoHasOpenFixPr: tk.busyRepos.has(it.repo.key) })
    await execute(tk, it)
  }
  return null
}

function appendBudgetSample(tk) {
  const samples = tk.ledger.data.budgetSamples
  const last = samples.length ? Date.parse(samples[samples.length - 1].at) : null
  const dollars = last == null ? 0 : tk.scans
    .filter((s) => s.status === 'done' && Date.parse(s.finished_at) > last && typeof s.cost_usd === 'number')
    .reduce((a, s) => a + s.cost_usd, 0)
  samples.push({ at: tk.iso, weeklyUsed: tk.usage.codex.weeklyUsed, dollars })
  const cutoff = tk.t - 2 * tk.budget.calibrationDays * DAY
  tk.ledger.data.budgetSamples = samples.filter((s) => Date.parse(s.at) >= cutoff)
}

const entryOf = (tk, id) => tk.ledger.data.findings[String(id)] ?? {}
function ensureEntry(tk, id, key) {
  const all = tk.ledger.data.findings
  all[String(id)] ??= {}
  all[String(id)].repo = key
  return all[String(id)]
}

async function prepare(tk, { f, repo }) {
  let finding = f
  if (REQUIRED.some((k) => !(k in f))) finding = await tk.client.getFinding(f.id)
  const mine = tk.scans.filter((s) => s.finding_id === f.id)
  let entry = entryOf(tk, f.id)
  const patch = latestPatch(mine, f.id)
  if (patch && entry.lastPatchScanId !== patch.scanId) { // carry 4: a new patch resets the reattack retry
    entry = ensureEntry(tk, f.id, repo.key)
    entry.lastPatchScanId = patch.scanId
    entry.reattackRetries = 0
  }
  const snap = {
    finding: { ...finding, status: f.status, updated_at: f.updated_at },
    verify: verifyOutcome(mine, f.id),
    reattack: reattackStatus(mine, f.id),
    patchAttempts: patchAttemptCount(mine, f.id),
    openScan: mine.some((s) => OPEN.has(s.status)) || pendingEnqueue(entry, mine, tk.t),
    attempts: {
      verify: skillAttempts(mine, f.id, 'verify'),
      critic: skillAttempts(mine, f.id, 'critic'),
      patch: skillAttempts(mine, f.id, 'patch'),
      reattack: skillAttempts(mine, f.id, 'reattack', patch ? { since: patch.finishedAt } : {}),
    },
  }
  return { f, repo, entry, snap, ctx: await prContext(tk, f, entry, repo) }
}

function pendingEnqueue(entry, mine, t) {
  const ls = entry.lastScan
  if (!ls?.id || t - Date.parse(ls.at) > PENDING_SCAN_MS) return false
  return !mine.some((s) => s.id === ls.id && TERMINAL.has(s.status))
}

async function prContext(tk, f, entry, repo) {
  const ctx = { policy: repo.policy, prState: null, mergeSha: entry.mergeSha ?? null, pr: null, heldBranchExists: false, now: tk.iso }
  if (PR_STAGES.has(entry.stage) || entry.stage === 'merged') { // 'merged' is recorded by the workflow; resolve its PR so mark_fixed gets the merge sha
    // Ruling 18: the PR is always resolved by branch (same-repo, server-filtered), never from a ledger number that
    // `--record` or a hand edit could have pointed elsewhere. The resolved number is written back for the regate item.
    const p = await prForBranch(repo.key, ownBranch(f.id), { exec: tk.exec })
    if (p) { ctx.prState = p.state; ctx.mergeSha = p.mergeSha ?? ctx.mergeSha; ctx.pr = p.number; entry.pr = p.number }
    else delete entry.pr
  }
  if (entry.stage === 'held') ctx.heldBranchExists = await exists(join(tk.config.stateDir, 'held', String(f.id)))
  return ctx
}

const repoBusy = ({ entry, ctx }) => ctx.prState === 'OPEN' || (OPEN_FIX_STAGES.has(entry.stage) && ctx.prState !== 'MERGED' && ctx.prState !== 'CLOSED')

async function execute(tk, it) {
  const { f, repo, entry, action } = it
  const rec = { findingId: f.id, repo: repo.key, severity: f.severity, status: f.status, type: action.type }
  if (action.reason) rec.reason = action.reason
  tk.R.actions.push(rec)
  if (action.type === 'skip') { rec.result = 'skipped'; return }
  if (action.type === 'wait') {
    rec.result = 'waiting'
    if (entry.stage === 'stopped' || entry.stage === 'held') tk.R.stopped.push({ findingId: f.id, repo: repo.key, stage: entry.stage, pr: it.ctx.pr ?? undefined })
    return
  }
  if (action.type === 'fix') { rec.result = 'pending-agent'; it.rec = rec; tk.fixCandidates.push(it); return }
  let est = 0
  if (ENQUEUE.has(action.type)) {
    if (tk.enqueues >= tk.budget.maxEnqueuesPerTick) { rec.result = 'skipped'; rec.reason = 'enqueue cap'; return }
    est = estimate(tk.scans, { kind: action.type, budget: tk.budget })
    const g = check(tk, 'codex', est)
    if (!g.ok) { rec.result = 'skipped'; rec.reason = `budget: ${g.reason}`; return }
  }
  try {
    const fresh = await recheck(tk, f, repo)
    if (!fresh.ok) { rec.result = 'skipped'; rec.reason = fresh.reason; return }
    if (ENQUEUE.has(action.type)) { tk.enqueues++; tk.spent.codex += est }
    if (!tk.dry) await APPLY[action.type](tk, it, rec)
    rec.result = tk.dry ? 'would' : 'done'
    if (action.type === 'park') tk.R.parked.push({ findingId: f.id, repo: repo.key, note: action.note })
  } catch (e) {
    rec.result = 'failed'; rec.error = msg(e)
  }
}

async function recheck(tk, f, repo) {
  const cur = await tk.client.getFinding(f.id)
  if (cur.status !== f.status || cur.updated_at !== f.updated_at) return { ok: false, reason: 'changed' }
  const r = tk.repos.get(cur.repository_id)
  if (!r || r.key !== repo.key || !inScopeKey(tk, r.key)) return { ok: false, reason: 'repository not allowlisted' }
  return { ok: true }
}

async function enqueueSkill(tk, { f, repo, snap, action }, rec) {
  const { scanId, duplicate } = await tk.client.runFindingSkill(f.id, action.type)
  const e = ensureEntry(tk, f.id, repo.key)
  if (scanId) e.lastScan = { id: scanId, skill: action.type, at: tk.iso }
  if (action.type === 'patch') e.stage = 'patching'
  if (action.type === 'reattack') {
    e.stage = 'reattacking'
    if (snap.reattack === 'verification_incomplete') e.reattackRetries = (e.reattackRetries ?? 0) + 1
  }
  Object.assign(rec, { scanId, duplicate })
}

const APPLY = {
  verify: enqueueSkill, critic: enqueueSkill, patch: enqueueSkill, reattack: enqueueSkill,
  async triage(tk, { f, repo, action }) {
    await tk.client.setStatus(f.id, 'triaged')
    await tk.client.addNote(f.id, action.note)
    ensureEntry(tk, f.id, repo.key).stage = 'triaged'
  },
  // carry 1: note first, then parkedAt from a re-read, so our own note never un-parks the finding.
  async park(tk, { f, repo, action }) {
    await tk.client.addNote(f.id, action.note)
    const after = await tk.client.getFinding(f.id).catch(() => null)
    const bumped = Date.parse(after?.updated_at ?? '')
    Object.assign(ensureEntry(tk, f.id, repo.key), { stage: 'parked', parkedAt: isoOf(Math.max(tk.t, Number.isFinite(bumped) ? bumped : 0)), parkReason: action.note })
  },
  async mark_fixed(tk, { f, repo, ctx }) {
    const where = ctx.pr ? `https://github.com/${repo.key}/pull/${ctx.pr}` : 'fix PR'
    await tk.client.setStatus(f.id, 'fixed')
    await tk.client.addNote(f.id, `autopilot: fix merged via ${where} at ${ctx.mergeSha ?? 'unknown sha'}`)
    Object.assign(ensureEntry(tk, f.id, repo.key), { stage: 'marked_fixed', mergeSha: ctx.mergeSha ?? undefined, pr: ctx.pr ?? undefined })
    if (ctx.mergeSha) tk.ledger.data.repos[repo.key].lastScannedSha = ctx.mergeSha // carry 6: own merge is not a rescan trigger
  },
  async mark_published(tk, { f, repo }) {
    await tk.client.setStatus(f.id, 'published')
    await tk.client.addNote(f.id, NOTE_PUBLISHED)
    ensureEntry(tk, f.id, repo.key).stage = 'published'
  },
}

// Ruling 14: first sight seeds from the latest done security-deep-dive; none at all -> lastFullAt null -> full due.
function seedRepo(tk, repo) {
  const repos = tk.ledger.data.repos
  if (repos[repo.key]) return repos[repo.key]
  const dd = tk.scans
    .filter((s) => s.repository_id === repo.id && s.skill_name === 'security-deep-dive' && s.status === 'done')
    .sort((a, b) => Date.parse(b.finished_at) - Date.parse(a.finished_at))[0]
  const at = dd ? Date.parse(dd.finished_at) : null
  return (repos[repo.key] = {
    id: repo.id, lastScannedSha: dd?.commit ?? null, lastFullAt: at, lastScanAt: at, scrutineerVersion: tk.version,
    firstSeenAt: tk.t, seen: { sha: dd?.commit ?? null, prMergedAt: dd?.finished_at ?? tk.iso, releaseAt: dd?.finished_at ?? tk.iso }, events: [],
  })
}

// ---- step 6: rescans, after lifecycle work; one scan group at a time ----
async function step6Rescans(tk) {
  const cands = []
  for (const repo of tk.repos.values()) {
    if (repo.policy === 'exclude') continue
    const st = seedRepo(tk, repo)
    st.scrutineerVersion ??= tk.version
    try {
      const since = { sha: st.lastScannedSha, prMergedAt: isoOf(st.lastScanAt), releaseAt: isoOf(st.lastScanAt) }
      const ev = await pollRepo(repo.key, since, { exec: tk.exec })
      Object.assign(repo, { visibility: ev.visibility, defaultBranch: ev.defaultBranch })
      recordEvents(tk, st, ev)
      cands.push({ repo, st, ev })
    } catch (e) { tk.R.notes.push(`${repo.key}: GitHub poll failed (${msg(e)}); no rescan this tick`) }
  }
  const u = tk.usage.codex
  const dollarsLeft = Math.max(0, (100 - tk.budget.reserve - u.weeklyUsed) / tk.ppd.codex)
  const tiers = chooseTiers(cands.map(({ repo, st }) => ({
    key: repo.key, eventsPerWeek: eventRates(tk, st), estDiff: estimate(tk.scans, { repoId: repo.id, kind: 'diff', budget: tk.budget }),
    openHigh: tk.findings.filter((x) => x.repo.key === repo.key && SEVERITY_RANK[x.f.severity] <= 1 && x.f.status !== 'fixed').length,
  })), dollarsLeft)
  let groupBusy = tk.scans.some((s) => s.finding_id == null && OPEN.has(s.status))
    || cands.some(({ st }) => st.pendingGroupAt && tk.t - st.pendingGroupAt < PENDING_GROUP_MS
      && !tk.scans.some((s) => s.repository_id === st.id && s.finding_id == null && TERMINAL.has(s.status) && Date.parse(s.created_at) >= st.pendingGroupAt))
  for (const { repo, st, ev } of cands) {
    st.tier = tiers[repo.key]
    const kind = dueKind(tk, st, ev, st.tier)
    const rec = { repo: repo.key, type: 'rescan', tier: st.tier, kind }
    tk.R.actions.push(rec)
    if (!kind) { rec.result = 'not-due'; continue }
    if (groupBusy) { rec.result = 'skipped'; rec.reason = 'a scan group is running'; continue }
    if (tk.enqueues >= tk.budget.maxEnqueuesPerTick) { rec.result = 'skipped'; rec.reason = 'enqueue cap'; continue }
    const est = estimate(tk.scans, { repoId: repo.id, kind, budget: tk.budget })
    const g = check(tk, 'codex', est)
    if (!g.ok) { rec.result = 'skipped'; rec.reason = `budget: ${g.reason}`; continue }
    groupBusy = true; tk.enqueues++; tk.spent.codex += est
    if (tk.dry) { rec.result = 'would'; continue }
    try {
      await tk.client.scanRepo(repo.id, { mode: kind === 'full' ? 'full' : 'diff' })
      Object.assign(st, { lastScanAt: tk.t, lastScannedSha: ev.headSha, pendingGroupAt: tk.t })
      if (kind === 'full') Object.assign(st, { lastFullAt: tk.t, scrutineerVersion: tk.version ?? st.scrutineerVersion })
      rec.result = 'done'
    } catch (e) { rec.result = 'failed'; rec.error = msg(e) }
  }
}

// carry 7: dueScan has no cadence, so weekly/monthly diff rescans also need 7/30 days since the last scan.
function dueKind(tk, st, ev, tier) {
  if (st.lastFullAt == null) return 'full'
  const events = { ...ev, scrutineerVersion: tk.version ?? st.scrutineerVersion }
  const k = dueScan(st, events, tier, tk.t, { fullRescanDays: tk.budget.fullRescanDays })
  if (k === 'diff' && CADENCE_MS[tier] && tk.t - (st.lastScanAt ?? 0) < CADENCE_MS[tier]) return null
  return k
}

function recordEvents(tk, st, ev) {
  const seen = st.seen
  if (ev.headSha && ev.headSha !== seen.sha) { if (seen.sha) st.events.push({ type: 'push', at: tk.t }); seen.sha = ev.headSha }
  for (const p of ev.mergedPrs) if (Date.parse(p.mergedAt) > Date.parse(seen.prMergedAt)) { st.events.push({ type: 'pr', at: Date.parse(p.mergedAt) }); seen.prMergedAt = p.mergedAt }
  for (const r of ev.releases) if (Date.parse(r.publishedAt) > Date.parse(seen.releaseAt)) { st.events.push({ type: 'release', at: Date.parse(r.publishedAt) }); seen.releaseAt = r.publishedAt }
  st.events = st.events.filter((e) => tk.t - e.at <= EVENT_WINDOW_MS)
}

function eventRates(tk, st) {
  const weeks = Math.max(1, Math.min(EVENT_WINDOW_MS, tk.t - (st.firstSeenAt ?? tk.t)) / (7 * DAY))
  const n = (type) => st.events.filter((e) => e.type === type).length / weeks
  return { push: n('push'), pr: n('pr'), release: n('release') }
}

// ---- step 7: agent items: fix (Claude-gated, one per repo) and regate (every awaiting_ci PR); none when paused ----
async function step7AgentItems(tk) {
  const gates = new Map()
  const describe = async (repo) => {
    if (!gates.has(repo.key)) {
      let hasGate = false
      try { hasGate = (await requiredChecks(repo.key, repo.defaultBranch ?? 'main', { exec: tk.exec })).length > 0 }
      catch (e) { tk.R.notes.push(`${repo.key}: required checks unreadable (${msg(e)}); hasGate false this tick`) }
      if (!repo.visibility) tk.R.notes.push(`${repo.key}: visibility unknown; treated as public`)
      gates.set(repo.key, { policy: repo.policy, visibility: repo.visibility ?? 'public', hasGate })
    }
    return gates.get(repo.key)
  }
  const byId = new Map(tk.findings.map((x) => [String(x.f.id), x]))
  const regates = Object.entries(tk.ledger.data.findings).filter(([, e]) => e.stage === 'awaiting_ci' && e.pr)
  if (tk.paused) { // pause is the kill switch: the skill runs every agentItem, so emit none
    for (const it of tk.fixCandidates) { it.rec.result = 'skipped'; it.rec.reason = 'paused' }
    for (const [id, e] of regates) tk.R.actions.push({ findingId: Number(id), repo: byId.get(id)?.repo.key, type: 'regate', pr: e.pr, result: 'skipped', reason: 'paused' })
    return
  }
  const mark = tk.dry ? { would: true } : {}
  const used = new Set(tk.busyRepos)
  const est = tk.budget.fixEstimateUsd
  for (const it of tk.fixCandidates) {
    if (used.has(it.repo.key)) { it.rec.result = 'waiting'; it.rec.reason = 'repo already has a fix item this tick'; continue }
    const g = check(tk, 'claude', est)
    if (!g.ok) { it.rec.result = 'skipped'; it.rec.reason = `claude budget: ${g.reason}`; continue }
    used.add(it.repo.key); tk.spent.claude += est
    tk.R.agentItems.push({ kind: 'fix', findingId: it.f.id, repo: it.repo.key, ...(await describe(it.repo)), estimateUsd: est, ...mark })
    it.rec.result = tk.dry ? 'would' : 'agent'
  }
  for (const [id, e] of regates) {
    const x = byId.get(id) // the repo comes from the finding's repository_id, never from the ledger
    if (!x) { tk.R.notes.push(`finding ${id}: awaiting_ci but not an in-scope finding; no regate`); continue }
    tk.R.agentItems.push({ kind: 'regate', findingId: x.f.id, repo: x.repo.key, pr: e.pr, ...(await describe(x.repo)), ...mark })
  }
}

// ---- step 8: save the ledger, write the run file (the lock is released by runTick's finally) ----
async function step8Persist(tk) {
  for (const p of ['codex', 'claude']) if (tk.R.budget[p]) tk.R.budget[p].plannedUsd = Math.round(tk.spent[p] * 100) / 100
  if (!tk.dry) await tk.ledger.save()
  if (!tk.paused) tk.R.runFile = await writeRun(tk.config.stateDir, { at: tk.iso, ...tk.R }, tk.t)
}
