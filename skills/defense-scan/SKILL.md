---
name: defense-scan
description: Defense-in-depth security orchestrator — composes deep-security-scan with opt-in supply-chain / DAST / LLM-red-team / network / governance layers into one merged report with a per-layer coverage statement.
---

Run the `defense-scan` dynamic workflow bundled with this plugin by calling the Workflow tool with its bundled script path:

```
Workflow({ scriptPath: "${CLAUDE_PLUGIN_ROOT}/.claude/workflows/defense-scan.js", args: { /* fill from the request */ } })
```

Fill `args` from the user's request. Common args: `target`, `rounds`, `threshold`, `supplyChain`, `url`+`authorized`, `repo`. For the full, current argument list, read the header comment / `meta` block in `${CLAUDE_PLUGIN_ROOT}/.claude/workflows/defense-scan.js`, or the repo README "Arguments" table. Layers 2–6 are opt-in / authorization-gated and fail-open; writes a report.
