# shipofcladius

A curated collection of **dynamic workflows** for the Claude Code [Workflow tool](https://docs.claude.com/en/docs/claude-code) — deterministic, multi-agent orchestration scripts that fan out subagents, verify their findings, and synthesize results.

Each workflow is a self-contained JavaScript file that begins with an `export const meta = {…}` block and drives a body of `agent()` / `parallel()` / `pipeline()` / `phase()` / `workflow()` calls. They run in the background under the Workflow tool and report progress through `/workflows`.

> These are snapshots of the author's global workflows that normally live in `~/.claude/workflows/`. This repo is the versioned, shareable home for them — the live copies stay in place and are kept in sync by hand.

## Workflows

| File | Name | What it does |
|------|------|--------------|
| [`deep-security-scan.js`](deep-security-scan.js) | `deep-security-scan` | Higher-recall repo security audit: a deterministic prefilter (foxguard: SAST/secrets/SCA) feeds K independent threat-model-lensed discovery workers → semantic merge → disprove-first validation → one HTML + markdown report. For a whole repo or a scoped path — **not** diffs/PRs. |
| [`defense-scan.js`](defense-scan.js) | `defense-scan` | Defense-in-depth orchestrator. Composes `deep-security-scan` (code-at-rest) with opt-in layers — supply-chain (bumblebee), DAST (vigolium), LLM red-team (garak), network/template scan (nuclei), and project-posture/governance (OpenSSF Scorecard vs. the OSPS Baseline) — into one merged report with a per-layer coverage statement. |
| [`issue-triage-fanout.js`](issue-triage-fanout.js) | `issue-triage-fanout` | Read-only fan-out: one agent per open GitHub issue → `GREEN` / `DECISION` / `RESEARCH` / `DONE` / `BLOCKED`, with grouping and dependencies. Auto-gathers open issues when none are passed. |
| [`issue-research-fanout.js`](issue-research-fanout.js) | `issue-research-fanout` | Web-enabled fan-out over the `RESEARCH` bucket: one agent per issue investigates (codebase + `gh` + web) and returns a verdict, aiming to move research issues to `GREEN` with an implementable spec. Read-only on GitHub. |
| [`pr-triage-fanout.js`](pr-triage-fanout.js) | `pr-triage-fanout` | Read-only fan-out: one agent per open PR → `MERGE` / `CLOSE` / `REBASE` / `FIX_CI` / `COMMENT` / `AWAITING_HUMAN` / `ESCALATE`, with a CI verdict, mergeability, and comment state. Triages only your own PRs (the authenticated `gh` user by default). |
| [`stacked-impl-lanes.js`](stacked-impl-lanes.js) | `stacked-impl-lanes` | Implements issue-lanes into review-only PRs (parallel if disjoint, sequential + stacked if hub-coupled), then runs a security-hardening review on each invariant-touching lane. |

## Install

These run **inside Claude Code**, not as standalone Node programs. Make a workflow available by copying (or symlinking) its `.js` file into your global workflows directory:

```bash
cp deep-security-scan.js ~/.claude/workflows/
# or symlink so edits here are picked up live:
ln -s "$PWD/deep-security-scan.js" ~/.claude/workflows/deep-security-scan.js
```

Once a file is in `~/.claude/workflows/`, Claude Code exposes it to the Workflow tool by its `meta.name` and lists it under `/workflows`. Several are also surfaced as user-invocable skills (e.g. `/deep-security-scan`, `/defense-scan`).

## Using a workflow

### As a user (in a Claude Code session)

You don't call these directly — you ask Claude, and it drives the Workflow tool for you. Any of these work:

- **Natural language:** *"Run a deep security scan on this repo,"* or *"Triage all my open PRs."* Claude picks the matching workflow and fills in the arguments.
- **Slash command**, for the ones surfaced as skills: `/deep-security-scan`, `/defense-scan`.
- **Watch it run:** open `/workflows` to see the live progress tree (phases, per-agent status). Workflows run in the background, so you can keep working while one is in flight.

The **read-only** workflows (`issue-triage-fanout`, `issue-research-fanout`, `pr-triage-fanout`) only *classify* — they never edit, comment, or merge. Claude turns their structured output into a plan and executes follow-ups **with your confirmation**.

### As an agent (driving the Workflow tool)

Invoke an installed workflow by `meta.name`, or run a file straight from disk by path:

```js
// by name (after it's installed in ~/.claude/workflows/)
Workflow({ name: "deep-security-scan", args: { target: ".", rounds: 4 } })

// or directly by path, no install step
Workflow({ scriptPath: "~/.claude/workflows/pr-triage-fanout.js" })
```

`Workflow` returns immediately with a run ID and fires a notification when the run completes; the script's final `return` value (findings, triage verdicts, report paths) comes back as the result. Pass `args` as a real JSON value — the scripts also parse-guard a JSON **string**, but a value is preferred.

#### Arguments

| Workflow | Key args | Notes |
|----------|----------|-------|
| `deep-security-scan` | `target` (default `"."`), `scope?`, `rounds?` (default 4 / budget-scaled), `lenses?`, `threshold?` (`critical`…`info`, default `low`), `tools?` (default `['foxguard']`; `[]` disables Phase 0), `toolSeverity?` | No args required; defaults audit the whole repo at `.`. |
| `defense-scan` | `target`, `scope?`, `rounds?`, `threshold?`, `installMissing?`, `supplyChain?` (default on), `url?` + `authorized?` (DAST), `llmEndpoint?` + `llmConfirmed?` (LLM red-team), `networkTarget?` + `authorized?` (nuclei), `repo?` (posture) | Layer 1 always runs; layers 2–6 are opt-in / authorization-gated and **fail-open**. |
| `issue-triage-fanout` | `numbers?` (subset; auto-gathers all open issues if omitted), `repo?` (`owner/name`), `notes?` | No args required. |
| `issue-research-fanout` | `numbers` (the triage `RESEARCH` bucket), `triaged?` (seed with triage findings), `label?` (default `research`), `repo?`, `notes?` | Chains after `issue-triage-fanout`. |
| `pr-triage-fanout` | `numbers?` (subset; auto-gathers all open PRs if omitted), `repo?`, `author?` (**defaults to the authenticated `gh` user**, auto-detected via `gh api user`), `notes?` | No args required. Triages only the resolved author's PRs; bots and others are dropped (logged). |
| `stacked-impl-lanes` | `lanes` (required: `[{ key, branch, issues, invariant, brief }]`), `mode?` (`parallel` \| `sequential`, default `parallel`), `base?` (default `main`), `repo?` | The only workflow here that **writes** — opens review-only PRs. |

## Tests

The `tests/` directory holds **offline simulators**. They wrap each workflow's source in an `AsyncFunction` with stubbed runtime globals (`agent()` / `parallel()` / `phase()` / `log()` / `workflow()`), so orchestration logic — dedup precedence, fail-open behavior, layer gating, coverage wiring, author resolution, schema satisfiability — is exercised in milliseconds at **zero token cost**. They use only Node built-ins (`node:fs/promises`, `node:assert/strict`); no dependencies to install.

```bash
npm test          # runs all three suites
# or individually:
node tests/dss-sim.test.mjs
node tests/defense-scan.test.mjs
node tests/pr-triage-sim.test.mjs
```

Requires Node ≥ 18 (developed on Node 22). Current status: **60 passing** (16 + 38 + 6), 0 failing.

## Layout

```
shipofcladius/
├── LICENSE
├── deep-security-scan.js
├── defense-scan.js
├── issue-research-fanout.js
├── issue-triage-fanout.js
├── pr-triage-fanout.js
├── stacked-impl-lanes.js
└── tests/
    ├── dss-sim.test.mjs          # simulates deep-security-scan.js
    ├── defense-scan.test.mjs     # simulates defense-scan.js
    └── pr-triage-sim.test.mjs    # simulates pr-triage-fanout.js
```

The test files resolve their target with `new URL('../<workflow>.js', import.meta.url)`, so `tests/` must stay a sibling of the workflow files.

## License

Proprietary — **all rights reserved to schmug**. See [`LICENSE`](LICENSE). Access for viewing or review does not grant any right to use, copy, modify, or distribute the code; that requires the owner's prior written permission.
