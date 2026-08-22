---
name: stacked-merge-walk
description: Lands a chain of stacked PRs onto a moving base (base-first, gate-verified, rebase-own-commits, escalate real conflicts). The terminal write step of the dev-lifecycle pipeline. Use after stacked-impl-lanes has opened a chain of stacked PRs and you want to land the whole stack in order; for a single ordinary PR use merge-pr-with-gate, and for a factory-produced PR use factory-land.
---

Run the `stacked-merge-walk` dynamic workflow bundled with this plugin by calling the Workflow tool with its bundled script path:

```
Workflow({ scriptPath: "${CLAUDE_PLUGIN_ROOT}/.claude/workflows/stacked-merge-walk.js", args: { /* fill from the request */ } })
```

Fill `args` from the user's request. Common args: `prs` (required, base-first), `base`, `repo`, `execute`. For the full, current argument list, read the header comment / `meta` block in `${CLAUDE_PLUGIN_ROOT}/.claude/workflows/stacked-merge-walk.js`, or the repo README "Arguments" table. WRITES — needs write scope; see the workflow header for its safety gates (it stages/gates before landing).

If a landed PR comes back `status: 'ESCALATED'` (a real/semantic conflict, or an unresolved `UNKNOWN`, that a human must resolve), hand its `{ ref, conflicts, escalation }` payload to the bundled `resolve-merge-conflict` skill — it recovers each side's intent from commits/PRs/issues before proposing a fix, rather than leaving the escalation nowhere to land.
