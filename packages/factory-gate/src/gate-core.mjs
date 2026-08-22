// The factory merge gate — deterministic, fail-closed, model-free.
//
// This is the generalized descendant of dmarcheck's `scripts/routine-gate/gate-core.ts`. It
// decides ONE question: may this PR be squash-merged without a human looking at it?
//
// Three properties make the answer trustworthy, and all three are load-bearing:
//
//   1. NO MODEL RUNS HERE. Every condition is parsing and comparison. An issue body is public,
//      attacker-writable text; an injected instruction cannot move a `<=` comparison.
//   2. FAIL CLOSED, ALWAYS. Missing data, ambiguous data, unknown CI state, malformed config —
//      all resolve to FAIL. `UNKNOWN` is never a pass. The gate's default answer is "no".
//   3. THE GATE RUNS FROM `gateFromRef`, NEVER FROM THE PR. The caller (the GitHub Action, or
//      factory-land) is responsible for extracting this package AND the repo's gate config from
//      `main` before evaluating. `.factory/**` and `.github/workflows/**` are on the MANDATORY
//      denylist so a PR that edits its own gate escalates regardless of where the gate ran from.
//      `evaluate()` stamps `configSource` into the verdict so the audit comment shows what ran.
//
// The verdict is a full record, not a boolean: every condition reports pass/fail with a reason,
// so the PR comment explains the decision and a rising failure category tells you which part of
// the factory to fix (see the design spec, "Metrics").

import { firstMatch } from './glob.mjs'
import { extractCloses, extractScopeGlobs } from './extract.mjs'
import { GATE_VERSION, normalizeConfig } from './config.mjs'

/** CI conclusions that count as green. Everything else — including absent — fails. */
const GREEN = new Set(['success', 'neutral', 'skipped'])

const cond = (id, pass, reason, detail) => ({ id, pass: !!pass, reason, ...(detail ? { detail } : {}) })

// ── Conditions ────────────────────────────────────────────────────────────────────────────────
// Each is a pure function of (input, config) -> condition record. Independently testable, and
// independently readable — if you cannot explain a condition in one sentence it does not belong.

/** 1. The linked issue was authored by someone trusted to define work for the factory. */
export function checkAuthor(input, config) {
  const author = input?.issue?.author
  if (!author) return cond('author_allowlisted', false, 'issue author is unknown')
  const ok = config.allowlistAuthors.includes(author)
  return cond('author_allowlisted', ok,
    ok ? `issue author @${author} is allowlisted` : `issue author @${author} is not in allowlistAuthors`)
}

/** 2. The human (or the fixture harness) has minted the trust token. */
export function checkRequiredLabels(input, config) {
  const labels = new Set([...(input?.pr?.labels || []), ...(input?.issue?.labels || [])].map((l) => String(l).toLowerCase()))
  const missing = config.requiredLabels.filter((l) => !labels.has(String(l).toLowerCase()))
  return cond('required_labels', missing.length === 0,
    missing.length === 0 ? `all required labels present (${config.requiredLabels.join(', ') || 'none'})`
      : `missing required label(s): ${missing.join(', ')}`)
}

/** 3. Nobody has flagged this for a human. The kill switch lives here. */
export function checkBlockingLabels(input, config) {
  const labels = [...(input?.pr?.labels || []), ...(input?.issue?.labels || [])].map((l) => String(l).toLowerCase())
  const hit = config.blockingLabels.filter((b) => labels.includes(String(b).toLowerCase()))
  return cond('no_blocking_labels', hit.length === 0,
    hit.length === 0 ? 'no blocking labels' : `blocking label(s) present: ${hit.join(', ')}`)
}

/** 4. Exactly one resolvable `Closes #N`. Zero OR ambiguous both fail — the gate never guesses. */
export function checkSingleCloses(input) {
  const { number, found } = extractCloses(input?.pr?.body || '')
  if (number == null) {
    return cond('single_closes', false,
      found.length === 0
        ? 'PR body declares no resolvable `Closes #N` (outside code fences, quotes, and comments)'
        : `PR body is ambiguous — it closes ${found.length} issues (#${found.join(', #')})`)
  }
  const linked = input?.issue?.number
  if (linked != null && Number(linked) !== number) {
    return cond('single_closes', false, `PR closes #${number} but the gate was given issue #${linked}`)
  }
  return cond('single_closes', true, `PR closes exactly one issue: #${number}`, { number })
}

/** 5. No changed file touches a risk path. The mandatory denylist cannot be shrunk by config. */
export function checkRiskPaths(input, config) {
  const files = input?.pr?.changedFiles
  if (!Array.isArray(files) || files.length === 0) {
    return cond('no_risk_paths', false, 'changed-file list is empty or unavailable — cannot prove the change is safe')
  }
  const hits = []
  for (const f of files) {
    const g = firstMatch(f, config.riskPathDenylist)
    if (g) hits.push(`${f} (matched ${g})`)
  }
  return cond('no_risk_paths', hits.length === 0,
    hits.length === 0 ? `none of ${files.length} changed files touch a risk path` : `risk path(s) touched: ${hits.join('; ')}`)
}

/** 6. The change is small enough for CI plus a glance to be meaningful review. */
export function checkSize(input, config) {
  const files = input?.pr?.changedFiles
  const additions = input?.pr?.additions
  const deletions = input?.pr?.deletions
  if (!Array.isArray(files) || !Number.isFinite(additions) || !Number.isFinite(deletions)) {
    return cond('within_size_limits', false, 'PR size data is unavailable — cannot prove the change is small')
  }
  const lines = additions + deletions
  const problems = []
  if (files.length > config.maxChangedFiles) problems.push(`${files.length} files > ${config.maxChangedFiles}`)
  if (lines > config.maxChangedLines) problems.push(`${lines} changed lines > ${config.maxChangedLines}`)
  return cond('within_size_limits', problems.length === 0,
    problems.length === 0 ? `${files.length} files / ${lines} lines, within limits` : problems.join('; '),
    { files: files.length, lines })
}

/**
 * 7. Every changed file was declared in the issue's ```scope block.
 *
 * An issue with no scope block yields NO globs, and no globs means every file is drift. That is
 * deliberate: "no declared scope" is not permission, it is an unfinished spec.
 */
export function checkScopeDrift(input, config) {
  if (!config.requireScopeBlock) return cond('no_scope_drift', true, 'scope enforcement disabled by config')
  const globs = extractScopeGlobs(input?.issue?.body || '')
  const files = input?.pr?.changedFiles
  if (!Array.isArray(files) || files.length === 0) {
    return cond('no_scope_drift', false, 'changed-file list is empty or unavailable')
  }
  if (globs.length === 0) {
    return cond('no_scope_drift', false,
      'the linked issue declares no ```scope block — with no declared scope every changed file is drift (fail-closed)')
  }
  const drift = files.filter((f) => !firstMatch(f, globs))
  return cond('no_scope_drift', drift.length === 0,
    drift.length === 0 ? `all ${files.length} changed files match the declared scope`
      : `${drift.length} file(s) outside the declared scope: ${drift.join(', ')}`,
    { globs, drift })
}

/**
 * 8. CI is green — and `UNKNOWN` is treated as "must verify", never as a pass.
 *
 * Every required context must be present AND conclusive. A required check that never reported is
 * indistinguishable from one that was skipped by an attacker-shaped workflow trigger, so absence
 * fails. Mirrors `merge-pr-with-gate`'s UNKNOWN=must-verify rule.
 */
export function checkCI(input, config) {
  if (!config.requireGreenCI) return cond('ci_green', true, 'CI enforcement disabled by config')
  const checks = input?.pr?.checks
  if (!Array.isArray(checks)) return cond('ci_green', false, 'CI status is unavailable (UNKNOWN = must verify, never a pass)')

  const byName = new Map(checks.map((c) => [String(c?.name), String(c?.conclusion || '').toLowerCase()]))
  const required = Array.isArray(input?.requiredContexts) ? input.requiredContexts : []
  if (required.length === 0) return cond('ci_green', false, 'no required checks resolved — cannot prove CI is green')

  const problems = []
  for (const name of required) {
    if (!byName.has(name)) { problems.push(`${name}: missing`); continue }
    const c = byName.get(name)
    if (!c) problems.push(`${name}: still running / no conclusion`)
    else if (!GREEN.has(c)) problems.push(`${name}: ${c}`)
  }

  const mergeState = String(input?.pr?.mergeStateStatus || '').toUpperCase()
  if (mergeState && !['CLEAN', 'HAS_HOOKS', 'UNSTABLE'].includes(mergeState)) {
    problems.push(`mergeStateStatus is ${mergeState}`)
  }
  if (mergeState === 'UNSTABLE') problems.push('mergeStateStatus is UNSTABLE (a non-required check is failing)')

  return cond('ci_green', problems.length === 0,
    problems.length === 0 ? `all ${required.length} required checks green (mergeState ${mergeState || 'n/a'})` : problems.join('; '))
}

/**
 * 9. The fix is backed by a fixture that was RED on the base and GREEN on the head.
 *
 * This is the factory-specific condition and the one that makes mechanical `fix-verified`
 * defensible later: it is the machine-checkable form of "the fix actually fixes the reported bug".
 * Opt-in via `requireFixtureEvidence` — turn it on only once the repo's reproduction harness is
 * real, otherwise it fails every PR.
 */
export function checkFixtureEvidence(input, config) {
  if (!config.requireFixtureEvidence) return cond('fixture_evidence', true, 'fixture evidence not required by config')
  const e = input?.evidence
  if (!e || typeof e !== 'object') return cond('fixture_evidence', false, 'no fixture evidence supplied')
  // PROVENANCE (#64). These booleans decide whether code lands unattended, so they must come from
  // a CI job that RAN the fixture and observed the process exit codes — never from the fix agent,
  // which authored the very code under judgement. `source` is a marker, not proof; the real
  // guarantee is the transport (an artifact from a pull_request-triggered job, consumed by a land
  // job that only ever checks out the BASE ref). The marker exists so that agent-shaped or
  // legacy-shaped evidence fails LOUDLY here instead of passing silently.
  if (e.source !== 'ci') {
    return cond('fixture_evidence', false,
      `fixture evidence not produced by CI (provenance is "${e.source || 'none'}") — condition 9 accepts only evidence carrying source:"ci", written by the fixture-evidence job from observed test exit codes`)
  }
  const problems = []
  if (!e.fixtureTest) problems.push('no fixture test path recorded')
  if (e.redOnBase !== true) problems.push('the fixture test was not proven RED on the base commit')
  if (e.greenOnHead !== true) problems.push('the fixture test was not proven GREEN on the head commit')
  return cond('fixture_evidence', problems.length === 0,
    problems.length === 0 ? `fixture ${e.fixtureTest}: red on base, green on head` : problems.join('; '))
}

// ── Evaluation ────────────────────────────────────────────────────────────────────────────────

export const CONDITION_ORDER = Object.freeze([
  'author_allowlisted', 'required_labels', 'no_blocking_labels', 'single_closes',
  'no_risk_paths', 'within_size_limits', 'no_scope_drift', 'ci_green', 'fixture_evidence',
])

/**
 * Evaluate every condition and return a full verdict record.
 *
 * ALL conditions are evaluated even after the first failure — the PR comment should tell the
 * author everything that is wrong in one pass, and the failure histogram is how you learn which
 * part of the factory to widen (see the design spec, "Metrics worth instrumenting").
 *
 * @param {object} input   { issue, pr, requiredContexts, evidence }
 * @param {object} rawConfig  the repo's `.factory/gate.json`, unvalidated
 * @param {{ configSource?: string }} [meta]  provenance label, e.g. "main@<sha>"
 */
export function evaluate(input, rawConfig, meta = {}) {
  const { config, warnings } = normalizeConfig(rawConfig)

  const conditions = [
    checkAuthor(input, config),
    checkRequiredLabels(input, config),
    checkBlockingLabels(input, config),
    checkSingleCloses(input),
    checkRiskPaths(input, config),
    checkSize(input, config),
    checkScopeDrift(input, config),
    checkCI(input, config),
    checkFixtureEvidence(input, config),
  ]

  const failed = conditions.filter((c) => !c.pass)
  return {
    pass: failed.length === 0,
    outcome: failed.length === 0 ? 'merge' : 'escalate',
    failed: failed.map((c) => c.id),
    conditions,
    warnings,
    config,
    configSource: meta.configSource || 'unknown',
    gateVersion: GATE_VERSION,
  }
}

/** Render a verdict as the markdown audit comment posted on every gated PR. */
export function renderVerdict(verdict) {
  const lines = [
    `### Factory gate — ${verdict.pass ? '✅ merge' : '⛔ escalate'}`,
    '',
    `Gate \`v${verdict.gateVersion}\` evaluated from \`${verdict.configSource}\`.`,
    '',
    '| Condition | Result | Reason |',
    '| --- | --- | --- |',
  ]
  for (const c of verdict.conditions) {
    lines.push(`| \`${c.id}\` | ${c.pass ? '✅' : '⛔'} | ${String(c.reason).replace(/\|/g, '\\|')} |`)
  }
  if (verdict.warnings.length) {
    lines.push('', '<details><summary>Config warnings</summary>', '')
    for (const w of verdict.warnings) lines.push(`- ${w}`)
    lines.push('', '</details>')
  }
  return lines.join('\n')
}
