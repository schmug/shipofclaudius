// Build the gate's typed input from raw `gh` JSON.
//
// This is deliberately a PURE function of already-fetched data: the GitHub Actions `land` job (and
// `factory-land`) do the fetching, and this does the shaping. Keeping the shaping pure is what lets
// it be tested offline — the shape of `gate-input.json` is a contract between four callers (the
// Action, factory-land, factory-issue-fix's evidence block, and gate-core's nine conditions), and a
// silent shape drift would disable a condition rather than fail it.
//
// FAIL-CLOSED, like everything else in the gate: a field that cannot be resolved becomes `null` or
// an empty list, never a permissive default. `gate-core` treats missing data as a FAILED condition,
// so "we could not tell" and "it is unsafe" produce the same answer — which is the correct one.

import { extractCloses } from './extract.mjs'

/** Labels arrive as `[{name}]` from `gh --json labels`, or already as strings. */
const labelNames = (labels) =>
  Array.isArray(labels) ? labels.map((l) => String((l && l.name) || l)).filter(Boolean) : []

/** Changed files arrive as `[{path}]` from `gh pr view --json files`. */
const filePaths = (files) =>
  Array.isArray(files) ? files.map((f) => String((f && f.path) || f)).filter(Boolean) : null

/**
 * Normalize `statusCheckRollup` into the `{ name, conclusion }[]` shape checkCI reads.
 * Returns null when the rollup is absent — checkCI treats null as UNKNOWN, which never passes.
 */
export function normalizeChecks(rollup) {
  if (!Array.isArray(rollup)) return null
  return rollup.map((c) => ({
    name: String((c && (c.name || c.context)) || ''),
    conclusion: String((c && (c.conclusion || c.state)) || '').toLowerCase(),
  }))
}

/**
 * Resolve which issue a PR closes, for ROUTING only.
 *
 * The gate re-extracts this authoritatively in `checkSingleCloses` and compares it against the
 * issue number it is given, so a routing guess that disagrees makes the condition FAIL. Ambiguous
 * or absent references return null by construction.
 * @param {string} prBody
 * @returns {number|null}
 */
export function resolveLinkedIssue(prBody) {
  return extractCloses(prBody || '').number
}

/**
 * Build the `gh api` path for discovering a base branch's required-check contexts.
 *
 * `gh api` does NOT accept `-R/--repo` — it resolves `{owner}/{repo}` from the current directory's
 * git remote instead. Passing `-R` makes the call fail, which silently yields ZERO required
 * contexts, which makes `ci_green` fail on every PR forever. So when the caller named a repo we
 * interpolate it into the path, and only fall back to the placeholders when it did not.
 *
 * @param {string|null|undefined} repo  "owner/name", or null to use the cwd's repo
 * @param {string} base                 the base branch
 * @param {'protection'|'rules'} kind
 * @returns {string} the api path
 */
export function requiredContextsPath(repo, base, kind) {
  const slug = (typeof repo === 'string' && /^[^/\s]+\/[^/\s]+$/.test(repo.trim())) ? repo.trim() : '{owner}/{repo}'
  const b = encodeURIComponent(String(base == null ? '' : base))
  return kind === 'rules' ? `repos/${slug}/rules/branches/${b}` : `repos/${slug}/branches/${b}/protection`
}

/**
 * Shape the gate input from raw `gh` payloads.
 *
 * @param {object} o
 * @param {object} o.pr        `gh pr view --json number,body,labels,files,additions,deletions,mergeStateStatus,statusCheckRollup`
 * @param {object} [o.issue]   `gh issue view --json number,author,body,labels` — omit when unresolved
 * @param {string[]} [o.requiredContexts]  the base branch's required-check contexts
 * @param {object} [o.evidence]  factory-issue-fix's `{ fixtureTest, redOnBase, greenOnHead }`
 * @returns {object} the gate input
 */
export function buildGateInput({ pr, issue, requiredContexts, evidence } = {}) {
  const p = (pr && typeof pr === 'object') ? pr : {}
  const i = (issue && typeof issue === 'object') ? issue : null

  const additions = Number(p.additions)
  const deletions = Number(p.deletions)

  return {
    issue: {
      number: i && Number.isFinite(Number(i.number)) ? Number(i.number) : null,
      author: (i && i.author && i.author.login) ? String(i.author.login) : null,
      body: (i && typeof i.body === 'string') ? i.body : '',
      labels: i ? labelNames(i.labels) : [],
    },
    pr: {
      number: Number.isFinite(Number(p.number)) ? Number(p.number) : null,
      body: typeof p.body === 'string' ? p.body : '',
      labels: labelNames(p.labels),
      changedFiles: filePaths(p.files),
      additions: Number.isFinite(additions) ? additions : null,
      deletions: Number.isFinite(deletions) ? deletions : null,
      mergeStateStatus: p.mergeStateStatus || null,
      checks: normalizeChecks(p.statusCheckRollup),
    },
    requiredContexts: Array.isArray(requiredContexts) ? requiredContexts.map(String).filter(Boolean) : [],
    evidence: (evidence && typeof evidence === 'object') ? evidence : null,
  }
}
