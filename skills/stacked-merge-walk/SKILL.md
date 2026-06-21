---
name: stacked-merge-walk
description: Lands a chain of stacked PRs onto a moving base (base-first, gate-verified, rebase-own-commits, escalate real conflicts). The terminal write step of the dev-lifecycle pipeline.
---

Run the `stacked-merge-walk` dynamic workflow bundled with this plugin by calling the Workflow tool with its bundled script path:

```
Workflow({ scriptPath: "${CLAUDE_PLUGIN_ROOT}/.claude/workflows/stacked-merge-walk.js", args: { /* fill from the request */ } })
```

Fill `args` from the user's request. Common args: `prs` (required, base-first), `base`, `repo`, `execute`. For the full, current argument list, read the header comment / `meta` block in `${CLAUDE_PLUGIN_ROOT}/.claude/workflows/stacked-merge-walk.js`, or the repo README "Arguments" table. WRITES — needs write scope; see the workflow header for its safety gates (it stages/gates before landing).
