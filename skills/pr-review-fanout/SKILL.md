---
name: pr-review-fanout
description: Read-only deep review of ONE PR's diff — fan out review dimensions → adversarially verify each finding → one HTML+markdown review traced to file:line.
---

Run the `pr-review-fanout` dynamic workflow bundled with this plugin by calling the Workflow tool with its bundled script path:

```
Workflow({ scriptPath: "${CLAUDE_PLUGIN_ROOT}/.claude/workflows/pr-review-fanout.js", args: { /* fill from the request */ } })
```

Fill `args` from the user's request. Common args: `number`/`pr` (required), `repo`, `dimensions`, `threshold`. For the full, current argument list, read the header comment / `meta` block in `${CLAUDE_PLUGIN_ROOT}/.claude/workflows/pr-review-fanout.js`, or the repo README "Arguments" table. READ-ONLY; reviews/reports only, never comments/merges; read-scoped `gh` token.
