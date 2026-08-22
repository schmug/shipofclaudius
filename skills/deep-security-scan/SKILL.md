---
name: deep-security-scan
description: Higher-recall security audit of a whole repo or a scoped path — prefilter + K threat-model-lensed workers → disprove-first validation → one HTML+markdown report. Use to audit a codebase/path for vulnerabilities (not a diff/PR).
---

Run the `deep-security-scan` dynamic workflow bundled with this plugin by calling the Workflow tool with its bundled script path:

```
Workflow({ scriptPath: "${CLAUDE_PLUGIN_ROOT}/.claude/workflows/deep-security-scan.js", args: { /* fill from the request */ } })
```

Fill `args` from the user's request. Common args: `target` (default `"."`), `scope`, `rounds`, `threshold` (default `low`), `tools`. For the full, current argument list, read the header comment / `meta` block in `${CLAUDE_PLUGIN_ROOT}/.claude/workflows/deep-security-scan.js`, or the repo README "Arguments" table. Read-only analysis; writes a report file.

Reports are written **outside** the target repo's working tree by default (`${TMPDIR:-/tmp}/shipofclaudius-scans/<ts>-<kind>/`) so a routine `git add -A` can never stage unpatched findings; `outputDir` overrides it, and an in-tree override makes the run ensure a `.gitignore` entry first. On a **public** (or unresolved) target the run emits a `DISCLOSURE RISK` warning and returns `disclosure_warning` — route findings to the private intake (`/ghsa`, or `/track-findings` which does it automatically), never a committed report or public PR.
