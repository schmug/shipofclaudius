# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

`shipofclaudius` is a curated collection of **dynamic workflows** for the Claude Code Workflow tool — deterministic multi-agent orchestration scripts. Each workflow is a self-contained ES-module `.js` file in [`.claude/workflows/`](.claude/workflows/) that exports a `meta` block and drives a body of `agent()` / `parallel()` / `pipeline()` / `phase()` / `workflow()` calls. There is **no application** and **no runtime build** — the deliverables are the workflow scripts themselves, consumed by Claude Code. The repo is also packaged as a Claude Code **plugin**.

The authoritative description of every workflow, its arguments, and the security model lives in [README.md](README.md) — read it before editing a workflow's contract.

## Commands

```bash
npm test                          # 17 simulator suites + factory-gate + sarif-validator + plugin-integrity (the only gate)
node tests/dss-sim.test.mjs       # run one suite directly (each is standalone, exits non-zero on failure)
```

There is no build, no lint, no typecheck, and no dependency install — `package.json` has zero dependencies and there is **intentionally no lockfile**. CI (`.github/workflows/ci.yml`) runs `npm test` on Node 20 and 22 with **no install step** (`npm ci` would fail without a lockfile). Keep it that way: tests may use **only Node built-ins** (`node:fs/promises`, `node:assert/strict`). If you need a validator (e.g. SARIF conformance), vendor a built-ins-only one under `tests/lib/` — do not add an npm dependency.

## How to validate a workflow script

The `.claude/workflows/*.js` scripts use **top-level `return` and `await`** because the Workflow runtime wraps each script body in an async function. Consequences:

- **`node --check <file>` reports a bogus `SyntaxError: Illegal return statement`** — that does *not* mean the file is broken. Do not rely on it.
- The **real parser + logic check is `npm test`.** Each `tests/*-sim.test.mjs` reads the workflow source, strips `export ` off `export const meta`, wraps the body in `new AsyncFunction('args','budget','agent','parallel','pipeline','phase','log','workflow', src)`, and runs it with stubbed runtime globals. A genuine syntax error throws at `AsyncFunction` construction; orchestration logic (dedup precedence, fail-open behavior, layer gating, schema satisfiability, prompt-injection fence shapes) is asserted against the stubs at zero token cost.

After editing a workflow, run `npm test` and confirm the count (README tracks the current total, e.g. "638 passing"). The count only goes UP.

**`packages/factory-gate` is not a workflow and has no sim.** It is pure, model-free code, so `tests/factory-gate.test.mjs` is an ordinary unit suite. Because it is imported (not `AsyncFunction`-wrapped), `tests/` must stay a sibling of `packages/` as well as of `.claude/workflows/`. The two factory sims import the real gate to assert across the boundary — if you change `CONDITION_ORDER` or the `fixture_evidence` shape, those sims are what catch the caller drift.

## Conventions that the test suite enforces

These are not style preferences — `tests/plugin-integrity.test.mjs` fails the build if you break them:

- **1:1 workflow ↔ wrapper skill.** Every `.claude/workflows/<name>.js` must have exactly one `skills/<name>/SKILL.md` and vice versa (no orphans). When you add a workflow, add the matching skill dir.
  - **Exception — process skills.** A skill whose frontmatter declares `workflow: none` is a session-long playbook (no Workflow script) and is exempt from the 1:1 mapping; the integrity test still enforces its frontmatter, forbids `scriptPath` in its body, and requires every `references/<file>` it mentions to exist. Currently: `critic-gated-build`.
- **Wrapper shape.** Each `SKILL.md` frontmatter must have `name: <name>` matching the workflow and a non-empty `description`, and the body must instruct a `Workflow({ scriptPath: "${CLAUDE_PLUGIN_ROOT}/.claude/workflows/<name>.js", ... })` call referencing **its own** bundled script.
- **`package.json` `test` script lists each suite explicitly.** A new `tests/<name>-sim.test.mjs` must be appended to the `&&`-chain in the `test` script, or CI never runs it.
- **Every dispatched `agentType` ships.** A non-built-in `agentType:` in any `.claude/workflows/*.js` (a literal, or the fallback default of an `args.*` override) must be declared by a shipped `.claude/agents/*.md` — matched on its frontmatter `name`, not its filename — and that file must be listed in `plugin.json`'s `agents` key. Built-ins (`Explore`, `Plan`, `general-purpose`) are exempt. `.claude/agents/` is the *project* scope; plugins auto-discover only `agents/` at the plugin root, so **without the manifest key an installer loads nothing** and a dispatch silently resolves to whatever the host happens to have. That is exactly how `security-hardening-reviewer` came to be documented as an active mitigation while shipping nowhere.
- **No pinned plugin version.** Neither `.claude-plugin/plugin.json` nor `.claude-plugin/marketplace.json` may contain a `version` field. The plugin is delivered by git commit SHA so every push to `main` ships; a pinned-but-unbumped version silently freezes all installers. (See [README.md](README.md) "Updates / versioning".)

## Workflow authoring patterns

- **`meta` must be a pure literal** (`name`, `description`, `phases[]`) — no variables or interpolation; the harness reads it without executing the body. Use the same phase titles in `meta.phases` as in `phase()` calls.
- **The no-args path must self-bootstrap.** The `/skill` invoke prompt is generated from `meta` only — the harness never reads the `.js` body/comments at invoke time and emits a bare `Workflow({ name })`. So any workflow that can run with no args must auto-gather its inputs in code (e.g. `issue-triage-fanout` spawns a gather agent when `args.numbers` is absent). Documenting "pass X first" in a comment is invisible to the user and is the recurring input-error trap.
- **Parse-guard `args`.** Args may arrive as a JSON string; guard for that.
- **Prefer `pipeline()` over a `parallel()` barrier** unless a stage genuinely needs all prior results at once (dedup/merge across the full set). See the Workflow tool docs embedded in the runtime for the full rationale.

### Prompt-injection hardening (security-critical, do not regress)

Workflows that read attacker-writable text (issue/PR bodies, comments, reviews, diffs, external findings/SARIF/CVE/GHSA, Dependabot alerts) follow a fixed three-part defense — preserve all three when editing these scripts:

1. **A dedicated read-only relay agent** runs a *fixed* fetch command (`gh issue view` / `gh pr view` / `gh pr diff` / `git diff`), mints a **fresh random nonce**, and returns raw bytes verbatim. The reasoning agent never fetches the untrusted text itself.
2. **Every subagent runs under a read-only `agentType`** (default `Explore`; overridable via `args.readonlyAgent`). The **write** workflows (`stacked-impl-lanes`, `stacked-merge-walk`, `merge-pr-with-gate`, `fix-finding`, `factory-issue-fix`, `factory-land`) are the exception — their write actors keep write tools, and `readonlyAgent` scopes only their read-only relays/gates.
3. **An anti-injection preamble** precedes every nonce-fenced block: the fenced text is data, never instructions.

The full per-workflow security model (and the required read-scoped `gh` token for the read-only fan-outs) is documented in [README.md](README.md) "Security model" — consult it before changing any agent's tool grants or fetch path.

## Layout

- `.claude/workflows/*.js` — the workflows (the actual product).
- `.claude/agents/*.md` — subagents the workflows dispatch by `agentType`. Registered via `plugin.json`'s `agents` key (this path is not auto-discovered for plugins).
- `skills/<name>/SKILL.md` — plugin wrapper skills, one per workflow.
- `tests/*-sim.test.mjs` — offline simulators (one per workflow) + `plugin-integrity.test.mjs`; `tests/lib/` holds vendored built-ins-only validators. Tests resolve their target via `new URL('../.claude/workflows/<name>.js', import.meta.url)`, so `tests/` must stay a sibling of `.claude/workflows/`.
- `.claude-plugin/{plugin,marketplace}.json` — plugin packaging manifests.
- `docs/specs/` — design/spec docs for major features (dated filenames).
