// Verdict readers over Scrutineer scan rows (/api/v1/scans). Pure, no I/O.
// The operator export omits verification/remediation, so they are derived from scan reports.
// reattackStatus mirrors Scrutineer internal/db/remediation.go RemediationPatchStatus and fails closed:
// only failed_to_bypass with >=3 valid generated blocked variants and a passed benign control is verified_secure,
// and a bypass in any report for the attempt is sticky.

const VERIFY_STATUSES = new Set(['confirmed', 'fixed', 'inconclusive', 'deferred', 'not_attempted'])
const MIN_BLOCKED_VARIANTS = 3

const time = (s) => { const t = Date.parse(s); return Number.isNaN(t) ? null : t }

function parseReport(report) {
  if (report && typeof report === 'object') return report
  if (typeof report !== 'string' || report.trim() === '') return null
  try {
    const v = JSON.parse(report)
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null
  } catch { return null }
}

// Newest first by finished_at (falling back to created_at); unparseable times sort last; ties by id.
function newestFirst(scans) {
  const key = (s) => time(s.finished_at) ?? time(s.created_at) ?? -Infinity
  return [...scans].sort((a, b) => key(b) - key(a) || (b.id ?? 0) - (a.id ?? 0))
}

const done = (scans, skill, findingId) =>
  (scans ?? []).filter((s) => s && s.skill_name === skill && s.finding_id === findingId && s.status === 'done')

export function verifyOutcome(scans, findingId) {
  const [latest] = newestFirst(done(scans, 'verify', findingId))
  if (!latest) return null
  const status = parseReport(latest.report)?.status
  return VERIFY_STATUSES.has(status) ? status : null
}

export function latestPatch(scans, findingId) {
  const [latest] = newestFirst(done(scans, 'patch', findingId))
  return latest ? { scanId: latest.id, finishedAt: latest.finished_at } : null
}

export function patchAttemptCount(scans, findingId) {
  return done(scans, 'patch', findingId).length
}

// Accepted limitation: the API exposes no remediation_attempt_id, so reattacks are scoped to an attempt
// as "created after the latest patch scan finished".
export function reattackStatus(scans, findingId) {
  const patch = latestPatch(scans, findingId)
  if (!patch) return null
  const since = time(patch.finishedAt)
  if (since === null) return null
  const reports = newestFirst(done(scans, 'reattack', findingId).filter((s) => {
    const created = time(s.created_at)
    return created !== null && created > since
  }))
  if (reports.length === 0) return null

  const parsed = reports.map((s) => parseReport(s.report))
  const bypassed = (r) => r && (r.outcome === 'bypassed_patch' ||
    (Array.isArray(r.variants) && r.variants.some((v) => v && v.outcome === 'bypassed')))
  if (parsed.some(bypassed)) return 'bypassed_patch'

  const r = parsed[0]
  if (!r || r.outcome !== 'failed_to_bypass') return 'verification_incomplete'
  // Mirrors Scrutineer inspectReattackVariants (internal/worker/remediation.go): only valid generated
  // variants count, and two valid generated variants with the same trimmed input invalidate the report.
  const variants = Array.isArray(r.variants) ? r.variants : []
  const generated = variants.filter((v) => v && v.valid === true && v.origin === 'generated')
  const inputs = generated.map((v) => (typeof v.input === 'string' ? v.input.trim() : null))
  if (inputs.some((i) => i === null) || new Set(inputs).size !== inputs.length) return 'verification_incomplete'
  const blocked = generated.filter((v) => v.outcome === 'blocked').length
  const c = r.benign_control
  const controlOk = !!c && c.reached_sink === true && c.crashed === false
  return blocked >= MIN_BLOCKED_VARIANTS && controlOk ? 'verified_secure' : 'verification_incomplete'
}
