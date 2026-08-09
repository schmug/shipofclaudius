---
name: security-diff-scan
description: Change-scoped security review of a git diff / PR / working tree → one HTML+markdown report with a coverage statement. Use to review a change for security regressions (not a whole-repo audit). Also covers CI/CD pipeline abuse — workflow injection, secret exfiltration, self-hosted runner abuse, pwn requests, cache poisoning, permission widening — when the change touches `.github/workflows`, GitLab CI, Azure pipelines, or other build/release automation.
---

Run the `security-diff-scan` dynamic workflow bundled with this plugin by calling the Workflow tool with its bundled script path:

```
Workflow({ scriptPath: "${CLAUDE_PLUGIN_ROOT}/.claude/workflows/security-diff-scan.js", args: { /* fill from the request */ } })
```

Fill `args` from the user's request. Common args: `base` (default `main`), `head`, `pr`+`repo`, `threshold`, `rounds`. The CI/CD pipeline-abuse lens is **automatic** — it activates on its own when the resolved diff touches pipeline config, so do not pass anything for it; `cicdLens: true|false` only exists to force the gate. For the full, current argument list, read the header comment / `meta` block in `${CLAUDE_PLUGIN_ROOT}/.claude/workflows/security-diff-scan.js`, or the repo README "Arguments" table. Read-only on the change; PR mode fences untrusted PR text; writes a report.
