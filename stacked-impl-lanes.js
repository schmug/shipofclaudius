// Reusable implementation fan-out workflow with two modes.
// Takes a list of "lanes" (each = a coherent group of issues -> one PR) and
// implements each to a GREEN, review-only PR. Security-critical lanes get an
// adversarial security-hardening-reviewer pass.
//
//   mode "parallel"  (default): lanes are FILE-DISJOINT -> run concurrently, each
//                    branches off main. Use for config/docs/hygiene batches.
//   mode "sequential": lanes share hub files -> run in order, each branches off
//                    the PRIOR lane's branch so diffs stay clean (stacked PRs).
//                    The stack base only advances on a PR_OPENED, so one BLOCKED
//                    lane doesn't break the chain.
//
// Run:  Workflow({ scriptPath: "~/.claude/workflows/stacked-impl-lanes.js",
//                  args: { mode: "sequential", base: "main", lanes: [...] } })
//   lane = { key, branch, issues:[...], invariant:bool, brief:"..." }
//
// HARD RULES baked into every agent prompt (learned the hard way on FLAWD
// 2026-06-01): no advisor calls, no WebFetch/WebSearch, no CI polling
// (gh pr checks / sleep-loops blow the 180s no-progress watchdog), no merging,
// no --admin, no push to main. Agents open the PR and RETURN; the orchestrator
// drives CI-gated merges afterward. NOTE: stacked squash-merges require the
// orchestrator to rebase each child --onto origin/main after its parent merges
// (squash drops the parent's pre-merge commit); and do NOT --delete-branch until
// the whole stack lands (deleting a branch auto-closes the child PR based on it).

export const meta = {
  name: 'stacked-impl-lanes',
  description: 'Implement issue-lanes to review-only PRs (parallel if disjoint, sequential+stacked if hub-coupled); security review on invariant lanes',
  phases: [
    { title: 'Implement', detail: 'one worktree-isolated agent per lane -> green local tests -> open PR' },
    { title: 'Review', detail: 'security-hardening-reviewer on each invariant-touching lane' },
  ],
}

const A = (typeof args === 'string') ? JSON.parse(args) : (args || {})
const MODE = A.mode === 'sequential' ? 'sequential' : 'parallel'
const BASE0 = A.base || 'main'
const REPOFLAG = A.repo ? `-R ${A.repo}` : ''
const LANES = A.lanes || []
if (!Array.isArray(LANES) || LANES.length === 0) {
  throw new Error('stacked-impl-lanes: args.lanes must be a non-empty array of {key,branch,issues,invariant,brief}.')
}

const RESULT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['key', 'status', 'issues'],
  properties: {
    key: { type: 'string' }, issues: { type: 'array', items: { type: 'integer' } },
    status: { type: 'string', enum: ['PR_OPENED', 'BLOCKED', 'FAILED'] },
    pr_url: { type: 'string' }, branch: { type: 'string' }, base: { type: 'string' },
    tests_run: { type: 'string' }, blocker: { type: 'string' },
    summary: { type: 'string' }, files_changed: { type: 'array', items: { type: 'string' } },
  },
}

const IMPL_PROMPT = (lane, base) => `You are implementing GitHub issue(s) ${lane.issues.map(n => '#' + n).join(', ')} to a GREEN, REVIEW-ONLY pull request. You are in an ISOLATED git worktree.

LANE: ${lane.key}
${lane.invariant ? '⚠️ SECURITY-CRITICAL: touches security invariants. Add a THREAT_MODEL/security note and explain in the PR how the invariant is preserved.' : 'Non-invariant change.'}
SCOPE: ${lane.brief}
BRANCH: create \`${lane.branch}\` off \`origin/${base}\`; open the PR with base \`${base}\`.${base !== 'main' ? ' (This stacks on the prior lane; build on what its branch already changed.)' : ''}

⚠️ HARD RULES — do NOT call advisor; do NOT use WebFetch/WebSearch; do NOT poll CI (no "gh pr checks", no sleep/watch loops — they trip the no-progress watchdog); do NOT merge, push to main, or use --admin; no long sleeps. Open the PR and RETURN.

Plan -> implement -> verify -> ship:
1. PLAN: \`git fetch origin\`; branch off \`origin/${base}\`. For each issue: \`gh issue view <n> ${REPOFLAG} --json title,body,labels,comments\`, read fully, extract acceptance criteria. Read every file you'll touch.
2. IMPLEMENT (TDD for behavior changes). Match surrounding style. Stay strictly in scope. Preserve useful comments.
3. VERIFY (local gate): run the project's test + typecheck commands and confirm GREEN with exact counts; if you add a CI gate, reason that it passes on current code (never commit a red gate). Re-read your diff.${lane.invariant ? ' Add the THREAT_MODEL/security note.' : ''}
4. SHIP: commit (Conventional Commit + "Closes #<n>" per issue), push the branch, open ONE PR (base \`${base}\`). PR body: issues closed, what changed, local verification output${lane.invariant ? ', and an "Invariants affected" section' : ''}. Fill the PR template if present. STOP — do not check CI.

If you cannot reach green, STOP, do not open a broken PR, return status=BLOCKED with the precise blocker. Never --no-verify or bypass hooks.

Return: key, issues, status, pr_url, branch, base, tests_run, blocker, summary, files_changed.`

const REVIEW_PROMPT = (lane, impl, base) => `READ-ONLY security-hardening review of a just-opened PR for issue(s) ${lane.issues.map(n => '#' + n).join(', ')} on branch \`${impl.branch || lane.branch}\` (base \`${base}\`). Audit against the project's documented security invariants (read CLAUDE.md / THREAT_MODEL / CONTRIBUTING).

Implementation summary: ${impl.summary || '(none)'} | Files: ${(impl.files_changed || []).join(', ') || '(unknown)'}

Steps (read-only; no edit/merge/CI-poll/advisor/WebFetch):
1. \`git fetch origin && git diff origin/${base}...origin/${impl.branch || lane.branch}\`; read the changed source.
2. Adversarially check the invariant it touches: weakened/removed checks, audit records alterable without detection, gates bypassable, consent/authorization checks after side effects, secrets in code, a CI gate that would be red. Confirm a security/threat-model note was added.
3. If cheap, re-run the project's test command.

Verdict: start with APPROVE or REQUEST_CHANGES, then concrete findings (file:line, risk, fix). Be adversarial; if nothing real, say so.`

phase('Implement')

async function runLane(lane, base) {
  const impl = await agent(IMPL_PROMPT(lane, base), {
    label: `impl:${lane.key}`, phase: 'Implement', schema: RESULT_SCHEMA, isolation: 'worktree',
  })
  let review = null
  if (impl && lane.invariant && impl.status === 'PR_OPENED') {
    review = await agent(REVIEW_PROMPT(lane, impl, base), {
      label: `review:${lane.key}`, phase: 'Review', agentType: 'security-hardening-reviewer',
    })
  }
  return { lane: lane.key, issues: lane.issues, impl, review }
}

let results
if (MODE === 'parallel') {
  results = (await parallel(LANES.map((lane) => () => runLane(lane, BASE0)))).filter(Boolean)
} else {
  results = []
  let base = BASE0 // advances only on PR_OPENED so a BLOCKED lane doesn't break the stack
  for (const lane of LANES) {
    const r = await runLane(lane, base)
    if (r.impl && r.impl.status === 'PR_OPENED') base = lane.branch
    results.push(r)
    log(`${lane.key}: ${r.impl ? r.impl.status : 'NULL'}${r.review ? ' (reviewed)' : ''} | next base=${base}`)
  }
}

const opened = results.filter((r) => r.impl && r.impl.status === 'PR_OPENED')
log(`${MODE} impl done: ${opened.length}/${LANES.length} PRs opened.`)
return { mode: MODE, results, prs_opened: opened.length, total: LANES.length }
