---
name: issue-triage-fanout
description: Read-only fan-out triage of open GitHub issues → GREEN/DECISION/RESEARCH/DONE/BLOCKED with grouping + dependencies. Auto-gathers all open issues when none are given.
---

Run the `issue-triage-fanout` dynamic workflow bundled with this plugin by calling the Workflow tool with its bundled script path:

```
Workflow({ scriptPath: "${CLAUDE_PLUGIN_ROOT}/.claude/workflows/issue-triage-fanout.js", args: { /* fill from the request */ } })
```

Fill `args` from the user's request. Common args: `numbers` (subset; omit to auto-gather), `repo`, `notes`, `readonlyAgent`. For the full, current argument list, read the header comment / `meta` block in `${CLAUDE_PLUGIN_ROOT}/.claude/workflows/issue-triage-fanout.js`, or the repo README "Arguments" table. READ-ONLY on GitHub — run with a read-scoped `gh` token (README "Security model"); act on results only with the user's confirmation.
