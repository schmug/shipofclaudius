---
name: stacked-impl-lanes
description: Implements issue-lanes into review-only PRs (parallel if file-disjoint, sequential + stacked if hub-coupled); security-hardening review on invariant lanes.
---

Run the `stacked-impl-lanes` dynamic workflow bundled with this plugin by calling the Workflow tool with its bundled script path:

```
Workflow({ scriptPath: "${CLAUDE_PLUGIN_ROOT}/.claude/workflows/stacked-impl-lanes.js", args: { /* fill from the request */ } })
```

Fill `args` from the user's request. Common args: `lanes` (required), `mode`, `base`, `repo`. For the full, current argument list, read the header comment / `meta` block in `${CLAUDE_PLUGIN_ROOT}/.claude/workflows/stacked-impl-lanes.js`, or the repo README "Arguments" table. WRITES — opens PRs; needs write scope. Do NOT run under a read-only token; see the workflow header for its safety gates.
