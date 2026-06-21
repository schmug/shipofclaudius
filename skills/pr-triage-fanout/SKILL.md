---
name: pr-triage-fanout
description: Read-only fan-out triage of your open PRs → MERGE/CLOSE/REBASE/FIX_CI/COMMENT/AWAITING_HUMAN/ESCALATE with CI verdict + mergeability.
---

Run the `pr-triage-fanout` dynamic workflow bundled with this plugin by calling the Workflow tool with its bundled script path:

```
Workflow({ scriptPath: "${CLAUDE_PLUGIN_ROOT}/.claude/workflows/pr-triage-fanout.js", args: { /* fill from the request */ } })
```

Fill `args` from the user's request. Common args: `numbers` (subset; omit to auto-gather), `repo`, `author`, `notes`. For the full, current argument list, read the header comment / `meta` block in `${CLAUDE_PLUGIN_ROOT}/.claude/workflows/pr-triage-fanout.js`, or the repo README "Arguments" table. READ-ONLY; triages only the resolved author's PRs; read-scoped `gh` token.
