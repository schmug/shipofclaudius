---
name: routine-anti-noise
description: Read-only skip/anti-duplicate GATE the fleet routines run FIRST on ONE PR or issue → { skip, reason, duplicateComment }. Skips human-flagged/paused/resolved targets and avoids re-posting a comment already left. Never comments/labels/merges.
---

Run the `routine-anti-noise` dynamic workflow bundled with this plugin by calling the Workflow tool with its bundled script path:

```
Workflow({ scriptPath: "${CLAUDE_PLUGIN_ROOT}/.claude/workflows/routine-anti-noise.js", args: { /* fill from the request */ } })
```

Fill `args` from the request. Required: `number` (the PR or issue to gate). Common args: `repo`, `intent` (the gist of the comment you plan to post — enables the anti-duplicate check), `labels` (override the skip-label set), `signature`, `commentLimit`, `readonlyAgent`. For the full, current argument list read the header comment / `meta` block in `${CLAUDE_PLUGIN_ROOT}/.claude/workflows/routine-anti-noise.js`, or the repo README.

READ-ONLY: it returns a decision (`{ skip, reason, duplicateComment }`) — it never comments, labels, or merges; the caller acts on the decision. All issue/PR/comment text is treated as untrusted data. Run under a read-scoped `gh` token.
