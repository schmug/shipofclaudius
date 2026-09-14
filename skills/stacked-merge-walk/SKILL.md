---
name: stacked-merge-walk
description: Lands a chain of stacked PRs onto a moving base (base-first, gate-verified, rebase-own-commits, escalate real conflicts). The terminal write step of the dev-lifecycle pipeline. Use after stacked-impl-lanes has opened a chain of stacked PRs and you want to land the whole stack in order; for a single ordinary PR use merge-pr-with-gate, and for a factory-produced PR use factory-land.
---

Run the `stacked-merge-walk` dynamic workflow bundled with this plugin. `Workflow({ scriptPath })` only accepts a path already under the session's working directory (or an added directory) — a plugin-cache path is refused even after being `Read` in-session (see `CLAUDE.md` "Wrapper shape"; reproduced in [#213](https://github.com/schmug/shipofclaudius/issues/213)). So: `Read` `${CLAUDE_PLUGIN_ROOT}/.claude/workflows/stacked-merge-walk.js`, then call the Workflow tool with its exact contents as `script`:

```
Workflow({ script: "<the file's exact contents>", args: { /* fill from the request */ } })
```

Fill `args` from the user's request. Common args: `prs` (required, base-first), `base`, `repo`, `execute`. For the full, current argument list, read the header comment / `meta` block in `${CLAUDE_PLUGIN_ROOT}/.claude/workflows/stacked-merge-walk.js`, or the repo README "Arguments" table. WRITES — needs write scope; see the workflow header for its safety gates (it stages/gates before landing).

**If the `Workflow(...)` call above is itself denied** by Claude Code's permission system before this script ever runs — the auto-mode classifier can refuse the call outright, staged (`execute` unset) or not; observed denial text includes `[Git Destructive]` and `Blocked by classifier` (see [#228](https://github.com/schmug/shipofclaudius/issues/228)) — that is not a gate verdict on any PR in the stack. The workflow produced no `outcomes`, so there is nothing `STAGED`/`ESCALATED`/`LANDED` to report. Report this distinctly as `BLOCKED_BY_PERMISSION` — name which call was denied (stage, or `execute:true`) and quote the denial text — rather than treating it as an ordinary tool error or walking the stack via raw `gh pr merge`; that bypasses the base-first gate + rebase machinery this skill exists to enforce. The exact trigger for the denial is not yet characterized end-to-end (#228 tracks the controlled measurement); this skill can only document the symptom, not the cause.

If a landed PR comes back `status: 'ESCALATED'` (a real/semantic conflict, or an unresolved `UNKNOWN`, that a human must resolve), hand its `{ ref, conflicts, escalation }` payload to the bundled `resolve-merge-conflict` skill — it recovers each side's intent from commits/PRs/issues before proposing a fix, rather than leaving the escalation nowhere to land.
