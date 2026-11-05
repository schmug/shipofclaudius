// Pure scheduling helpers: budgeted tier choice and "is a scan due".

// Most frequent first.
const TIERS = ['diff', 'pr', 'release', 'weekly', 'monthly']

const runsPerWeek = (tier, ev = {}) => {
  switch (tier) {
    case 'diff': return ev.push ?? 0
    case 'pr': return ev.pr ?? 0
    case 'release': return ev.release ?? 0
    case 'weekly': return 1
    default: return 0.25
  }
}

const totalEvents = (r) => (r.eventsPerWeek?.push ?? 0) + (r.eventsPerWeek?.pr ?? 0) + (r.eventsPerWeek?.release ?? 0)

export function chooseTiers(repos, dollarsLeft) {
  const out = {}
  let left = dollarsLeft
  const sorted = [...repos].sort((a, b) => b.openHigh - a.openHigh || totalEvents(b) - totalEvents(a))
  for (const r of sorted) {
    let pick = 'monthly' // floor, assigned even when it does not fit
    for (const tier of TIERS.slice(0, -1)) {
      const cost = runsPerWeek(tier, r.eventsPerWeek) * r.estDiff
      // A tier with no runs per week never fires; skip it rather than picking a free dead tier.
      if (runsPerWeek(tier, r.eventsPerWeek) > 0 && cost <= left) { pick = tier; break }
    }
    left -= runsPerWeek(pick, r.eventsPerWeek) * r.estDiff
    out[r.key] = pick
  }
  return out
}

const DAY = 86400e3

// repoState: { lastFullAt (epoch ms), scrutineerVersion, lastScannedSha }
// events: RepoEvents from pollRepo, plus optional `scrutineerVersion` (the current one).
// A missing lastFullAt or version on either side is "unknown", never "due".
export function dueScan(repoState, events, tier, now, { fullRescanDays = 90 } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : now
  const full90 = repoState.lastFullAt != null && nowMs - repoState.lastFullAt >= fullRescanDays * DAY
  const versionChanged = events.scrutineerVersion != null && repoState.scrutineerVersion != null
    && events.scrutineerVersion !== repoState.scrutineerVersion
  if (full90 || versionChanged) return 'full'
  switch (tier) {
    case 'diff': return events.pushed ? 'diff' : null
    case 'pr': return events.mergedPrs?.length ? 'diff' : null
    case 'release': return events.releases?.length ? 'diff' : null
    default: return events.headSha !== repoState.lastScannedSha ? 'diff' : null
  }
}
