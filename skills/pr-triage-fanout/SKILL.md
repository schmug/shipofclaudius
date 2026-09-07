---
name: pr-triage-fanout
description: Read-only fan-out triage of your open PRs → MERGE/CLOSE/REBASE/FIX_CI/COMMENT/AWAITING_HUMAN/ESCALATE with CI verdict + mergeability. Auto-gathers all your open PRs when none are given (bots and other authors excluded). Use when you want everything you have in flight sorted into what can land, what needs a rebase or a CI fix, and what is waiting on a human — triage my PRs, what is mergeable, why is this one stuck. Not for reading one PR diff in depth (use pr-review-fanout, which sits behind this skill COMMENT verdict), not for triaging issues (use issue-triage-fanout), and not for landing anything (use merge-pr-with-gate or stacked-merge-walk).
---

Run the `pr-triage-fanout` dynamic workflow bundled with this plugin. `Workflow({ scriptPath })` only accepts a path already under the session's working directory (or an added directory) — a plugin-cache path is refused even after being `Read` in-session (see `CLAUDE.md` "Wrapper shape"; reproduced in [#213](https://github.com/schmug/shipofclaudius/issues/213)). So: `Read` `${CLAUDE_PLUGIN_ROOT}/.claude/workflows/pr-triage-fanout.js`, then call the Workflow tool with its exact contents as `script`:

```
Workflow({ script: "<the file's exact contents>", args: { /* fill from the request */ } })
```

Fill `args` from the user's request. Common args: `numbers` (subset; omit to auto-gather), `repo`, `author`, `notes`. For the full, current argument list, read the header comment / `meta` block in `${CLAUDE_PLUGIN_ROOT}/.claude/workflows/pr-triage-fanout.js`, or the repo README "Arguments" table. READ-ONLY; triages only the resolved author's PRs; read-scoped `gh` token.
