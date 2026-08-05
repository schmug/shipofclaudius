// Gate configuration: fail-closed defaults + validation.
//
// Every default here is the SAFE value, so a malformed, truncated, or absent config produces a
// gate that refuses to merge rather than one that waves things through. `normalizeConfig` never
// throws on bad input — it records the problem in `warnings` and substitutes the safe default.

export const GATE_VERSION = '1.0.0'

// The paths that must never be auto-merged, in ANY repo that adopts the factory. A repo's own
// `.factory/gate.json` ADDS to this list; it cannot shrink it. That asymmetry is the whole
// point: a PR that edits gate config, CI, or CODEOWNERS must not be able to widen its own gate.
export const MANDATORY_DENYLIST = Object.freeze([
  '.factory/**',
  '.github/workflows/**',
  '.github/CODEOWNERS',
  'CODEOWNERS',
])

export const DEFAULTS = Object.freeze({
  allowlistAuthors: [],            // empty => nobody is allowlisted => every PR escalates
  requiredLabels: ['fix-verified'],
  blockingLabels: ['needs-you', 'pipeline-paused', 'impl-blocked', 'awaiting-human', 'wontfix', 'duplicate'],
  riskPathDenylist: [],            // merged with MANDATORY_DENYLIST
  maxChangedLines: 250,
  maxChangedFiles: 8,
  requireScopeBlock: true,
  requireGreenCI: true,
  requireFixtureEvidence: false,   // opt-in; see checkFixtureEvidence
  gateFromRef: 'main',
})

const asStringArray = (v, fallback, warnings, key) => {
  if (v === undefined) return fallback
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
    warnings.push(`${key}: expected an array of strings — using the safe default`)
    return fallback
  }
  return v.map((s) => s.trim()).filter(Boolean)
}

const asPositiveInt = (v, fallback, warnings, key) => {
  if (v === undefined) return fallback
  if (!Number.isInteger(v) || v <= 0) {
    warnings.push(`${key}: expected a positive integer — using the safe default (${fallback})`)
    return fallback
  }
  return v
}

const asBool = (v, fallback, warnings, key) => {
  if (v === undefined) return fallback
  if (typeof v !== 'boolean') {
    warnings.push(`${key}: expected a boolean — using the safe default (${fallback})`)
    return fallback
  }
  return v
}

/**
 * Normalize a raw `.factory/gate.json` into a complete, safe config.
 * Never throws. Unknown keys are reported but ignored.
 * @param {unknown} raw
 * @returns {{ config: object, warnings: string[] }}
 */
export function normalizeConfig(raw) {
  const warnings = []
  const r = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {}
  if (raw !== undefined && raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) {
    warnings.push('gate config must be a JSON object — falling back to all-safe defaults')
  }

  for (const k of Object.keys(r)) {
    if (!(k in DEFAULTS)) warnings.push(`unknown config key '${k}' (ignored)`)
  }

  const repoDenylist = asStringArray(r.riskPathDenylist, DEFAULTS.riskPathDenylist, warnings, 'riskPathDenylist')

  const config = {
    allowlistAuthors: asStringArray(r.allowlistAuthors, DEFAULTS.allowlistAuthors, warnings, 'allowlistAuthors'),
    requiredLabels: asStringArray(r.requiredLabels, DEFAULTS.requiredLabels, warnings, 'requiredLabels'),
    blockingLabels: asStringArray(r.blockingLabels, DEFAULTS.blockingLabels, warnings, 'blockingLabels'),
    // union, deduped — a repo can only ever ADD to the mandatory denylist
    riskPathDenylist: [...new Set([...MANDATORY_DENYLIST, ...repoDenylist])],
    maxChangedLines: asPositiveInt(r.maxChangedLines, DEFAULTS.maxChangedLines, warnings, 'maxChangedLines'),
    maxChangedFiles: asPositiveInt(r.maxChangedFiles, DEFAULTS.maxChangedFiles, warnings, 'maxChangedFiles'),
    requireScopeBlock: asBool(r.requireScopeBlock, DEFAULTS.requireScopeBlock, warnings, 'requireScopeBlock'),
    requireGreenCI: asBool(r.requireGreenCI, DEFAULTS.requireGreenCI, warnings, 'requireGreenCI'),
    requireFixtureEvidence: asBool(r.requireFixtureEvidence, DEFAULTS.requireFixtureEvidence, warnings, 'requireFixtureEvidence'),
    gateFromRef: (typeof r.gateFromRef === 'string' && r.gateFromRef.trim()) ? r.gateFromRef.trim() : DEFAULTS.gateFromRef,
  }

  if (config.allowlistAuthors.length === 0) {
    warnings.push('allowlistAuthors is empty — NO author is trusted, so every PR will escalate')
  }

  return { config, warnings }
}
