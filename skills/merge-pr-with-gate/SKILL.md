---
name: merge-pr-with-gate
description: Gates ONE pull request and squash-merges it only if green (mergeStateStatus + required-check rollup, UNKNOWN=must-verify) — a standalone single-PR slice of stacked-merge-walk's landing gate with no stacking/rebasing. Stages by default; execute:true records the caller's gate decision to merge (gated-autonomous — agent-decided when the deterministic gate passes). Use when you want to land ONE already-green, non-factory PR through the same gate stacked-merge-walk uses, without any stacking or rebasing; for a chain of stacked PRs use stacked-merge-walk, and for a factory-produced PR use factory-land.
argument-hint: <pr-number>
---

Run the `merge-pr-with-gate` dynamic workflow bundled with this plugin by calling the Workflow tool with its bundled script path:

```
Workflow({ scriptPath: "${CLAUDE_PLUGIN_ROOT}/.claude/workflows/merge-pr-with-gate.js", args: { /* fill from the request */ } })
```

Fill `args` from the user's request. Common args: `pr` (required — the PR number to gate), `repo`, `execute` (default `false` = stage/verify only; `true` = the caller's recorded gate decision: squash-merge if green — agent-decided when the deterministic gate passes, per the 2026-08-15 merge-authority policy), `readonlyAgent`. For the full, current argument list, read the header comment / `meta` block in `${CLAUDE_PLUGIN_ROOT}/.claude/workflows/merge-pr-with-gate.js`, or the repo README "Arguments" table. WRITES — needs write scope; it stages/gates by default and only squash-merges a green PR under `execute: true`. It does NOT rebase or resolve conflicts — a BEHIND/DIRTY/blocked PR escalates to a human (use `stacked-merge-walk` for a stack).
