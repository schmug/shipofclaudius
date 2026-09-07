---
name: issue-triage-fanout
description: Read-only fan-out triage of open GitHub issues → GREEN/DECISION/RESEARCH/DONE/BLOCKED with grouping + dependencies, synthesized into a dependency-ordered roadmap. Auto-gathers all open issues when none are given. Use when you want the whole open-issue backlog sorted into what is buildable now, what needs a human decision, and what is already done — triage my issues, what should I work on next, is this backlog stale. Not for investigating one unresolved issue in depth (use issue-research-fanout, which consumes the RESEARCH bucket this produces), not for triaging PRs (use pr-triage-fanout), and not for implementing the result (use stacked-impl-lanes).
---

Run the `issue-triage-fanout` dynamic workflow bundled with this plugin. `Workflow({ scriptPath })` only accepts a path already under the session's working directory (or an added directory) — a plugin-cache path is refused even after being `Read` in-session (see `CLAUDE.md` "Wrapper shape"; reproduced in [#213](https://github.com/schmug/shipofclaudius/issues/213)). So: `Read` `${CLAUDE_PLUGIN_ROOT}/.claude/workflows/issue-triage-fanout.js`, then call the Workflow tool with its exact contents as `script`:

```
Workflow({ script: "<the file's exact contents>", args: { /* fill from the request */ } })
```

Fill `args` from the user's request. Common args: `numbers` (subset; omit to auto-gather), `repo`, `notes`, `readonlyAgent`. For the full, current argument list, read the header comment / `meta` block in `${CLAUDE_PLUGIN_ROOT}/.claude/workflows/issue-triage-fanout.js`, or the repo README "Arguments" table. READ-ONLY on GitHub — run with a read-scoped `gh` token (README "Security model"); act on results only with the user's confirmation.
