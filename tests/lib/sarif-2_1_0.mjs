// Dependency-free SARIF 2.1.0 conformance validator (Node built-ins only).
//
// The repo's CI is intentionally zero-dependency (no lockfile, no install step —
// see .github/workflows/ci.yml), so we cannot pull `ajv` + the full JSON Schema to
// validate a SARIF projection. Instead this encodes the HARD requirements of the
// OASIS "Static Analysis Results Interchange Format (SARIF) Version 2.1.0" spec
// for a static-analysis log — the document profile our scans emit — and checks a
// candidate object against them. It is deliberately strict about the structures we
// produce (so a projection bug fails the build) and silent about optional SARIF
// surface we don't use.
//
// Spec cross-references (OASIS SARIF v2.1.0):
//   §3.13 sarifLog   — `version` MUST equal "2.1.0"; `runs` MUST be present (array).
//   §3.14 run        — `tool` MUST be present.
//   §3.18 toolComponent (driver) — `name` MUST be a non-empty string.
//   §3.49 reportingDescriptor (rule) — `id` MUST be a string.
//   §3.27 result     — `message` MUST be present (§3.11: a string `text` or `id`).
//                      `ruleId` is a string if present; `level` ∈ {none,note,warning,error}.
//   §3.28 location / §3.4 physicalLocation — `artifactLocation.uri` is a string;
//                      `region.startLine` (§3.30) is a positive integer if present.
//   §3.27.16 partialFingerprints — an object whose values are strings.
//
// Returns { valid: boolean, errors: string[] }. `errors` is human-readable and is
// surfaced in test failures so a malformed projection is easy to diagnose.

const LEVELS = new Set(['none', 'note', 'warning', 'error'])
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

export function validateSarif(log) {
  const errors = []
  const E = (m) => errors.push(m)

  if (!isObj(log)) { E('root must be an object'); return { valid: false, errors } }
  if (log.version !== '2.1.0') E(`version must be "2.1.0", got ${JSON.stringify(log.version)}`)
  if (typeof log.$schema !== 'undefined' && typeof log.$schema !== 'string') E('$schema must be a string when present')
  if (!Array.isArray(log.runs)) { E('runs must be an array'); return { valid: false, errors } }

  log.runs.forEach((run, ri) => {
    const rp = `runs[${ri}]`
    if (!isObj(run)) { E(`${rp} must be an object`); return }
    if (!isObj(run.tool)) { E(`${rp}.tool must be an object`); return }
    const driver = run.tool.driver
    if (!isObj(driver)) E(`${rp}.tool.driver must be an object`)
    else {
      if (typeof driver.name !== 'string' || driver.name.length === 0) E(`${rp}.tool.driver.name must be a non-empty string`)
      if (typeof driver.rules !== 'undefined') {
        if (!Array.isArray(driver.rules)) E(`${rp}.tool.driver.rules must be an array`)
        else driver.rules.forEach((rule, i) => {
          if (!isObj(rule) || typeof rule.id !== 'string' || rule.id.length === 0) E(`${rp}.tool.driver.rules[${i}].id must be a non-empty string`)
        })
      }
    }
    if (typeof run.results !== 'undefined') {
      if (!Array.isArray(run.results)) { E(`${rp}.results must be an array`); return }
      run.results.forEach((res, i) => validateResult(res, `${rp}.results[${i}]`, E))
    }
  })

  return { valid: errors.length === 0, errors }
}

function validateResult(res, p, E) {
  if (!isObj(res)) { E(`${p} must be an object`); return }
  if (!isObj(res.message)) E(`${p}.message must be an object`)
  else if (typeof res.message.text !== 'string' && typeof res.message.id !== 'string') E(`${p}.message must carry a string text or id`)
  if (typeof res.ruleId !== 'undefined' && typeof res.ruleId !== 'string') E(`${p}.ruleId must be a string`)
  if (typeof res.level !== 'undefined' && !LEVELS.has(res.level)) E(`${p}.level must be one of none|note|warning|error`)
  if (typeof res.partialFingerprints !== 'undefined') {
    if (!isObj(res.partialFingerprints)) E(`${p}.partialFingerprints must be an object`)
    else for (const [k, v] of Object.entries(res.partialFingerprints)) if (typeof v !== 'string') E(`${p}.partialFingerprints.${k} must be a string`)
  }
  if (typeof res.locations !== 'undefined') {
    if (!Array.isArray(res.locations)) { E(`${p}.locations must be an array`); return }
    res.locations.forEach((loc, i) => {
      if (!isObj(loc)) { E(`${p}.locations[${i}] must be an object`); return }
      const pl = loc.physicalLocation
      if (typeof pl === 'undefined') return
      if (!isObj(pl)) { E(`${p}.locations[${i}].physicalLocation must be an object`); return }
      if (typeof pl.artifactLocation !== 'undefined') {
        if (!isObj(pl.artifactLocation) || typeof pl.artifactLocation.uri !== 'string') E(`${p}.locations[${i}].physicalLocation.artifactLocation.uri must be a string`)
      }
      if (typeof pl.region !== 'undefined') {
        if (!isObj(pl.region)) E(`${p}.locations[${i}].physicalLocation.region must be an object`)
        else if (typeof pl.region.startLine !== 'undefined' && (!Number.isInteger(pl.region.startLine) || pl.region.startLine < 1)) E(`${p}.locations[${i}].physicalLocation.region.startLine must be a positive integer`)
      }
    })
  }
}
