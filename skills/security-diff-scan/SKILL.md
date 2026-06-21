---
name: security-diff-scan
description: Change-scoped security review of a git diff / PR / working tree → one HTML+markdown report with a coverage statement. Use to review a change for security regressions (not a whole-repo audit).
---

Run the `security-diff-scan` dynamic workflow bundled with this plugin by calling the Workflow tool with its bundled script path:

```
Workflow({ scriptPath: "${CLAUDE_PLUGIN_ROOT}/.claude/workflows/security-diff-scan.js", args: { /* fill from the request */ } })
```

Fill `args` from the user's request. Common args: `base` (default `main`), `head`, `pr`+`repo`, `threshold`, `rounds`. For the full, current argument list, read the header comment / `meta` block in `${CLAUDE_PLUGIN_ROOT}/.claude/workflows/security-diff-scan.js`, or the repo README "Arguments" table. Read-only on the change; PR mode fences untrusted PR text; writes a report.
