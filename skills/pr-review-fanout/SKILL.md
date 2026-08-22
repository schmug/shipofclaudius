---
name: pr-review-fanout
description: Read-only deep review of ONE PR diff — fan out review dimensions, adversarially verify each finding (a skeptic tries to refute it, and refuted or low-confidence findings are dropped), and emit one deduped HTML+markdown review traced to file:line. Reviews and reports only — never comments, never merges. Use when you want a specific PR actually read rather than classified — review PR 412, what is wrong with this diff, is this change safe to land. Not for sorting your whole PR queue by mergeability (use pr-triage-fanout, whose COMMENT verdict this sits behind), not for a security-focused pass over a change (use security-diff-scan), and not for merging (use merge-pr-with-gate).
argument-hint: <pr-number>
---

Run the `pr-review-fanout` dynamic workflow bundled with this plugin by calling the Workflow tool with its bundled script path:

```
Workflow({ scriptPath: "${CLAUDE_PLUGIN_ROOT}/.claude/workflows/pr-review-fanout.js", args: { /* fill from the request */ } })
```

Fill `args` from the user's request. Common args: `number`/`pr` (required), `repo`, `dimensions`, `threshold`. For the full, current argument list, read the header comment / `meta` block in `${CLAUDE_PLUGIN_ROOT}/.claude/workflows/pr-review-fanout.js`, or the repo README "Arguments" table. READ-ONLY; reviews/reports only, never comments/merges; read-scoped `gh` token.
