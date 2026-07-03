---
name: routine-anti-noise
description: Read-only anti-noise gate for fleet routines - checks skip-labels (target + linked issue) and scans recent comments for an existing same-intent Claude-signed comment before a routine posts.
---

Run the `routine-anti-noise` dynamic workflow bundled with this plugin by calling the Workflow tool with its bundled script path:

```
Workflow({ scriptPath: "${CLAUDE_PLUGIN_ROOT}/.claude/workflows/routine-anti-noise.js", args: { /* fill from the request */ } })
```

Fill `args` from the request. Required: `number` (the issue or PR to gate). Common optional args: `repo`, `type` (`"issue"`/`"pr"` hint), `skipLabels` (override the default skip-label list), `intent` (the comment the caller is about to post, for a targeted duplicate check), `readonlyAgent`. For the full, current argument list, read the header comment / `meta` block in `${CLAUDE_PLUGIN_ROOT}/.claude/workflows/routine-anti-noise.js`, or the repo README "Arguments" table. READ-ONLY — returns a `{skip, reason}` / `{duplicateComment}` decision object; never posts, labels, or merges.
