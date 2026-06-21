---
name: issue-research-fanout
description: Web-enabled fan-out over the RESEARCH bucket — one agent per issue investigates (codebase + gh + web) and returns a verdict aiming to move it to GREEN with an implementable spec.
---

Run the `issue-research-fanout` dynamic workflow bundled with this plugin by calling the Workflow tool with its bundled script path:

```
Workflow({ scriptPath: "${CLAUDE_PLUGIN_ROOT}/.claude/workflows/issue-research-fanout.js", args: { /* fill from the request */ } })
```

Fill `args` from the user's request. Common args: `numbers` (required — the triage RESEARCH bucket), `triaged`, `label`, `repo`. For the full, current argument list, read the header comment / `meta` block in `${CLAUDE_PLUGIN_ROOT}/.claude/workflows/issue-research-fanout.js`, or the repo README "Arguments" table. READ-ONLY on GitHub; uses the web; read-scoped `gh` token.
