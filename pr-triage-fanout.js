// Reusable open-PR triage fan-out workflow (PR sibling of issue-triage-fanout).
// Spawns ONE read-only agent per open GitHub PR; each reads the PR + its CI
// status snapshot + its comments/reviews and classifies it into an action bucket
// (MERGE / CLOSE / REBASE / FIX_CI / COMMENT / AWAITING_HUMAN / ESCALATE) with
// the CI verdict, mergeability, comment state, and sibling hints.
// The orchestrator then turns the structured output into a table and EXECUTES the
// merges/closes/comments afterward, WITH the user's confirmation.
//
// Read-only: agents run gh/git/grep/read only — no edits, no merges, no comments,
// no PRs, no advisor, no WebFetch/WebSearch, and NO CI polling (read the
// statusCheckRollup snapshot; never `gh pr checks --watch` or sleep-loops — they
// trip the 180s no-progress watchdog). The workflow NEVER acts; it only classifies.
//
// AUTHOR FILTER — the one thing that makes this different from a generic PR triage:
//   Only PRs authored by ONE login are triaged — by default the authenticated gh
//   user (resolved at runtime via `gh api user`), or an explicit args.author. Every
//   other author (bots like app/dependabot and app/cursor, and any other human) is
//   EXCLUDED. Your own Claude-Code PRs are authored as you, so they stay in (= "my
//   PRs"). The filter is applied IN CODE (not hidden in an agent) so it is auditable,
//   and the dropped PRs are log()'d by number + author — never silently filtered.
//   The filter applies on BOTH paths: the auto-gather path AND when args.numbers
//   is passed explicitly (each passed number's author is verified and dropped if it
//   does not match).
//
// Run (NO ARGS NEEDED):  Workflow({ name: "pr-triage-fanout" })
//   When no args.numbers is passed, the workflow AUTO-GATHERS every open PR itself
//   (one read-only agent runs `gh pr list`), filters to the author, and triages those.
//   - args.numbers: OPTIONAL array of PR numbers to triage a SUBSET. If omitted or
//                   empty, ALL open PRs are gathered automatically. Numbers whose
//                   author does not match are still dropped (with a log line).
//   - args.repo:    "owner/name" (optional; defaults to the gh-resolved repo).
//   - args.author:  OPTIONAL author login to filter on. Defaults to the authenticated
//                   gh user, auto-detected at runtime via `gh api user --jq .login`.
//   - args.notes:   optional string of repo-specific context injected into each
//                   triage prompt (e.g. "ignore the `claude-review` check").
//
//   To triage a subset:
//     Workflow({ name: "pr-triage-fanout", args: { numbers: [445, 443] } })
//
// Lessons baked in (from issue-triage-fanout + stacked-impl-lanes + /triage):
//   - args may arrive as a JSON string (parse-guard).
//   - the /skill invoke prompt is generated from meta ONLY (the harness never reads
//     this .js body at invoke time and emits a bare no-args Workflow({ name })), so
//     the no-args path MUST self-bootstrap in code.
//   - GitHub computes mergeable/mergeStateStatus lazily; a cold query can return
//     UNKNOWN. Any PR an agent would recommend MERGE on must be re-verified.
//   - the required-check list drifts per repo; discover it from branch protection /
//     rulesets rather than hardcoding which checks are noise.
//   - "open PRs exist but none are yours" is a SUCCESS (clean empty return), not an
//     error — the author filter makes that a common outcome, so only genuinely-zero
//     candidates throw.
//   - FORK TRIPWIRE: on a clone that also has an `upstream` remote (e.g. a fork of
//     someone else's repo), a bare `gh` can default to the UPSTREAM repo and triage
//     the wrong PRs. Pass `args.repo: "owner/name"` on forks. The gather step logs
//     the repo it actually queried so a wrong resolve is visible. (In a clone whose
//     only remote is `origin`, the default already resolves correctly — no flag needed.)
//   - EXECUTION (orchestrator, after this read-only workflow): a green DRAFT can come
//     back action=MERGE, but `gh pr merge` FAILS on a draft — mark it ready first
//     (`gh pr ready <n>` then merge), don't just run `gh pr merge`.
//   - At large PR counts each triage agent independently discovers the required-check
//     list; fine at ~dozens in one concurrency wave, but a discover-once pre-step
//     would save redundant branch-protection queries if this is ever run at scale.

export const meta = {
  name: 'pr-triage-fanout',
  description: 'Read-only fan-out: one agent per open PR → MERGE/CLOSE/REBASE/FIX_CI/COMMENT/AWAITING_HUMAN/ESCALATE with CI verdict, mergeability, and comment state. Triages only your own PRs (the authenticated gh user by default, or args.author; bots & other authors excluded). Auto-gathers all open PRs when none are passed.',
  phases: [
    { title: 'Gather', detail: 'one read-only agent lists open PRs (or views the passed numbers) + resolves the gh user; the author filter is applied in code' },
    { title: 'Triage', detail: 'one read-only agent per kept PR: read PR + CI snapshot + comments, classify' },
  ],
}

const A = (typeof args === 'string') ? JSON.parse(args) : (args || {})
const REPO = A.repo ? `-R ${A.repo}` : ''
const AUTHOR_ARG = (typeof A.author === 'string' && A.author.trim()) ? A.author.trim() : ''
const NOTES = A.notes || ''
const EXPLICIT = Array.isArray(A.numbers) ? A.numbers : []

// ── Gather: collect candidate PRs (number, author, isDraft, title) ───────────────
// Either the explicit list (view each) or all open PRs (list). The author filter
// itself is done in code below so it is transparent and the drops are logged.
const GATHER_LIMIT = 200
phase('Gather')

const CANDIDATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['prs'],
  properties: {
    repo: { type: 'string', description: 'The owner/name the gh commands actually queried (for visibility, so a wrong fork/upstream resolve is logged).' },
    viewer: { type: 'string', description: 'The authenticated GitHub login from `gh api user --jq .login` — the default author filter when args.author is not set.' },
    prs: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['number', 'author'],
        properties: {
          number: { type: 'integer' },
          author: { type: 'string', description: 'The PR author login (the .author.login field), e.g. "octocat" or "app/dependabot".' },
          state: { type: 'string', description: 'PR state from gh: "OPEN", "MERGED", or "CLOSED".' },
          isDraft: { type: 'boolean' },
          title: { type: 'string' },
        },
      },
    },
  },
}

const REPO_FIELD_INSTR = `Also set the top-level "repo" field to the owner/name you queried (` +
  (A.repo ? `it is "${A.repo}"` : 'resolve it with `gh repo view --json nameWithOwner -q .nameWithOwner`') + `).`

// When no explicit author is passed, the author filter defaults to the authenticated
// gh user — so the gather agent (already running read-only gh) also looks it up.
const VIEWER_INSTR = AUTHOR_ARG
  ? ''
  : ` Also set the top-level "viewer" field by running \`gh api user --jq .login\` and returning its exact output (the authenticated GitHub login).`

const GATHER_PROMPT = EXPLICIT.length
  ? `You are READ-ONLY (gh/git/grep/read only — do NOT edit, comment, merge, or open anything).\n` +
    `For EACH of these PR numbers — ${EXPLICIT.join(', ')} — run:\n` +
    `  gh pr view <n> ${REPO} --json number,author,state,isDraft,title\n` +
    `and return one object per PR with: number, author (the author.login string), state ("OPEN"/"MERGED"/"CLOSED"), isDraft, title.\n` +
    `If a number is not a real PR, omit it. ${REPO_FIELD_INSTR}${VIEWER_INSTR}\nReturn as {repo, viewer, prs:[...]}.`
  : `You are READ-ONLY (gh/git/grep/read only — do NOT edit, comment, merge, or open anything).\n` +
    `Run exactly this command and return its output as {repo, viewer, prs:[...]}:\n` +
    `  gh pr list --state open --limit ${GATHER_LIMIT} ${REPO} --json number,author,state,isDraft,title\n` +
    `For each PR return: number, author (the author.login string, e.g. "octocat" or "app/dependabot"), state ("OPEN"), isDraft, title.\n` +
    `${REPO_FIELD_INSTR}${VIEWER_INSTR}\nIf there are no open PRs, return {repo, viewer, prs:[]}.`

const gathered = await agent(GATHER_PROMPT, { label: 'gather-open-prs', phase: 'Gather', schema: CANDIDATE_SCHEMA })
const CANDIDATES = (gathered && Array.isArray(gathered.prs)) ? gathered.prs : []
const QUERIED_REPO = A.repo || (gathered && typeof gathered.repo === 'string' ? gathered.repo : '')
log(`Triaging repo: ${QUERIED_REPO || '(gh default in cwd)'}`)

// ── Resolve the author to filter on: explicit args.author wins; otherwise the
// authenticated gh user the gather agent looked up. If neither resolves, throw
// rather than silently triaging EVERYONE's PRs. ─────────────────────────────────
const AUTHOR = AUTHOR_ARG || (gathered && typeof gathered.viewer === 'string' ? gathered.viewer.trim() : '')
if (!AUTHOR) {
  throw new Error(
    'pr-triage-fanout: could not resolve an author to filter on. Pass args.author explicitly, ' +
    'or ensure `gh api user` works (gh is authenticated) so the current login auto-detects.')
}
log(`Author filter: ${AUTHOR} (${AUTHOR_ARG ? 'from args.author' : 'auto-detected gh user'})`)

// ── State filter: this is OPEN-PR triage. The explicit-numbers path uses
// `gh pr view` (which also returns merged/closed PRs), and a PR can merge between
// gather and triage, so drop anything not OPEN (logged, not silent). A missing
// state is treated as OPEN (the --state open list path doesn't always echo it). ──
const openCandidates = CANDIDATES.filter((p) => !p.state || p.state === 'OPEN')
const notOpen = CANDIDATES.filter((p) => p.state && p.state !== 'OPEN')
if (notOpen.length) {
  log(`Skipped ${notOpen.length} non-open PR(s): ` +
    notOpen.map((d) => `#${d.number} (${d.state})`).join(', '))
}

// ── Author filter (in code, auditable, logged) ──────────────────────────────────
const kept = openCandidates.filter((p) => p.author === AUTHOR)
const dropped = openCandidates.filter((p) => p.author !== AUTHOR)
if (dropped.length) {
  log(`Excluded ${dropped.length} non-${AUTHOR} PR(s): ` +
    dropped.map((d) => `#${d.number} (${d.author})`).join(', '))
}
log(`Kept ${kept.length} ${AUTHOR}-authored PR(s)` +
  (CANDIDATES.length >= GATHER_LIMIT ? ` (hit --limit ${GATHER_LIMIT}; some open PRs may be untriaged)` : '') +
  `: ${kept.map((p) => `#${p.number}`).join(', ') || '(none)'}`)

if (kept.length === 0) {
  // "Open PRs exist but none are mine" is a NORMAL, SUCCESSFUL triage result (the
  // author filter makes this common) — return cleanly, do not throw. Only a
  // genuinely-empty candidate set (no open PRs at all, or none of the passed
  // numbers resolved) throws, since that often signals a real problem (gh auth,
  // wrong repo, gather agent failure) rather than an empty backlog.
  if (openCandidates.length > 0) {
    log(`Nothing to triage: ${openCandidates.length} open PR(s) exist but none are authored by "${AUTHOR}".`)
    return {
      triaged: [], counts: {}, ci_counts: {},
      kept: [],
      dropped: dropped.map((p) => ({ number: p.number, author: p.author })),
      skipped_not_open: notOpen.map((p) => ({ number: p.number, state: p.state })),
      author_filter: AUTHOR,
      queried_repo: QUERIED_REPO,
      total_candidates: CANDIDATES.length,
    }
  }
  throw new Error(
    `pr-triage-fanout: no open PRs found to triage` +
    (QUERIED_REPO ? ` in ${QUERIED_REPO}` : '') + `. ` +
    (notOpen.length
      ? `The only matching PR(s) were not open (${notOpen.map((d) => `#${d.number} ${d.state}`).join(', ')}). `
      : `\`gh pr list --state open\` returned none. `) +
    `Pass args.numbers/args.repo explicitly, or confirm there are open PRs (and that gh is authed to the right repo).`)
}

const DRAFTS = new Set(kept.filter((p) => p.isDraft).map((p) => p.number))

// ── Triage: one read-only agent per kept PR ─────────────────────────────────────
const TRIAGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['number', 'action', 'ci_status', 'mergeability', 'rationale'],
  properties: {
    number: { type: 'integer' },
    title: { type: 'string' },
    action: {
      type: 'string',
      enum: ['MERGE', 'CLOSE', 'REBASE', 'FIX_CI', 'COMMENT', 'AWAITING_HUMAN', 'ESCALATE'],
      description: 'MERGE=required checks green + mergeable + no blocking review/decision (re-verify mergeStateStatus first); CLOSE=superseded by a sibling, obsolete, or stale+conflicting bot-style branch (close-as-superseded); REBASE=BEHIND base, needs rebase/retrigger; FIX_CI=a REAL required-check failure that needs a code fix; COMMENT=an actionable, non-duplicate update is worth posting; AWAITING_HUMAN=blocked on an owner decision or a required human review (duplicate Claude-signed blocker comments already present); ESCALATE=BLOCKED+MERGEABLE (likely CODEOWNERS) or ambiguous scope a human must resolve.',
    },
    ci_status: {
      type: 'string',
      enum: ['PASSING', 'FAILING_REQUIRED', 'FAILING_NOISE', 'PENDING', 'NONE'],
      description: 'From the statusCheckRollup SNAPSHOT (no polling). FAILING_REQUIRED=a check in the repo required-context list failed; FAILING_NOISE=only non-required checks failed (e.g. claude-review); PENDING=required checks still running; NONE=no checks configured.',
    },
    ci_detail: { type: 'string', description: 'Which checks failed/pending and whether each is in the required-context list. Empty if PASSING/NONE.' },
    mergeability: {
      type: 'string',
      enum: ['CLEAN', 'UNSTABLE', 'HAS_HOOKS', 'BLOCKED', 'BEHIND', 'DIRTY', 'UNKNOWN'],
      description: 'mergeStateStatus. Re-query before recommending MERGE; treat UNKNOWN as "must verify". BLOCKED+MERGEABLE+no failed checks → likely a required review/CODEOWNERS → ESCALATE.',
    },
    comment_state: {
      type: 'string',
      enum: ['NONE', 'ACTIVE', 'AWAITING_HUMAN', 'UNADDRESSED_REVIEW', 'NOISE'],
      description: 'AWAITING_HUMAN=≥1 prior _Generated by Claude Code_-signed comment states the same blocker with no owner reply since; UNADDRESSED_REVIEW=a REQUEST_CHANGES review or review comment has no follow-up commit; ACTIVE=recent productive discussion; NOISE=only bot/duplicate chatter; NONE=no comments.',
    },
    blocking_decision: { type: 'string', description: 'For AWAITING_HUMAN/ESCALATE: the single crisp decision the owner must make. Empty otherwise.' },
    is_draft: { type: 'boolean', description: 'True if the PR is a draft. A green draft may be recommended MERGE but the rationale must note it has to be marked ready first.' },
    siblings: { type: 'array', items: { type: 'string' }, description: 'Sibling PR refs (e.g. "#411") that may supersede this PR — by headRefName stem, issue reference, or file overlap. Empty if none found.' },
    rationale: { type: 'string', description: '2-4 sentences citing concrete evidence (check names, mergeStateStatus, comment quotes, sibling refs).' },
    security_critical: { type: 'boolean', description: 'True if the PR touches security-critical invariants/planes of this project.' },
    complexity: { type: 'string', enum: ['trivial', 'small', 'medium', 'large'], description: 'Effort remaining to reach a mergeable state.' },
  },
}

const PROMPT = (n, isDraft) => `You are triaging ONE open GitHub pull request so a human can decide what to do with it. You are READ-ONLY: use gh / git / grep / read only. Do NOT edit, comment, merge, rebase, push, or open anything. Do NOT call advisor. Do NOT use WebFetch/WebSearch. Do NOT poll CI — read the statusCheckRollup SNAPSHOT only; NEVER run \`gh pr checks --watch\` or any sleep/watch loop (it trips the no-progress watchdog).

Triage PR #${n}${A.repo ? ` in ${A.repo}` : ''}.${isDraft ? ' (This PR is a DRAFT — give it full triage; if it is otherwise green you may recommend MERGE, but say in the rationale it must be marked "ready for review" first.)' : ''}

STEPS (do all):
1. Read the PR: \`gh pr view ${n} ${REPO} --json number,title,author,headRefName,baseRefName,isDraft,mergeable,mergeStateStatus,statusCheckRollup,comments,reviews,commits,createdAt,updatedAt\`. Read the body, the comments, AND the reviews — a comment or review may already record a blocker, a decision, or requested changes.
2. CI FAILURES — assess the statusCheckRollup snapshot. First discover the repo's REQUIRED-context list so you can tell a real failure from non-required noise (the list drifts; do NOT hardcode that "claude-review" is noise):
   - resolve the repo: \`gh repo view ${REPO} --json nameWithOwner -q .nameWithOwner\`
   - \`gh api repos/<owner>/<repo>/branches/<baseRefName>/protection --jq '.required_status_checks.contexts' 2>/dev/null\` and, if that 404s (repository rulesets), \`gh api repos/<owner>/<repo>/rules/branches/<baseRefName> --jq '[.[] | select(.type=="required_status_checks") | .parameters.required_status_checks[].context]'\`
   - Set ci_status: FAILING_REQUIRED if any FAILED/ERROR check is in the required list; FAILING_NOISE if only non-required checks failed; PENDING if required checks are still running; PASSING if all required checks succeeded; NONE if no checks. Put the failing/pending check names + their required/not-required status in ci_detail.
3. COMMENTS — scan comments + reviews. If ≥1 prior \`_Generated by Claude Code_\`-signed comment states the same blocker with no owner reply since → comment_state=AWAITING_HUMAN and put the decision in blocking_decision. A REQUEST_CHANGES review (or review comment) with no follow-up commit → UNADDRESSED_REVIEW. Recent productive human discussion → ACTIVE. Only bot/duplicate chatter → NOISE. No comments → NONE.
4. MERGEABILITY — record mergeStateStatus. If you are leaning toward action=MERGE, RE-QUERY \`gh pr view ${n} ${REPO} --json mergeable,mergeStateStatus\` (a cold first query returns UNKNOWN — the query itself triggers computation) and treat UNKNOWN as "must verify, do not recommend MERGE". BLOCKED + mergeable + no failed checks → a required review/CODEOWNERS is missing → ESCALATE. BEHIND → REBASE. DIRTY (conflicts) → look for the sibling that superseded it (default CLOSE-as-superseded for stale/bot-style branches; ESCALATE if it is substantive and worth rescuing).
5. SIBLINGS — before recommending MERGE or CLOSE, look for a sibling PR targeting the same change: by headRefName stem (strip trailing numeric task IDs and -v2/-v3 suffixes), by issue reference (claude/issue-NNN-* → other PRs claiming issue NNN), and by file overlap (\`gh pr diff ${n} ${REPO} --name-only\` vs recently merged PRs). A sibling that merged AFTER this PR was opened → default CLOSE-as-superseded. List any siblings found in "siblings".
6. Pick exactly ONE action (see the enum) and set security_critical, complexity, is_draft, and a concrete rationale.${NOTES ? `\n\nRepo-specific context: ${NOTES}` : ''}

Be skeptical and concrete. NEVER recommend MERGE on a PR with a FAILING_REQUIRED check, a DIRTY/UNKNOWN merge state, or an UNADDRESSED_REVIEW. Return the structured object.`

phase('Triage')

const results = await parallel(
  kept.map((p) => () =>
    agent(PROMPT(p.number, DRAFTS.has(p.number)), { label: `triage:#${p.number}`, phase: 'Triage', schema: TRIAGE_SCHEMA })
  )
)

const clean = results.filter(Boolean)
const counts = {}
const ci = {}
for (const r of clean) {
  counts[r.action] = (counts[r.action] || 0) + 1
  ci[r.ci_status] = (ci[r.ci_status] || 0) + 1
}
log(`Triaged ${clean.length}/${kept.length} kept PR(s). Actions: ${JSON.stringify(counts)} | CI: ${JSON.stringify(ci)}`)

return {
  triaged: clean,
  counts,
  ci_counts: ci,
  kept: kept.map((p) => ({ number: p.number, author: p.author, isDraft: !!p.isDraft, title: p.title })),
  dropped: dropped.map((p) => ({ number: p.number, author: p.author })),
  skipped_not_open: notOpen.map((p) => ({ number: p.number, state: p.state })),
  author_filter: AUTHOR,
  queried_repo: QUERIED_REPO,
  total_candidates: CANDIDATES.length,
}
