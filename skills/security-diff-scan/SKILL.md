---
name: security-diff-scan
description: Change-scoped security review of a git diff / PR / working tree → one HTML+markdown report with a coverage statement. Use to review a change for security regressions (not a whole-repo audit). Also covers CI/CD pipeline abuse — workflow injection, secret exfiltration, self-hosted runner abuse, pwn requests, cache poisoning, permission widening — when the change touches `.github/workflows`, GitLab CI, Azure pipelines, or other build/release automation.
---

Run the `security-diff-scan` dynamic workflow bundled with this plugin by calling the Workflow tool with its bundled script path:

```
Workflow({ scriptPath: "${CLAUDE_PLUGIN_ROOT}/.claude/workflows/security-diff-scan.js", args: { /* fill from the request */ } })
```

Fill `args` from the user's request. Common args: `base` (default `main`), `head`, `pr`+`repo`, `threshold`, `rounds`. The CI/CD pipeline-abuse lens is **automatic** — it activates on its own when the resolved diff touches pipeline config, so do not pass anything for it; `cicdLens: true|false` only exists to force the gate. For the full, current argument list, read the header comment / `meta` block in `${CLAUDE_PLUGIN_ROOT}/.claude/workflows/security-diff-scan.js`, or the repo README "Arguments" table. Read-only on the change; PR mode fences untrusted PR text; writes a report.

Reports are written **outside** the target repo's working tree by default (`${TMPDIR:-/tmp}/shipofclaudius-scans/<ts>-<kind>/`) so a routine `git add -A` can never stage unpatched findings; `outputDir` overrides it, and an in-tree override makes the run ensure a `.gitignore` entry first. On a **public** (or unresolved) target the run emits a `DISCLOSURE RISK` warning and returns `disclosure_warning` — route findings to the private intake (`/ghsa`, or `/track-findings` which does it automatically), never a committed report or public PR.
