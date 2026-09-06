// Software-factory BUILD step: implement ONE approved spec as up to four candidate Workers,
// each in its own SCRATCH CLONE of the project repo (not the session's repo), deploy each to
// an Access-gated preview hostname, open a DRAFT PR per candidate, and return the preview URLs.
//
// This is the fan-out half of `factory-intake` (skills/factory-intake/SKILL.md), the process
// skill that owns everything that talks to the human: research, the refinement questions, the
// spec, the repo scaffold, the certificate wait, the smoke + critic, the approval question,
// promote, and cleanup. Contract: docs/specs/2026-09-06-factory-intake.md §6.
//
//   Run:  Workflow({ scriptPath: "${CLAUDE_PLUGIN_ROOT}/.claude/workflows/factory-build.js",
//                    args: { slug, repo, base?, spec_path, previewDomain,
//                            candidates: [{ key, brief, direction }],   // 1..4
//                            iterate?: { key, branch, feedback }, fresh?, readonlyAgent? } })
//
// WHY THE WORKFLOW ENDS AT "DEPLOYED". Agents inside a Workflow must not sleep or poll (the
// no-progress watchdog), and a Workflow cannot call AskUserQuestion. The certificate for a new
// custom hostname takes ~141 s to serve (measured 2026-09-06), so the wait, the smoke, the
// critic and the approval question all run in the session, after this returns.
//
// WHY SCRATCH CLONES, NOT isolation:'worktree'. Every other write workflow here operates on the
// session's own checkout. This one operates on a DIFFERENT repository — the one the intake skill
// just created — so a worktree of the session repo is the wrong tool. Each build agent clones the
// project under ${TMPDIR:-/tmp}/factory/<slug>/<key>/ and works only there.
//
// NO-ARGS PATH. The /factory-build skill prompt is generated from `meta` alone, and this workflow
// cannot invent an idea. With no candidates it returns { outcome: 'needs_args' } naming
// factory-intake — a first-class outcome, not a throw.
//
// SECURITY. The spec the build agent reads is user-approved content. The only text a third party
// could influence is `iterate.feedback` (typed by the user today, but fenced anyway so the prompt
// shape never depends on provenance). The build agent has no WebFetch/WebSearch. Every
// `wrangler deploy` it runs MUST carry --config wrangler.preview.<key>.jsonc; the production
// config deploys only from the intake skill's promote phase, after the gated merge. The Access
// service token (CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET) is never needed here and the prompt
// says so; only the scaffolded scripts read it, from process.env.
// Write ladder: draft PR only. Never merge, never push to main, never --admin, never force.

export const meta = {
  name: 'factory-build',
  description: 'Software-factory build step: implement ONE approved spec as up to 4 candidate Workers in scratch clones of the project repo, deploy each to an Access-gated preview hostname via its own wrangler.preview.<key>.jsonc, open a draft PR per candidate, and return the preview URLs for the intake skill to score and present. Needs args from factory-intake; a bare run returns needs_args.',
  phases: [
    { title: 'Preflight', detail: 'one read-only agent checks which candidate branches already have an open PR (state-derived idempotency; args.fresh bypasses, and the iterate target is never skipped)' },
    { title: 'Build', detail: 'per candidate, one write-capable agent in its own scratch clone: implement the spec to the candidate direction, run the gates, generate + commit wrangler.preview.<key>.jsonc, wrangler deploy --config it, open a DRAFT PR carrying the preview URL; a deploy failure is a first-class deploy_failed result, never a throw' },
  ],
}

const A = (typeof args === 'string') ? JSON.parse(args) : (args || {})
const READONLY_AGENT = (typeof A.readonlyAgent === 'string' && A.readonlyAgent.trim()) ? A.readonlyAgent.trim() : 'Explore'
const SPINE_VERSION = '1.0.0'

// ── No-args path: first-class, not a throw. ─────────────────────────────────────────────
if (!Array.isArray(A.candidates) || A.candidates.length === 0) {
  return {
    outcome: 'needs_args',
    hint: 'factory-build has no idea of its own to build. Run the factory-intake skill: it researches the idea, asks the refinement questions, commits the spec, scaffolds the repo, and calls this workflow with { slug, repo, spec_path, previewDomain, candidates }.',
    spineVersion: SPINE_VERSION,
  }
}

// ── Validation, in script code, BEFORE any agent runs. ───────────────────────────────────
const SLUG = String(A.slug || '')
if (!/^[a-z0-9][a-z0-9-]{1,23}$/.test(SLUG)) throw new Error(`factory-build: args.slug must match ^[a-z0-9][a-z0-9-]{1,23}$ (got "${SLUG}")`)
const REPO = String(A.repo || '')
if (!/^[\w.-]+\/[\w.-]+$/.test(REPO)) throw new Error(`factory-build: args.repo must be "owner/name" (got "${REPO}")`)
const BASE = (typeof A.base === 'string' && A.base.trim()) ? A.base.trim() : 'main'
const SPEC_PATH = String(A.spec_path || '')
if (!SPEC_PATH) throw new Error('factory-build: args.spec_path is required (the approved spec inside the project repo)')
const PREVIEW_DOMAIN = String(A.previewDomain || '')
if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(PREVIEW_DOMAIN)) throw new Error(`factory-build: args.previewDomain must be a hostname suffix such as preview.example.com (got "${PREVIEW_DOMAIN}")`)
if (A.candidates.length > 4) throw new Error(`factory-build: at most 4 candidates per run (got ${A.candidates.length})`)
const CANDIDATES = A.candidates.map((c, i) => {
  const key = String((c && c.key) || '')
  if (!/^[a-z0-9]{1,8}$/.test(key)) throw new Error(`factory-build: candidates[${i}].key must match ^[a-z0-9]{1,8}$ (got "${key}")`)
  return { key, brief: String((c && c.brief) || ''), direction: String((c && c.direction) || '') }
})
const KEYS = CANDIDATES.map((c) => c.key)
if (new Set(KEYS).size !== KEYS.length) throw new Error(`factory-build: candidate keys must be unique (got ${KEYS.join(', ')})`)
const ITERATE = A.iterate
  ? { key: String(A.iterate.key || ''), branch: String(A.iterate.branch || ''), feedback: String(A.iterate.feedback || '') }
  : null
if (ITERATE) {
  if (!KEYS.includes(ITERATE.key)) throw new Error(`factory-build: iterate.key "${ITERATE.key}" names no candidate (have ${KEYS.join(', ')})`)
  if (!ITERATE.branch) throw new Error('factory-build: iterate.branch is required')
}
const FRESH = A.fresh === true

// Naming (spec §8.1). These four are the contract with factory-intake — do not rename.
const branchOf = (key) => `factory/${key}`
const workerOf = (key) => `factory-${SLUG}-${key}`
const hostOf = (key) => `${SLUG}-${key}.${PREVIEW_DOMAIN}`
const cloneDirOf = (key) => `\${TMPDIR:-/tmp}/factory/${SLUG}/${key}`

// Content-derived fence nonce (FNV-1a 32-bit) — no Date.now()/Math.random() in a Workflow script.
function fnv1aHex(str) {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0
  }
  return ('00000000' + h.toString(16)).slice(-8)
}
const NONCE = fnv1aHex(JSON.stringify({ SLUG, REPO, KEYS, feedback: ITERATE ? ITERATE.feedback : '' }))

// Placeholder — Task 2 fills the agents in. Until then the skeleton returns an empty build so the
// contract tests above can pass without any agent.
phase('Preflight')
phase('Build')
return {
  slug: SLUG, repo: REPO, base: BASE, previewDomain: PREVIEW_DOMAIN,
  outcome: 'built', iterate: ITERATE ? ITERATE.key : null,
  candidates: CANDIDATES.map((c) => ({
    key: c.key, status: 'blocked', branch: branchOf(c.key), pr_url: '', worker_name: workerOf(c.key),
    preview_url: '', version_id: '', gates_output: '', files_changed: [], summary: '',
    blocker: 'not built (skeleton)', followups: [], direction: c.direction,
  })),
  spineVersion: SPINE_VERSION,
}
