---
name: factory-land
description: The software factory's gated landing step — gather ONE PR, its linked issue, the required-check rollup, and the repo's gate config (read from the BASE ref, never the PR), run the deterministic model-free merge gate, post the verdict table as an audit comment, and squash-merge only when all nine fail-closed conditions pass. Stages by default and writes nothing; execute:true is the explicit approval that merges.
---

Run the `factory-land` dynamic workflow bundled with this plugin by calling the Workflow tool with its bundled script path, injecting the bundled gate binary:

```
Workflow({ scriptPath: "${CLAUDE_PLUGIN_ROOT}/.claude/workflows/factory-land.js", args: { pr: 900, repo: "owner/name", gateBin: "${CLAUDE_PLUGIN_ROOT}/packages/factory-gate/bin/gate.mjs" } })
```

Always pass `gateBin` as shown so the gate that runs is the one bundled with **this** plugin checkout rather than whatever happens to sit in the target repo. Without it the workflow falls back to a relative `packages/factory-gate/bin/gate.mjs`, which only resolves when the cwd is a repo that vendors the gate itself.

Args: `pr` (**required** — the PR number; `number` also accepted), `repo?`, `execute?` (default `false`), `issue?` (override the `Closes #N` routing), `evidence?` (the `{ fixtureTest, redOnBase, greenOnHead }` block returned by `factory-issue-fix`), `gateBin?`, `gateFromRef?` (default `main`), `readonlyAgent?` (default `Explore`). For the full, current list read the header comment / `meta` block in `${CLAUDE_PLUGIN_ROOT}/.claude/workflows/factory-land.js`, or the repo README "Arguments" table.

**STAGE-BY-DEFAULT.** A bare run gathers, gates, and returns the verdict plus the exact audit comment it *would* post — writing **nothing at all**, not even that comment. `execute: true` is the explicit one-pass human approval that lets it comment, label, and merge.

**WRITES (merges) under `execute: true`** — needs a **write-scoped** `gh` token. `readonlyAgent` scopes only the relays and the gate runner, never the land actor.

The merge decision is **not model-mediated**. The Workflow runtime gives a script no `import`, so the gate cannot literally be called in-process; instead the real `packages/factory-gate` binary is executed by a read-only relay running one fixed command, and the decision is **re-derived in script code** from the full verdict record — the exit code (`0` merge / `2` escalate / `1` the gate broke), `pass`, `outcome`, the `failed` list, and all nine named conditions must independently agree. Any disagreement is a gate-integrity failure that escalates and merges nothing. The repo's `.factory/gate.json` is read from `gateFromRef` (default `main`), so a PR cannot widen the rules it is judged by.

Never uses `--admin`, never `--delete-branch`, never force-pushes, never rebases. On escalate it posts the verdict table, applies `needs-you`, and merges nothing. For an ordinary (non-factory) PR use `merge-pr-with-gate`; for a chain of stacked PRs use `stacked-merge-walk`.
