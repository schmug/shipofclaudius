---
name: defense-scan
description: Defense-in-depth security orchestrator — composes deep-security-scan with opt-in supply-chain / DAST / LLM-red-team / network / governance layers into one merged report with a per-layer coverage statement. Use when one static pass is not enough and you want layered or dynamic coverage plus an explicit statement of what was NOT covered — audit this the way an attacker would, check the supply chain and the running service too. Not for a plain whole-repo or scoped-path audit (use deep-security-scan, which this composes), not for reviewing a change or PR (use security-diff-scan), and not for triaging findings you already have (use triage-finding).
---

Run the `defense-scan` dynamic workflow bundled with this plugin by calling the Workflow tool with its bundled script path:

```
Workflow({ scriptPath: "${CLAUDE_PLUGIN_ROOT}/.claude/workflows/defense-scan.js", args: { /* fill from the request */ } })
```

Fill `args` from the user's request. Common args: `target`, `rounds`, `threshold`, `supplyChain`, `url`+`authorized`, `repo`. For the full, current argument list, read the header comment / `meta` block in `${CLAUDE_PLUGIN_ROOT}/.claude/workflows/defense-scan.js`, or the repo README "Arguments" table. Layers 2–6 are opt-in / authorization-gated and fail-open; writes a report.

Reports are written **outside** the target repo's working tree by default (`${TMPDIR:-/tmp}/shipofclaudius-scans/<ts>-<kind>/`) so a routine `git add -A` can never stage unpatched findings; `outputDir` overrides it, and an in-tree override makes the run ensure a `.gitignore` entry first. On a **public** (or unresolved) target the run emits a `DISCLOSURE RISK` warning and returns `disclosure_warning` — route findings to the private intake (`/ghsa`, or `/track-findings` which does it automatically), never a committed report or public PR.
