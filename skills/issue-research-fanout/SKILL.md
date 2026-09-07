---
name: issue-research-fanout
description: Web-enabled fan-out over the RESEARCH bucket — one agent per issue investigates (codebase + gh + web) and returns GREEN/DECISION/BLOCKED/STILL_RESEARCH, aiming to move each issue to GREEN with an implementable spec and a lane-shaped handoff. Read-only on GitHub. Use after issue-triage-fanout has bucketed the backlog and you want its RESEARCH issues resolved into buildable ones — work out what this issue actually needs, unblock the research pile. Not for classifying the backlog in the first place (use issue-triage-fanout, which produces the numbers this takes) and not for implementing the result (use stacked-impl-lanes).
---

Run the `issue-research-fanout` dynamic workflow bundled with this plugin. `Workflow({ scriptPath })` only accepts a path already under the session's working directory (or an added directory) — a plugin-cache path is refused even after being `Read` in-session (see `CLAUDE.md` "Wrapper shape"; reproduced in [#213](https://github.com/schmug/shipofclaudius/issues/213)). So: `Read` `${CLAUDE_PLUGIN_ROOT}/.claude/workflows/issue-research-fanout.js`, then call the Workflow tool with its exact contents as `script`:

```
Workflow({ script: "<the file's exact contents>", args: { /* fill from the request */ } })
```

Fill `args` from the user's request. Common args: `numbers` (required — the triage RESEARCH bucket), `triaged`, `label`, `repo`. For the full, current argument list, read the header comment / `meta` block in `${CLAUDE_PLUGIN_ROOT}/.claude/workflows/issue-research-fanout.js`, or the repo README "Arguments" table. READ-ONLY on GitHub; uses the web; read-scoped `gh` token.
