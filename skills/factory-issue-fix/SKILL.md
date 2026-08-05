---
name: factory-issue-fix
description: The software factory engine — turn ONE GitHub issue into a reproduced, diagnosed, independently-verified, fixed DRAFT PR. Reproduce (a bug that will not reproduce is never "fixed") → Diagnose (root cause + narrowest boundary) → Verify (an INDEPENDENT model family decides real bug vs intended behaviour) → Fix (worktree-isolated, fixture-first, draft PR only). Self-bootstraps from the factory queue when given no issue; never merges and never pushes main.
---

Run the `factory-issue-fix` dynamic workflow bundled with this plugin by calling the Workflow tool with its bundled script path:

```
Workflow({ scriptPath: "${CLAUDE_PLUGIN_ROOT}/.claude/workflows/factory-issue-fix.js", args: { issue: 123, repo: "owner/name" } })
```

**No args are required.** With no `args.issue` the workflow gathers its own queue read-only (`gh issue list --label factory --label needs-repro`) and advances the oldest candidate, so a bare `Workflow({ name: "factory-issue-fix" })` from a cron or Action driver works. An empty queue is a clean no-op, not an error.

Other args: `repo?`, `base?` (default `main`), `branch?` (default `factory/issue-<N>`), `startAt?` / `stopAfter?` (`reproduce` | `diagnose` | `verify` | `fix` — advance one phase per run and resume from the committed `report.md`), `prior?` / `priorReport?` (hand the previous run's return or report back in on resume), `diagnoseModel?` (default `opus`), `verifyModel?` (default `sonnet`), `confidenceThreshold?` (default `2/3`), `fresh?`, `readonlyAgent?` (default `Explore`). For the full, current list read the header comment / `meta` block in `${CLAUDE_PLUGIN_ROOT}/.claude/workflows/factory-issue-fix.js`, or the repo README "Arguments" table.

**The Verify phase must run on a different model family from Diagnose** — passing the same value for both throws. A same-model verifier agrees with itself, and independence is the entire value of the phase.

**Its Fix phase WRITES** — it commits a fixture, pushes a branch, and opens a **draft** PR, so it needs a **write-scoped** `gh` token. Do NOT run it under the read-only token used by the read-only siblings. `readonlyAgent` scopes only its relays and its three read-only reasoning phases, never the write actor.

The write ladder ends at a **draft PR**: it never merges, never marks a PR ready, never pushes `main`, never uses `--admin`, and never force-pushes. `factory-land` is the only thing that merges. `repro_failed`, `needs_info`, `not_a_bug`, `blocked`, and `skipped_existing` are first-class outcomes that open no PR and spend no write agent.

State advances through issue labels. The workflow does **not** write them itself — it returns a typed `transition: { labels: { add, remove }, comment }` for the calling driver to apply with a plain `gh` call, so the state machine stays deterministic. Returns `evidence: { fixtureTest, redOnBase, greenOnHead }` shaped exactly as the merge gate's `fixture_evidence` input; pass it straight to `factory-land`.
