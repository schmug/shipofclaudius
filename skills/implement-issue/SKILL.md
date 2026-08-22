---
name: implement-issue
description: Use when the user asks to implement, build, fix, or start coding an already-filed GitHub issue by number or URL, hand a ticket off to a background agent, or get a just-filed issue picked up for implementation. Accepts an optional issue number or URL; with no argument it targets the most recently filed issue. Not for filing new issues, triaging, or PR review — this skill always needs an existing issue to implement. Not a Workflow wrapper; this is a session-long process skill.
argument-hint: [issue-number-or-url]
workflow: none
---

# implement-issue

Hand a GitHub issue off to a fresh agent for implementation by creating a **chip** with the `mcp__ccd_session__spawn_task` tool. The chip appears in the user's UI; one click spins it into its own session and worktree, or they dismiss it. Running this skill IS the opt-in — create the chip directly, don't ask "should I?" first. (You still surface what you created afterward.)

Why a chip and not just doing it here: implementation is usually out of scope for the current conversation, and a fresh session with its own worktree keeps the work isolated and lets the user run it in parallel. The spawned session has **no memory of this conversation**, so the chip prompt must stand completely on its own.

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
gh issue view <number-or-url> --json number,title,body,url,state,labels,repository
```

If `state` is `CLOSED`, note it to the user and confirm they still want a chip before proceeding — a closed issue is usually a sign of a stale or wrong target.

## Step 3 — Build the chip

Call `mcp__ccd_session__spawn_task` with:

- **`title`** — an imperative action phrase under 60 chars, derived from the issue title. Start with a verb. E.g. issue "Drawer doesn't persist scroll position" → `"Fix drawer scroll-position persistence"`.
- **`tldr`** — 1–2 plain-English sentences on what the spawned session will do and why. No file paths or code; this is the hover tooltip.
- **`prompt`** — the self-contained handoff (see below).
- **`cwd`** — set this to the issue's repo root **only if** the issue belongs to a different repo than the current working directory (check the `repository` field). When it's the current repo, leave `cwd` unset.

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

## Step 4 — Confirm

After the chip is created, tell the user in one or two lines: which issue it targets (number + title + URL) and that they can click the chip to spin up the agent or dismiss it. If several issues were filed this session, remind them they can run the skill again with another issue number — one chip per issue.

## Multiple issues

This skill makes **one** chip per run. If the user asks to implement several at once, create one chip per issue (each with its own self-contained prompt), and list what you created.
