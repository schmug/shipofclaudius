---
name: implement-issue
description: Hand an already-filed GitHub issue off to a background agent that implements it: launches a capped `claude -p` child in its own git worktree to pick up the issue and write the code. Use when the user asks to implement, build, fix, or start coding a specific GitHub issue or ticket by number or URL, hand an issue off to an agent, delegate a ticket to an agent, kick off or spin up an agent to work on a filed issue, or get a just-filed issue picked up for implementation — including casual phrasings like "the ticket's written, get an agent on it". Accepts an optional issue number or URL; with no argument it targets the most recently filed issue. Companion to the /issue skill: /issue files the work, this skill implements it. Do not trigger for filing or creating a new issue (use /issue), for triaging/listing/closing/commenting on issues, for asking an issue's status, for reviewing a PR, or for spinning up an agent for non-issue work such as research — this skill always needs an existing issue to implement. Not a Workflow wrapper; this is a session-long process skill.
argument-hint: [issue-number-or-url]
workflow: none
---

# implement-issue

Hand a GitHub issue off to a fresh agent by launching a **`claude -p` child process** in
its own git worktree, under a second account, with the model, dollar ceiling, turn
ceiling, tool set and permission allowlist all set explicitly at the command line.

Running this skill IS the opt-in — launch the child directly, don't ask "should I?"
first. You still surface what you launched afterward.

## What changed, and what it costs

This skill used to create a **chip** with `mcp__ccd_session__spawn_task`: a card in the
user's UI that they clicked to spin up a session. That mechanism is superseded. The chip
tool accepts only `title`, `tldr`, `prompt` and `cwd` — there is no way to choose a model,
so a chip inherited whatever the app was configured for and a delegated implementation
could silently run on the most expensive tier.

Be honest about the trade, because it is not free:

- **The human click is gone.** A chip was an offer; the child starts immediately, and it
  starts with write tools and the user's own `gh` credentials. Invoking the skill is now
  the whole of the approval.
- **What you gain** is every knob the chip lacked: `--model`, `--max-budget-usd`,
  `--max-turns`, `--tools`, `--allowedTools`, `--permission-mode`, and a machine-readable
  result. A child is also roughly an order of magnitude cheaper in context than the
  in-process `Agent` tool, which inherits this session's entire tool roster.

If the user wants the click back for a particular hand-off, tell them what a chip cannot
set and let them choose — do not quietly re-add an approval step they did not ask for.

## Step 1 — Resolve the target issue

Pick the issue in this priority order:

1. **Explicit argument.** If the user passed an issue number (`42`) or a URL
   (`https://github.com/owner/repo/issues/42`), use that. A bare number resolves against
   the current repo.
2. **Most recently filed this session.** If no argument but an issue was filed earlier in
   this conversation, use that issue.
3. **Latest open issue you authored.** Otherwise query the repo:
   ```bash
   gh issue list --author @me --state open --limit 10 --json number,title,url,createdAt
   ```
   Use the newest by `createdAt`. If the list is empty or the newest is ambiguous (several
   filed near the same time), briefly tell the user what you found and ask which one
   rather than guessing.

If you're not in a git repo, `gh` isn't installed, or `gh auth status` fails, stop and
tell the user — don't launch a child against an unknown issue.

## Step 2 — Fetch the full issue

You need the real body to build a self-contained brief. Don't rely on memory of what the
issue said:

```bash
gh issue view <number-or-url> --json number,title,body,url,state,labels
```

If `state` is `CLOSED`, note it to the user and confirm they still want the work before
proceeding — a closed issue is usually a sign of a stale or wrong target.

Derive `owner/repo` from the `url` field, which always carries it (`repository` is not a
real `gh issue view --json` field — that mistake is what broke this step originally):

```bash
gh issue view <number-or-url> --json url --jq '.url | capture("github.com/(?<owner>[^/]+)/(?<repo>[^/]+)/") | .owner+"/"+.repo'
```

## Step 3 — Provision an isolated worktree

The child gets write tools and an inherited `gh` token. Never point it at the working tree
you are sitting in: it would race your edits on a shared branch. Give it its own worktree,
cut from the **default branch**, not from whatever branch you happen to be on.

Resolve the repo root first — the current directory may itself be a worktree, in which
case its `.git` is a file, not a directory:

```bash
REPO=$(git rev-parse --path-format=absolute --git-common-dir); REPO=${REPO%/.git}
SLUG=<owner/repo>; N=<issue-number>
BASE=$(gh repo view "$SLUG" --json defaultBranchRef --jq .defaultBranchRef.name)
WT="$REPO/../$(basename "$REPO")-issue-$N"
git -C "$REPO" fetch --quiet origin "$BASE"
git -C "$REPO" worktree add -b "issue-$N" "$WT" "origin/$BASE"
```

If the branch or worktree already exists, the issue is probably already being worked.
Say so and stop rather than clobbering it.

## Step 4 — Launch the child

Run this through Bash with `run_in_background: true`. The harness re-invokes you when the
process exits, so its exit **is** the completion signal — there is nothing to poll and
nothing to join.

```bash
env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u CLAUDE_CODE_OAUTH_TOKEN \
    CLAUDE_CONFIG_DIR="$HOME/.claude-sub2" \
    claude -p "$BRIEF" \
      --model sonnet \
      --max-turns 120 \
      --max-budget-usd 8 \
      --permission-mode acceptEdits \
      --tools Read,Write,Edit,Glob,Grep,Bash \
      --allowedTools "Read" "Write" "Edit" "Glob" "Grep" \
        "Bash(git:*)" "Bash(gh:*)" "Bash(npm:*)" "Bash(npx:*)" "Bash(node:*)" \
        "Bash(python3:*)" "Bash(pytest:*)" "Bash(make:*)" "Bash(cargo:*)" \
        "Bash(ls:*)" "Bash(cat:*)" "Bash(head:*)" "Bash(tail:*)" "Bash(grep:*)" \
        "Bash(rg:*)" "Bash(find:*)" "Bash(sed:*)" "Bash(mkdir:*)" \
      --append-system-prompt-file "$HOME/.claude/CLAUDE.md" \
      --strict-mcp-config \
      --output-format json < /dev/null > "$WT/../implement-$N.json" 2>&1
```

Run it with the worktree as the working directory. Six of those flags are load-bearing,
and each was measured rather than assumed:

- **The three `-u` unsets** are what keep the child off *this* account's credentials. The
  separate `CLAUDE_CONFIG_DIR` is logged into a second account; without the unsets the
  inherited environment wins and the child bills the primary one.
- **`--permission-mode acceptEdits` with a named `--allowedTools` list.** `dontAsk` does
  not ask — it *denies*, and a child under it could not even run `gh auth status`.
  `bypassPermissions` is the opposite extreme, is refused outright by this session's own
  auto-mode classifier, and should never be requested here: the allowlist measured zero
  denials while staying auditable.
- **`--append-system-prompt-file`.** A child under a different `CLAUDE_CONFIG_DIR` loads
  the project `CLAUDE.md` but the user-level one **does not load** — that file lives in
  the primary config dir and the second account's dir has none. Asked directly, a child
  answered "No" to having global guardrails. So no-push-to-main, never-sign-as-me and
  evidence-before-done do not reach it unless injected. `--add-dir` does *not* inject
  them; this flag does.
- **The ceilings.** Cost control is the entire reason this skill stopped inheriting a
  model. A child with no ceiling spends without bound and nothing here notices.
- **`--output-format json`** returns `total_cost_usd`, `usage`, `num_turns` and
  `permission_denials` — the audit trail Step 6 reads.
- **`< /dev/null`.** A backgrounded child otherwise inherits this session's stdin and
  stalls on a "no stdin data received in 3s" warning.
- **Never `--bare`.** It reads auth strictly from `ANTHROPIC_API_KEY` or an `apiKeyHelper`
  and never touches OAuth or the keychain, so a subscription child dies "Not logged in".

### The brief must stand alone

The child has no memory of this conversation. Issue bodies written as self-contained
Claude Code prompts (task upfront, `path:line` pointers, constraints, acceptance criteria,
out-of-scope) hand off best — embed the body verbatim rather than paraphrasing it:

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

Keep that closing directive short — the child loads the repo's own CLAUDE.md and the
injected global one, so you are pointing at guardrails, not restating them. Don't add
guardrails the issue didn't ask for; the goal is a faithful hand-off of the filed work.

## Step 5 — Confirm

Tell the user in one or two lines: which issue the child is working (number + title +
URL), the worktree and branch it owns, the model and dollar ceiling you set, and that you
will report the outcome when the process exits. Say plainly that it is **already running**
— there is no card to click and no way to call it back short of killing the process.

Unlike the chip it replaces, this needs no attended session: a child is an ordinary
background process, so a scheduled or remote-dispatched run gets the same behavior and
the same report. Nothing here is skipped when unattended.

If several issues were filed this session, remind them they can run the skill again with
another issue number — one child per issue.

## Step 6 — On exit: verify from artifacts, then report

The child's own prose is **not evidence**. Measured twice while building this step: a
child reported "File created successfully" and "4. Done" for a write that never landed —
once because the write was silently denied, once because it resolved a bare filename into
its own scratchpad. A child will claim work it did not do. Only the repository proves
what happened.

Read the JSON result for cost and denials, then verify independently:

```bash
git -C "$WT" log --oneline origin/"$BASE"..HEAD
gh pr list --repo "$SLUG" --search "$N" --state all --json number,state,headRefName
gh pr checks <pr-number>
```

A non-empty `permission_denials` array is the diagnosable failure mode: the child hit a
command outside the allowlist. Widen the list deliberately for that command and re-run —
do not switch to a blanket grant.

Report to the user: issue → branch → commits → PR number and state → CI verdict → what
the child actually spent against the ceiling you set. If the JSON says `is_error` or the
budget was exhausted, say that plainly and name what was left unfinished.

**Always send a `PushNotification` on a terminal outcome** — including when the user is
plainly present and reading along. This is not a judgement call, and *"they're clearly
watching, a push would just be noise"* is not an exception to it. The asymmetry is the
reason: a missed push on a launch-and-leave run is **silent** and costs the user the
outcome entirely; a redundant push to someone already reading costs one notification.

If this session ends before the child does, the outcome is deferred, not lost. The PR
closes the originating issue, so GitHub holds the linkage indefinitely:

```bash
gh issue view <n> --json state,closedByPullRequestsReferences \
  --jq '{state, prs: [.closedByPullRequestsReferences[]?.number]}'
```

Tell the user that rather than letting a dead session read as "you get nothing".

## What the child may and may not do

The child's isolation is a feature. It is also the only thing standing between a bad brief
and your working tree:

- **May** implement the issue, run gates, open a PR, and merge through a mechanical gate
  exactly as the brief states.
- **May not** run outside its own worktree. If you find yourself pointing a child at the
  parent's directory, stop — that is how two agents end up committing to one branch.
- **May not** be handed work that is blocked in this session. Permission boundaries are
  per-session; routing blocked work through a child launders the user's permission
  decision, and the child runs on a different account where that decision was never made.
- **May not** be given a wider allowlist than the task needs "to be safe". Widen on an
  observed denial, never in anticipation of one.

There is no mid-flight channel to the child and none should be added. `spawn_task`,
`ListAgents`, `SendMessage` and the `ccd_session_mgmt` tools all address *sessions*; a
child is a process, not a session, and none of them can reach it. To correct a bad brief,
kill the process and relaunch with a better one.

## Multiple issues

This skill launches **one** child per run. If the user asks to implement several at once,
launch one per issue — each with its own worktree, its own branch, its own brief and its
own ceiling — and list what you started. Give each a distinct worktree path; two children
sharing a directory is the failure this whole step exists to prevent.
