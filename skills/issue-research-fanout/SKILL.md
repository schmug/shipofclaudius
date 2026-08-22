---
name: issue-research-fanout
description: Web-enabled fan-out over the RESEARCH bucket — one agent per issue investigates (codebase + gh + web) and returns GREEN/DECISION/BLOCKED/STILL_RESEARCH, aiming to move each issue to GREEN with an implementable spec and a lane-shaped handoff. Read-only on GitHub. Use after issue-triage-fanout has bucketed the backlog and you want its RESEARCH issues resolved into buildable ones — work out what this issue actually needs, unblock the research pile. Not for classifying the backlog in the first place (use issue-triage-fanout, which produces the numbers this takes) and not for implementing the result (use stacked-impl-lanes).
---

Run the `issue-research-fanout` dynamic workflow bundled with this plugin by calling the Workflow tool with its bundled script path:

```
Workflow({ scriptPath: "${CLAUDE_PLUGIN_ROOT}/.claude/workflows/issue-research-fanout.js", args: { /* fill from the request */ } })
```

Fill `args` from the user's request. Common args: `numbers` (required — the triage RESEARCH bucket), `triaged`, `label`, `repo`. For the full, current argument list, read the header comment / `meta` block in `${CLAUDE_PLUGIN_ROOT}/.claude/workflows/issue-research-fanout.js`, or the repo README "Arguments" table. READ-ONLY on GitHub; uses the web; read-scoped `gh` token.
