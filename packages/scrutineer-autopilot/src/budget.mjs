// Headroom gate and cost estimates (spec §7.3, §7.4). No I/O except the injected `exec`;
// `now` is injected (a number of ms or a () => ms). Fails closed: any unusable codexbar
// output yields { ok:false } and canStart then refuses.
import { DEFAULTS } from './config.mjs'

const STALE_MS = 30 * 60_000
const DAY_MS = 86_400_000
const GROUP_WINDOW_MS = 2 * 3_600_000
const FINDING_KINDS = new Set(['verify', 'critic', 'patch', 'reattack'])
const FINDING_FALLBACK_USD = 1

const nowMs = (now) => (typeof now === 'function' ? now() : now)
const pct = (w) => (w && typeof w.usedPercent === 'number' && Number.isFinite(w.usedPercent) ? w.usedPercent : null)

// Verified live 2026-11-02 against codexbar 0.163.0:
//  - claude: usage.secondary = weekly, usage.primary = 5h but carries isSyntheticPlaceholder:true
//    (a fabricated 0%), so it is not a measurement.
//  - codex: usage.secondary = weekly (identical to openaiDashboard.primaryLimit); usage.primary is null.
// CONCERN for the controller: when the 5-hour window is absent or synthetic we return
// primaryUsed:0 with primaryMissing:true instead of failing, so canStart's primary check passes
// trivially. Only the weekly inequality then gates the run.
export async function readUsage(provider, { exec, now }) {
  let raw
  try { raw = await exec('codexbar', ['usage', '--provider', provider, '--format', 'json']) }
  catch (e) { return { ok: false, reason: `codexbar failed: ${e.message}` } }
  let rows
  try { rows = JSON.parse(raw) } catch { return { ok: false, reason: 'codexbar output is not JSON' } }
  if (!Array.isArray(rows)) return { ok: false, reason: 'codexbar output is not an array' }
  const row = rows.find((r) => r && r.provider === provider)
  if (!row) return { ok: false, reason: `no ${provider} entry in codexbar output` }
  const usage = row.usage ?? {}
  const updatedMs = Date.parse(usage.updatedAt)
  if (!Number.isFinite(updatedMs)) return { ok: false, reason: 'missing updatedAt' }
  if (nowMs(now) - updatedMs > STALE_MS) return { ok: false, reason: `stale usage (updatedAt ${usage.updatedAt})` }
  const weeklyUsed = pct(usage.secondary) ?? pct(row.openaiDashboard?.primaryLimit)
  if (weeklyUsed === null) return { ok: false, reason: 'weekly window missing' }
  const primary = usage.primary
  const primaryUsed = primary && !primary.isSyntheticPlaceholder ? pct(primary) : null
  const base = { ok: true, weeklyUsed, updatedAt: usage.updatedAt }
  return primaryUsed === null ? { ...base, primaryUsed: 0, primaryMissing: true } : { ...base, primaryUsed }
}

// Nearest-rank percentile; values must be non-empty.
function percentile(values, p) {
  const s = [...values].sort((a, b) => a - b)
  return s[Math.max(0, Math.ceil((p / 100) * s.length) - 1)]
}

const usable = (s) => s && s.status === 'done' && typeof s.cost_usd === 'number' && s.cost_usd > 0
const isGroupScan = (s) => !FINDING_KINDS.has(s.skill_name)
const t = (s) => Date.parse(s.created_at)

// Cost per scan group, oldest group first. Scan rows exported by /api/v1/scans have NO
// `scan_group` (observed 2026-11-01), so the fallback groups by repository and a 2-hour
// `created_at` window measured from the first scan of the group. A present `scan_group` wins.
function groupCosts(scans, repoId, pred) {
  const mine = scans.filter((s) => (repoId == null || s.repository_id === repoId) && usable(s) && pred(s))
  const byKey = new Map()
  const loose = []
  for (const s of mine) {
    if (s.scan_group != null) {
      const g = byKey.get(s.scan_group) ?? { start: Infinity, cost: 0 }
      g.start = Math.min(g.start, t(s)); g.cost += s.cost_usd
      byKey.set(s.scan_group, g)
    } else loose.push(s)
  }
  const groups = [...byKey.values()]
  const byRepo = new Map()
  for (const s of loose) byRepo.set(s.repository_id, [...(byRepo.get(s.repository_id) ?? []), s])
  for (const list of byRepo.values()) {
    list.sort((a, b) => t(a) - t(b))
    let cur = null
    for (const s of list) {
      if (!cur || t(s) - cur.start > GROUP_WINDOW_MS) { cur = { start: t(s), cost: 0 }; groups.push(cur) }
      cur.cost += s.cost_usd
    }
  }
  return groups.sort((a, b) => a.start - b.start).map((g) => g.cost)
}

export function diffGroupCost(scans, repoId) {
  return groupCosts(scans, repoId, isGroupScan)
}

function samplesFor(scans, repoId, kind) {
  // Ruling 7: diff and full share one group history (no skill or rescan_mode field tells them apart);
  // only the fallback differs.
  if (kind === 'diff' || kind === 'full') return groupCosts(scans, repoId, isGroupScan)
  return scans
    .filter((s) => (repoId == null || s.repository_id === repoId) && usable(s) && s.skill_name === kind)
    .sort((a, b) => t(a) - t(b)).map((s) => s.cost_usd)
}

export function estimate(scans, { repoId, kind, budget = DEFAULTS.budget }) {
  if (kind !== 'diff' && kind !== 'full' && !FINDING_KINDS.has(kind)) throw new Error(`unknown kind: ${kind}`)
  const last = (v) => v.slice(-budget.estimateSamples)
  for (const id of [repoId, null]) {
    const v = last(samplesFor(scans, id, kind))
    if (v.length) return percentile(v, budget.estimatePercentile)
  }
  if (kind === 'diff') return budget.fallbackDiffUsd
  if (kind === 'full') return budget.fallbackFullUsd
  return FINDING_FALLBACK_USD
}

// Samples are per tick: weeklyUsed is the weekly usedPercent at that tick and dollars is the
// sum of cost_usd of scans finished since the previous tick. Each consecutive pair gives
// (weeklyUsed delta, later dollars); a negative delta is a weekly reset and is skipped.
// Least squares through the origin: sum(x*y)/sum(x*x).
export function calibrate(samples, now, budget = DEFAULTS.budget) {
  const seed = budget.pctPerDollarSeed
  const cutoff = nowMs(now) - budget.calibrationDays * DAY_MS
  const s = samples.filter((x) => Date.parse(x.at) >= cutoff).sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
  if (s.length < budget.calibrationSamples) return seed
  let xy = 0, xx = 0
  for (let i = 1; i < s.length; i++) {
    const dy = s[i].weeklyUsed - s[i - 1].weeklyUsed
    const x = s[i].dollars
    if (dy < 0 || !(x > 0)) continue
    xy += x * dy; xx += x * x
  }
  const slope = xx > 0 ? xy / xx : 0
  return slope > 0 && Number.isFinite(slope) ? slope : seed
}

// Spec §7.4: weekly + est_pct + margin <= 100 - reserve, and primary + est_pct <= primaryWindowCap.
export function canStart(usage, estDollars, pctPerDollar, budget = DEFAULTS.budget) {
  if (!usage || !usage.ok) return { ok: false, reason: `usage unavailable: ${usage?.reason ?? 'unknown'}` }
  const estPct = estDollars * pctPerDollar
  const weekly = usage.weeklyUsed + estPct + budget.margin
  const weeklyLimit = 100 - budget.reserve
  if (weekly > weeklyLimit) return { ok: false, reason: `weekly headroom: ${usage.weeklyUsed} + ${estPct} + ${budget.margin} > ${weeklyLimit}` }
  const primary = usage.primaryUsed + estPct
  if (primary > budget.primaryWindowCap) return { ok: false, reason: `primary window: ${usage.primaryUsed} + ${estPct} > ${budget.primaryWindowCap}` }
  return { ok: true, reason: 'within headroom' }
}
