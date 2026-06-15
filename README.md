# shipofcladius

A curated collection of **dynamic workflows** for the Claude Code [Workflow tool](https://docs.claude.com/en/docs/claude-code) — deterministic, multi-agent orchestration scripts that fan out subagents, verify their findings, and synthesize results.

Each workflow is a self-contained JavaScript file that begins with an `export const meta = {…}` block and drives a body of `agent()` / `parallel()` / `pipeline()` / `phase()` / `workflow()` calls. They run in the background under the Workflow tool and report progress through `/workflows`.

> These are snapshots of the author's global workflows that normally live in `~/.claude/workflows/`. This repo is the versioned, shareable home for them — the live copies stay in place and are kept in sync by hand.
>
> *Hence the name. Replace every plank of a ship over the years and philosophers ask whether it's still the [Ship of Theseus](https://en.wikipedia.org/wiki/Ship_of_Theseus). Hand-sync every workflow out of `~/.claude/workflows/` into this repo, plank by plank, and you get the Ship of **Cladius** — same paradox, more Claude. Whether it's still the same ship is left as an exercise for the agents.*

## Workflows

| File | Name | What it does |
|------|------|--------------|
| [`deep-security-scan.js`](deep-security-scan.js) | `deep-security-scan` | Higher-recall repo security audit: a deterministic prefilter (foxguard: SAST/secrets/SCA) feeds K independent threat-model-lensed discovery workers → semantic merge → disprove-first validation → one HTML + markdown report. For a whole repo or a scoped path — **not** diffs/PRs. |
| [`defense-scan.js`](defense-scan.js) | `defense-scan` | Defense-in-depth orchestrator. Composes `deep-security-scan` (code-at-rest) with opt-in layers — supply-chain (bumblebee), DAST (vigolium), LLM red-team (garak), network/template scan (nuclei), and project-posture/governance (OpenSSF Scorecard vs. the OSPS Baseline) — into one merged report with a per-layer coverage statement. |
| [`issue-triage-fanout.js`](issue-triage-fanout.js) | `issue-triage-fanout` | Read-only fan-out: one agent per open GitHub issue → `GREEN` / `DECISION` / `RESEARCH` / `DONE` / `BLOCKED`, with grouping and dependencies. Auto-gathers open issues when none are passed. |
| [`issue-research-fanout.js`](issue-research-fanout.js) | `issue-research-fanout` | Web-enabled fan-out over the `RESEARCH` bucket: one agent per issue investigates (codebase + `gh` + web) and returns a verdict, aiming to move research issues to `GREEN` with an implementable spec. Read-only on GitHub. |
| [`pr-triage-fanout.js`](pr-triage-fanout.js) | `pr-triage-fanout` | Read-only fan-out: one agent per open PR → `MERGE` / `CLOSE` / `REBASE` / `FIX_CI` / `COMMENT` / `AWAITING_HUMAN` / `ESCALATE`, with a CI verdict, mergeability, and comment state. |
| [`stacked-impl-lanes.js`](stacked-impl-lanes.js) | `stacked-impl-lanes` | Implements issue-lanes into review-only PRs (parallel if disjoint, sequential + stacked if hub-coupled), then runs a security-hardening review on each invariant-touching lane. |

## Running a workflow

These run inside Claude Code, not as standalone Node programs. To use one:

1. Copy (or symlink) the `.js` file into `~/.claude/workflows/`.
2. In a Claude Code session, the workflow becomes available to the Workflow tool by its `meta.name`, e.g. `Workflow({ name: 'deep-security-scan', args: { target: '.' } })`, and shows up under `/workflows`.

Several of these are also surfaced as user-invocable skills (e.g. `/deep-security-scan`, `/defense-scan`).

## Tests

The `tests/` directory holds **offline simulators**. They wrap each workflow's source in an `AsyncFunction` with stubbed runtime globals (`agent()` / `parallel()` / `phase()` / `log()` / `workflow()`), so orchestration logic — dedup precedence, fail-open behavior, layer gating, coverage wiring, schema satisfiability — is exercised in milliseconds at **zero token cost**. They use only Node built-ins (`node:fs/promises`, `node:assert/strict`); no dependencies to install.

```bash
npm test          # runs both suites
# or individually:
node tests/dss-sim.test.mjs
node tests/defense-scan.test.mjs
```

Requires Node ≥ 18 (developed on Node 22). Current status: **54 passing** (16 + 38), 0 failing.

## Layout

```
shipofcladius/
├── deep-security-scan.js
├── defense-scan.js
├── issue-research-fanout.js
├── issue-triage-fanout.js
├── pr-triage-fanout.js
├── stacked-impl-lanes.js
└── tests/
    ├── dss-sim.test.mjs          # simulates deep-security-scan.js
    └── defense-scan.test.mjs     # simulates defense-scan.js
```

The test files resolve their target with `new URL('../<workflow>.js', import.meta.url)`, so `tests/` must stay a sibling of the workflow files.
