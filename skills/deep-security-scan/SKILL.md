---
name: deep-security-scan
description: Higher-recall security audit of a whole repo or a scoped path — prefilter + K threat-model-lensed workers → disprove-first validation → one HTML+markdown report. Use to audit a codebase/path for vulnerabilities (not a diff/PR).
---

Run the `deep-security-scan` dynamic workflow bundled with this plugin by calling the Workflow tool with its bundled script path:

```
Workflow({ scriptPath: "${CLAUDE_PLUGIN_ROOT}/.claude/workflows/deep-security-scan.js", args: { /* fill from the request */ } })
```

Fill `args` from the user's request. Common args: `target` (default `"."`), `scope`, `rounds`, `threshold` (default `low`), `tools`. For the full, current argument list, read the header comment / `meta` block in `${CLAUDE_PLUGIN_ROOT}/.claude/workflows/deep-security-scan.js`, or the repo README "Arguments" table. Read-only analysis; writes a report file.
