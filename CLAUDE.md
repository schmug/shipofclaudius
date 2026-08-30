# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

`shipofclaudius` is a curated collection of **dynamic workflows** for the Claude Code Workflow tool — deterministic multi-agent orchestration scripts. Each workflow is a self-contained ES-module `.js` file in [`.claude/workflows/`](.claude/workflows/) that exports a `meta` block and drives a body of `agent()` / `parallel()` / `pipeline()` / `phase()` / `workflow()` calls. There is **no application** and **no runtime build** — the deliverables are the workflow scripts themselves, consumed by Claude Code. The repo is also packaged as a Claude Code **plugin**.

**One exception to "no application".** The repo also ships a small MCP stdio server at [`packages/vent-server/`](packages/vent-server/) — Node built-ins only, like everything else here — registered by the root [`.mcp.json`](.mcp.json) and launched by the host in every session where the plugin is installed. Four consequences worth knowing before you touch it:

- Installing the plugin now surfaces a **tool**, not just skills and workflows. Loaded via `--plugin-dir` it appears as `mcp__plugin_shipofclaudius_vent__vent` — plugin MCP servers are namespaced `plugin_<plugin>_<server>`, so the bare `mcp__vent__vent` is *not* the name you get.
- A session whose cwd is this repo loads `.mcp.json` **twice**: once plugin-scoped, where `${CLAUDE_PLUGIN_ROOT}` expands and the server works, and once *project*-scoped, where that variable is undefined and a bare `vent` server fails `CONNECTION_CLOSED`. That second entry is expected and harmless. Root placement is what the design spec mandates, so do **not** "fix" the noise by relocating the file — that breaks plugin-scope loading instead.
- **It writes.** A call appends one JSON line to `~/.claude/vents.jsonl` — outside this repo, by design (spec §5) — rate limited to 1 per 90 s and 10 per session. Set `VENT_SINK` in the *server's* environment to redirect that file; the suite uses it so tests never append to your real sink. The security invariants (never error into a session, refusals stay cheap, an agent cannot forge a record) are written up in [`packages/vent-server/THREAT_MODEL.md`](packages/vent-server/THREAT_MODEL.md) — read it before changing `callVent`, the sink, or the git lookups.
- **It serves two protocol eras, and only one of them is observed.** The legacy `2025-11-25` handshake is what Claude Code 2.1.241 actually speaks (verified 2026-08-28); the modern `2026-07-28` era — `server/discover`, per-request `_meta` version dispatch, `-32022` rejection, `resultType`/`structuredContent` — is written to the published spec and **has never met a client**, so its tests prove shape conformance and nothing more. Do not describe it as verified end-to-end, and do not delete either branch until the other is the only one left in the world (design spec §4.1).

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

After editing a workflow, run `npm test`; it must end `0 failing`, and the standing contract is that the count only ever goes **UP** — compare against a run on the base commit, not against a number written down somewhere. No total is pinned in README or here, deliberately: a suite cannot run the suites, so a hardcoded count is a claim no check can enforce, and the last one had drifted by 18 across four terms before anyone noticed. `tests/plugin-integrity.test.mjs` fails the build if a total is pinned back into README **or into this file**, in any wrapper (bolded, quoted, or bare).

**`packages/specificity` is not a workflow either, and is not wired to anything by default.** It is the M1 fast path of the prompt-specificity scorer (design: `docs/specs/2026-08-30-prompt-specificity.md`): a `UserPromptSubmit` command hook (`bin/fast.mjs`) plus a status-line renderer (`bin/render.sh` + `render.jq`), and the M4 validation log (`src/outcome-log.mjs` + the offline `bin/analyze.mjs`; how to run the experiment is `packages/specificity/VALIDATION.md`). Four things to know before touching it:

- **Nothing here is registered.** It is deliberately absent from `hooks/hooks.json`, because an entry there fires in every session of every project with the plugin enabled, and `statusLine` is a user setting a plugin cannot claim regardless. Registering it is M5's decision and needs explicit approval — it is a change to the session's own guardrails.
- **The one invariant is that no configuration may break a session** (spec §8). Every path exits 0. The single exception is `mode = "gate"`, which exits 2 — and on `UserPromptSubmit` exit 2 *erases the user's prompt*, so it ships off behind a high threshold. Never signal an ordinary failure with a non-zero exit here.
- **`session_id` becomes a filesystem path**, so it is validated in two places that must stay in step: `isSafeSessionId()` in `src/cache.mjs` and the `case` guard in `bin/render.sh`. Both reject rather than sanitize.
- **The M4 log writes outside the repo, and only when asked.** `outcome_log` defaults to `false`; switched on, the hook appends one line per turn to `<SPECIFICITY_DIR>/outcomes.jsonl` (`~/.claude/specificity/` by default). It carries **counts only** — no referent phrases, no paths, no prompt text — because a cache holds one turn and a log accumulates forever (spec §9.1). Every field is a number except `prompt_id`, which goes through the same id filter as `session_id`; that is what leaves nowhere for text to sit, so do not add a string field and do not give `bin/analyze.mjs` a way to write a file.

Like `factory-gate` it is model-free, so `tests/specificity-fast.test.mjs`, `tests/specificity-render.test.mjs` and `tests/specificity-outcome-log.test.mjs` are ordinary unit + end-to-end suites, not sims. The render suite shells out to the real `sh`/`jq`, and skips when `jq` is absent.

**`packages/factory-gate` is not a workflow and has no sim.** It is pure, model-free code, so `tests/factory-gate.test.mjs` is an ordinary unit suite. Because it is imported (not `AsyncFunction`-wrapped), `tests/` must stay a sibling of `packages/` as well as of `.claude/workflows/`. The two factory sims import the real gate to assert across the boundary — if you change `CONDITION_ORDER` or the `fixture_evidence` shape, those sims are what catch the caller drift.

## Conventions that the test suite enforces

These are not style preferences — `tests/plugin-integrity.test.mjs` fails the build if you break them:

- **1:1 workflow ↔ wrapper skill.** Every `.claude/workflows/<name>.js` must have exactly one `skills/<name>/SKILL.md` and vice versa (no orphans). When you add a workflow, add the matching skill dir.
  - **Exception — process skills.** A skill whose frontmatter declares `workflow: none` is a session-long playbook (no Workflow script) and is exempt from the 1:1 mapping; the integrity test still enforces its frontmatter, forbids `scriptPath` in its body, and requires every `references/<file>` it mentions to exist. The shipped set is whatever `grep -l '^workflow: none' skills/*/SKILL.md` returns — do not re-enumerate it here.
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

## This plugin is canonical (resolved in #87)

For any skill name this repo ships, **the plugin is the source of truth**. Hand-rolled copies under a user's `~/.claude/skills/` predate the plugin and are legacy — they are not a second supported entry point, and they must not be treated as a fallback or a place to patch behavior.

This matters because both load at once. A skill installed via the plugin is addressed `shipofclaudius:<name>`, while a same-named directory in `~/.claude/skills/` claims the bare `<name>` — so the *local* copy silently wins for anyone who types the short form. That ambiguity is the whole reason for this rule.

**Before retiring a local copy, diff its bundled assets against this repo.** The pre-plugin copies were not always older renderings of the same skill — some carried capability that never existed here. Retiring `security-diff-scan` turned up a CI/CD pipeline-abuse lens, a content-contract test, and a report template with no equivalent on `main` (see #89). Check `references/`, `tests/`, and `assets/` subdirectories, and search by **content**, not just filename — the lens was prose-embedded across three methodology phases and matched no filename.

Nothing in this repo can enforce this: `~/.claude/` is outside the tree, so `plugin-integrity.test.mjs` cannot see it. The rule is documentation, and the cleanup is a manual step for the maintainer.

## Layout

- `.claude/workflows/*.js` — the workflows (the actual product).
- `.claude/agents/*.md` — subagents the workflows dispatch by `agentType`. Registered via `plugin.json`'s `agents` key (this path is not auto-discovered for plugins).
- `skills/<name>/SKILL.md` — plugin wrapper skills, one per workflow.
- `tests/*-sim.test.mjs` — offline simulators (one per workflow) + `plugin-integrity.test.mjs`; `tests/lib/` holds vendored built-ins-only validators. Tests resolve their target via `new URL('../.claude/workflows/<name>.js', import.meta.url)`, so `tests/` must stay a sibling of `.claude/workflows/`.
- `packages/` — the non-workflow code: `factory-gate` (pure, model-free, unit-tested), `vent-server` (the MCP stdio server above), and `specificity` (the prompt-specificity scorer's hook + status line — see below).
- `.claude-plugin/{plugin,marketplace}.json` — plugin packaging manifests.
- `docs/specs/` — design/spec docs for major features (dated filenames).
