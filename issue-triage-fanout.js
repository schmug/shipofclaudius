// Reusable issue-triage fan-out workflow.
// Spawns ONE read-only agent per open GitHub issue; each reads the issue body +
// actual repo state and classifies it into GREEN / DECISION / RESEARCH / DONE /
// BLOCKED, with a grouping key + dependency + file-footprint hints for GREEN.
// The orchestrator then turns the structured output into a plan (present buckets,
// ask the human the DECISION questions, post RESEARCH comments, implement GREEN).
//
// Read-only: agents run gh/git/grep/read only — no edits, no PRs, no comments.
//
// Run (NO ARGS NEEDED):  Workflow({ name: "issue-triage-fanout" })
//   When no args.numbers is passed, the workflow AUTO-GATHERS every open issue
//   itself (spawns one read-only agent that runs `gh issue list`), so the bare
//   `Workflow({ name })` invocation the harness generates for a /skill run Just
//   Works — no more "args.numbers must be a non-empty array" input error.
//   - args.numbers: OPTIONAL array of issue numbers to triage a SUBSET. If omitted
//                   or empty, ALL open issues are gathered automatically.
//   - args.repo:    "owner/name" (optional; defaults to the gh-resolved repo).
//   - args.notes:   optional string of repo-specific context injected into each
//                   triage prompt (e.g. "already shipped: LICENSE, CI; gaps: ...").
//
//   To triage a subset:
//     Workflow({ name: "issue-triage-fanout", args: { numbers: [16, 17, 18] } })
//
// First derived from the FLAWD 2026-06-01 fan-out (66 issues -> 37/16/5/4/4).
// Lessons baked in: args may arrive as a JSON string (parse-guard); embed the
// number list rather than relying on shared state. CRITICAL: the /skill invoke
// prompt is generated from meta ONLY (the harness never reads this .js body or
// these comments at invoke time, and emits a bare no-args `Workflow({ name })`),
// so the no-args path MUST self-bootstrap in code — documenting "pass numbers
// first" is invisible and was the recurring input error.

export const meta = {
  name: 'issue-triage-fanout',
  description: 'Read-only fan-out: one agent per open issue → GREEN/DECISION/RESEARCH/DONE/BLOCKED with grouping + deps. Auto-gathers all open issues when none are passed; pass args.numbers to triage a subset.',
  phases: [
    { title: 'Gather', detail: 'when no args.numbers: one read-only agent runs gh issue list to collect open issue numbers' },
    { title: 'Triage', detail: 'one read-only agent per issue: read body + repo state, classify' },
  ],
}

const A = (typeof args === 'string') ? JSON.parse(args) : (args || {})
const REPO = A.repo ? `-R ${A.repo}` : ''
let NUMBERS = Array.isArray(A.numbers) ? A.numbers : []
const NOTES = A.notes || ''

// Self-bootstrap: the /skill invoke prompt is generated from meta only and emits a
// bare `Workflow({ name })` with no args, so when no numbers are passed we gather
// every open issue ourselves instead of throwing the old input error.
const GATHER_LIMIT = 300
if (NUMBERS.length === 0) {
  phase('Gather')
  const gathered = await agent(
    `You are READ-ONLY (gh/git/grep/read only — do NOT edit, comment, or open anything).\n` +
    `Run exactly this command and return its output:\n` +
    `  gh issue list --state open --limit ${GATHER_LIMIT} ${REPO} --json number --jq "[.[].number]"\n` +
    `Return the integer array of open issue numbers. If the repo has no open issues, return an empty array.`,
    {
      label: 'gather-open-issues',
      phase: 'Gather',
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['numbers'],
        properties: { numbers: { type: 'array', items: { type: 'integer' } } },
      },
    }
  )
  NUMBERS = (gathered && Array.isArray(gathered.numbers)) ? gathered.numbers : []
  log(`Gathered ${NUMBERS.length} open issue(s)` +
    (NUMBERS.length >= GATHER_LIMIT ? ` (hit --limit ${GATHER_LIMIT}; some open issues may be untriaged)` : ''))
}

if (NUMBERS.length === 0) {
  throw new Error('issue-triage-fanout: no open issues to triage — none passed in args.numbers and ' +
    '`gh issue list --state open` returned none. Pass args.numbers explicitly, or confirm there are open issues.')
}

const TRIAGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['number', 'classification', 'rationale', 'complexity'],
  properties: {
    number: { type: 'integer' },
    title: { type: 'string' },
    classification: {
      type: 'string',
      enum: ['GREEN', 'DECISION', 'RESEARCH', 'DONE', 'BLOCKED'],
      description: 'GREEN=properly specced + implementable now, no human decision; DECISION=needs a human product/architecture choice with no sensible default; RESEARCH=underdetermined, needs investigation before it can be specced; DONE=already satisfied by current repo state; BLOCKED=needs an external secret/API key, repo-admin access, or is explicitly future-scoped',
    },
    group: { type: 'string', description: 'For GREEN: a canonical grouping key so related issues batch into one PR (e.g. ci, repo-hygiene, security-fix, audit, docs, tooling, tests). Empty if not GREEN.' },
    rationale: { type: 'string', description: '2-4 sentences citing concrete repo evidence (files that exist or not, acceptance criteria met or not).' },
    decision_question: { type: 'string', description: 'For DECISION: the single crisp question the human must answer. Empty otherwise.' },
    decision_options: { type: 'array', items: { type: 'string' }, description: 'For DECISION: 2-4 concrete options, recommended first. Empty otherwise.' },
    research_context: { type: 'string', description: 'For RESEARCH: markdown findings + suggested approach, ready to post as an issue comment. Empty otherwise.' },
    blocker: { type: 'string', description: 'For BLOCKED: the exact external dependency. Empty otherwise.' },
    already_done_evidence: { type: 'string', description: 'For DONE: proving files/commits. Empty otherwise.' },
    files: { type: 'array', items: { type: 'string' }, description: 'Likely files to create/modify if implemented (used for collision/grouping analysis).' },
    complexity: { type: 'string', enum: ['trivial', 'small', 'medium', 'large'] },
    depends_on: { type: 'array', items: { type: 'integer' }, description: 'Other open issue numbers that must land first.' },
    security_critical: { type: 'boolean', description: 'True if it touches security-critical invariants/planes of this project.' },
  },
}

const PROMPT = (n) => `You are triaging ONE GitHub issue so a human can decide what to implement. You are READ-ONLY: use gh / git / grep / read only. Do NOT edit, comment, or open anything.

Triage issue #${n}${A.repo ? ` in ${A.repo}` : ''}.

STEPS (do all):
1. Read the full issue: \`gh issue view ${n} ${REPO} --json title,body,labels,comments\`. Read the body AND comments — a comment may already record a decision or blocker. Capture the title into your "title" output field.
2. Inspect ACTUAL current repo state for the artifacts the issue asks for (Read/Grep/Glob + \`git log --oneline -25\`, \`ls\`, \`cat\`). An issue may ALREADY be satisfied by recent commits — verify before assuming it's open work.${NOTES ? `\n   Repo-specific context: ${NOTES}` : ''}
3. Classify into exactly one bucket:
   - DONE: repo already satisfies the acceptance criteria (cite proof in already_done_evidence).
   - BLOCKED: cannot reach a green PR autonomously — needs an external secret/API key, GitHub repo-admin access (branch protection, 2FA), or the issue itself says future/next-version scope. Put the exact blocker in blocker.
   - DECISION: implementing requires a genuine human product/architecture choice with NO sensible default. Put the question in decision_question + 2-4 options (recommended first) in decision_options. If the issue's own "decision needed" section is already resolved by current repo state, do NOT mark DECISION — mark DONE or GREEN.
   - RESEARCH: depends on an external tool/dataset/technique that must be investigated before it can be implemented confidently. Real but underdetermined. Put findings + a concrete suggested approach in research_context (markdown, ready to post as a comment).
   - GREEN: properly specced, objective acceptance criteria, no human decision, implementable to a passing test suite against CURRENT repo. Assign the best group key.
4. Note depends_on, security_critical, likely files, complexity.

Be skeptical and concrete. Prefer GREEN only when you are confident the issue is unambiguous and self-contained. A security FIX with a clear repro + expected behavior is GREEN (group=security-fix), one atomic PR each. Return the structured object.`

phase('Triage')

const results = await parallel(
  NUMBERS.map((n) => () =>
    agent(PROMPT(n), { label: `triage:#${n}`, phase: 'Triage', schema: TRIAGE_SCHEMA })
  )
)

const clean = results.filter(Boolean)
const counts = {}
for (const r of clean) counts[r.classification] = (counts[r.classification] || 0) + 1
log(`Triaged ${clean.length}/${NUMBERS.length}: ${JSON.stringify(counts)}`)

return { triaged: clean, counts, total: NUMBERS.length }
