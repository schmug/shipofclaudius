---
name: implement-issue
description: Use when the user asks to implement, build, fix, or start coding an already-filed GitHub issue by number or URL, hand a ticket off to a background agent, or get a just-filed issue picked up for implementation. Accepts an optional issue number or URL; with no argument it targets the most recently filed issue. Not for filing new issues, triaging, or PR review — this skill always needs an existing issue to implement. Not a Workflow wrapper; this is a session-long process skill.
argument-hint: [issue-number-or-url]
workflow: none
---

# implement-issue

Hand a GitHub issue off to a fresh agent for implementation by creating a **chip** with the `mcp__ccd_session__spawn_task` tool. The chip appears in the user's UI; one click spins it into its own session and worktree, or they dismiss it. Running this skill IS the opt-in — create the chip directly, don't ask "should I?" first. (You still surface what you created afterward.)

Why a chip and not just doing it here: implementation is usually out of scope for the current conversation, and a fresh session with its own worktree keeps the work isolated and lets the user run it in parallel. The spawned session has **no memory of this conversation**, so the chip prompt must stand completely on its own.

Steps 4–7 then keep a light watch on the chip: one handshake on **intent**, one report on **outcome**, and nothing in between. That watch deliberately re-couples two sessions the rest of this skill works to keep isolated, so it is scoped as narrowly as possible — see "What the watch may and may not do".

## Step 1 — Resolve the target issue

Pick the issue in this priority order:

1. **Explicit argument.** If the user passed an issue number (`42`) or a URL (`https://github.com/owner/repo/issues/42`), use that. A bare number resolves against the current repo.
2. **Most recently filed this session.** If no argument but an issue was filed earlier in this conversation, use that issue.
3. **Latest open issue you authored.** Otherwise query the repo:
   ```bash
   gh issue list --author @me --state open --limit 10 --json number,title,url,createdAt
   ```
   Use the newest by `createdAt`. If the list is empty or the newest is ambiguous (several filed near the same time), briefly tell the user what you found and ask which one rather than guessing.

If you're not in a git repo, `gh` isn't installed, or `gh auth status` fails, stop and tell the user — don't fabricate a chip against an unknown issue.

## Step 2 — Fetch the full issue

You need the real body to build a self-contained handoff. Don't rely on memory of what the issue said:

```bash
gh issue view <number-or-url> --json number,title,body,url,state,labels
```

If `state` is `CLOSED`, note it to the user and confirm they still want a chip before proceeding — a closed issue is usually a sign of a stale or wrong target.

## Step 3 — Build the chip

Call `mcp__ccd_session__spawn_task` with:

- **`title`** — an imperative action phrase under 60 chars, derived from the issue title. Start with a verb. E.g. issue "Drawer doesn't persist scroll position" → `"Fix drawer scroll-position persistence"`. This string also becomes the **spawned session's title**, which is what Step 6 joins on — so make it distinctive, not a phrase you'd plausibly use for a different chip today.
- **`tldr`** — 1–2 plain-English sentences on what the spawned session will do and why. No file paths or code; this is the hover tooltip.
- **`prompt`** — the self-contained handoff (see below).
- **`cwd`** — set this to the issue's repo root whenever the chip shouldn't branch off the current working directory as-is. `repository` is not a real `gh issue view --json` field (that mistake is what broke this step originally); derive owner/repo from the `url` field instead, which always carries it:
  ```bash
  gh issue view <number-or-url> --json url --jq '.url | capture("github.com/(?<owner>[^/]+)/(?<repo>[^/]+)/") | .owner+"/"+.repo'
  ```
  If that differs from the current repo, set `cwd` to that repo's root. If it matches, still check the **worktree** case: the current directory may be a worktree of the target repo rather than its root, and leaving `cwd` unset would branch the chip off the current feature branch instead of the default branch. Resolve the real root with:
  ```bash
  git rev-parse --path-format=absolute --git-common-dir
  ```
  and strip the trailing `/.git`; if that differs from the current directory, set `cwd` to it. Only leave `cwd` unset when the repo matches and the current directory already is that root.

### The prompt must stand alone

Issue bodies written as self-contained Claude Code prompts (task upfront, `path:line` pointers, constraints, acceptance criteria, out-of-scope) hand off best — embed the body verbatim rather than paraphrasing it. Use this shape:

```
Implement GitHub issue #<number>: <title>
<url>

<full issue body, verbatim>

---
Follow this repo's conventions (its CLAUDE.md, tests, commit style). Use TDD where it
applies, run the test/build/typecheck gates before finishing, and open a PR — do not push
to main. If the default branch has a server-side ruleset/protection with required CI
checks, squash-merge or enable auto-merge once everything is green; if not, or you can't
verify the gate (fail closed), stop at the open PR and say which gate is missing. If the
issue body is underspecified, state your assumptions before coding.
```

Keep that closing directive short — the spawned session loads its own CLAUDE.md, so you're pointing at the guardrails, not restating them all. Don't add guardrails the issue didn't ask for; the goal is a faithful handoff of the filed work.

## Step 4 — Arm the watch

Do this **immediately after the chip is created and before you tell the user about it**. They may click within seconds, and a worktree appearing is the earliest proof that they did.

**Skip this entire phase in an unattended run** — a scheduled task, a routine, a remote-dispatched session, anything under `/loop`. `mcp__ccd_session_mgmt__send_message` is documented unavailable in unattended sessions, and there is no one present to receive an outcome report. Skip it and say you skipped it; do not arm a watch whose payoff step cannot run.

Otherwise arm exactly one `Monitor`, filling in the repo root, `owner/repo`, and issue number:

```bash
REPO=<repo-root>; SLUG=<owner/repo>; N=<issue-number>
snap() {
  { git -C "$REPO" worktree list --porcelain 2>/dev/null \
      | awk '/^worktree /{w=$2} /^branch /{print "worktree " w " " $2}'
    gh pr list --repo "$SLUG" --state all --search "$N" \
      --json number,state,headRefName \
      --jq '.[] | "pr #\(.number) \(.state) \(.headRefName)"' 2>/dev/null
  } | sort
}
prev=$(snap)   # baseline first: pre-existing worktrees and PRs are not events
for _ in $(seq 1 60); do
  sleep 30
  cur=$(snap)
  delta=$(diff <(printf '%s\n' "$prev") <(printf '%s\n' "$cur") | grep -E '^[<>]' || true)
  prev=$cur
  [ -n "$delta" ] && printf '%s\n' "$delta"
  # Terminal ONLY on a newly-observed terminal line ('> '), never on the baseline's.
  printf '%s\n' "$delta" | grep -qE '^> pr #[0-9]+ (MERGED|CLOSED)' \
    && { echo "TERMINAL: PR reached MERGED or CLOSED"; exit 0; }
done
echo "WINDOW ENDED after 30m; final state: ${prev:-<nothing observed>}"
```

Pass `persistent: false` with `timeout_ms` a little above the loop's own 30-minute window (`1900000`), and a specific `description` — the description appears in every notification, so `"chip #<n>: worktree/branch/PR"` beats `"watching"`.

Three properties of that script are load-bearing:

- **Repo signals, not session signals.** `Monitor` runs shell commands, so it cannot call the session tools at all. The repo-side signals need no session linkage and do not care *whether or when* the chip is clicked.
- **Silence is never the answer.** The loop emits on the failure directions too — `diff` reports a worktree disappearing (`<`) as well as appearing (`>`), a PR reaching `CLOSED` is terminal, and the window always ends with an explicit line. You never have to interpret a quiet monitor.
- **`persistent: false`.** A session-length watch outlives the work it was watching and sits armed over a chip the user moved on from.
- **Terminal fires on the delta, not the snapshot.** `gh pr list --search "$N"` is a *full-text* search: searching `131` in a real repo also returns a long-merged PR #96 that merely mentions the number. Grepping the whole snapshot for `MERGED` therefore ends the watch on its first tick, before the chip is ever clicked. Only a `> ` line — a state newly observed since the baseline — is terminal. Treat every PR the monitor names as a candidate; Step 7 confirms which one is actually the chip's by matching the branch reported in `list_sessions`.

## Step 5 — Confirm

Tell the user in one or two lines: which issue the chip targets (number + title + URL), that they can click it to spin up the agent or dismiss it, and — one clause, not a paragraph — that you'll flag the intent and the resulting PR if they start it inside the window. If several issues were filed this session, remind them they can run the skill again with another issue number — one chip per issue.

Say plainly that the watch **ends when this session does**. There is no out-of-session watcher: `Monitor` is session-scoped and the session tools need you in the loop. Spawn-and-keep-working gets a watch; spawn-and-close gets nothing, and the user should know which they're getting.

## Step 6 — On the first event: identify, then handshake

The first monitor event (normally a new worktree) is your wakeup. Do not poll for it.

**Identify the session** with `mcp__ccd_session_mgmt__list_sessions`. Join in this order:

1. Exact `title` match against the chip title from Step 3.
2. Otherwise the newest session whose `cwd` is under the target repo and whose `lastActivityAt` is after the chip was created — normally the worktree path the monitor just reported.

**If the join is ambiguous or empty, report that and drop the watch.** Never guess a target: the cost of guessing is messaging an unrelated session the user is actively working in. This mirrors Step 1's stance on ambiguous issues.

Address the session by its **`sessionId`**, and use the `ccd_session_mgmt` tools to do it. The name-addressed alternatives do not work here and should not be reached for: a locally-clicked chip is listed by its *worktree slug*, not by the chip title, so `ListAgents` cannot be joined on what you know; that listing also collides names and self-truncates past the first pages, and `notify_when_idle` inherits the same addressing. A name-addressed send does not fail loudly — it reaches the wrong session silently.

**Read intent** with `mcp__ccd_session_mgmt__list_events` (a small `limit`; you want its opening moves, not its whole transcript).

**Handshake** with `mcp__ccd_session_mgmt__send_message` — one line, asking it to confirm the issue number it is working and restate the brief in a sentence. It lands as a visible user turn labelled "From \<this session\>", so the nudge is auditable by the user rather than invisible plumbing. There is no return channel; read the reply on a later wakeup via `list_events`.

## Step 7 — On a terminal event: report the outcome

When the monitor reports a terminal PR state, or `list_sessions` shows the session's `isRunning` has gone false, report to the user: issue → session title → branch → `prNumber` and `prState`, all of which come straight off the `list_sessions` row without reading a transcript. Add the CI verdict (`gh pr checks <n>`) if a PR exists. Send a `PushNotification` for this — a terminal outcome is the one event worth interrupting for — and not for the intermediate state changes.

If the window ends with nothing observed, say exactly that: the chip was not started within the window. That is not a failure of the spawned session and should not be reported as one.

## What the watch may and may not do

The spawned session's isolation is a feature, not an accident. The watch spends a little of it deliberately and is capped there:

- **May** message the spawned session for the Step 6 handshake, and to correct a **hard divergence**: it is working the wrong issue number, or it is pushing to `main`.
- **May not** message it about scope, approach, style, or quality. Those go to the user, who can decide, not into the session as a mid-flight nudge. An injected user turn derails a session that was doing fine, and "drift" judged from a transcript excerpt is exactly where false positives come from.
- **May not** ask it to do anything blocked in this session. Permission boundaries are per-session; routing blocked work through a peer launders the user's permission decision.

## Multiple issues

This skill makes **one** chip per run. If the user asks to implement several at once, create one chip per issue (each with its own self-contained prompt), and list what you created. Arm **one monitor per chip** — each watches a distinct issue number and worktree — but keep Step 6's join strict per chip; several chips created seconds apart are exactly the case where a sloppy title join attaches the wrong session.
