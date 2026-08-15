# Software Factory — design spec

**Date:** 2026-08-05
**Status:** partially landed (see §10 File manifest)
**Reference:** [Cloudflare / Astro — automated issue triage](https://blog.cloudflare.com/astro-issue-triage/)
**First adopter:** `schmug/dmarcheck` (dmarc.mx)

---

## 1. Source of truth & editing process (READ FIRST)

Same rules as `2026-06-21-workflow-improvement-spine.md`:

- Branch, edit the workflow **and** its sim test together, `npm test` green (the assertion count only goes up), open a PR. **Never push `main`.**
- Conventional commits.
- New workflow ⇒ new `skills/<name>/SKILL.md` **and** a new line in `package.json`'s `test` chain, or `plugin-integrity` fails and CI never runs the suite.
- Tests use **Node built-ins only**. No npm dependency, ever. No lockfile.

## 2. What we are building, in one paragraph

An autonomous loop that takes a GitHub issue, **reproduces** it as a committed fixture test, **diagnoses** the root cause, independently **verifies** it is a real bug rather than intended behaviour, **fixes** it behind a failing-test-first discipline, and opens a draft PR with a preview URL — then merges only when a deterministic, model-free gate says every safety condition holds. Phases run as isolated subagents that hand off through a single `report.md`. State lives in issue labels, so the loop is restartable, inspectable, and interruptible at every transition.

## 3. Decisions locked

| Decision | Choice | Consequence |
|---|---|---|
| **Execution substrate** | **GitHub Actions, headless.** A workflow in the target repo runs `claude -p` and invokes these plugin skills. | The schedule becomes versioned, diffable, and revertable. Replaces the claude.ai Routines registration, which exists in no repo and cannot be reviewed or rolled back. |
| **Trust token** | **Downstream `fix-verified`, human-minted.** `spec-approved` is retired. | The human approves a demonstrated result (draft PR + working preview) instead of an intention. Strictly more autonomous *and* strictly safer than the current upstream gate. |
| **Mechanical verification** | **Built but off.** `requireFixtureEvidence` defaults `false`. | The condition exists and is tested; it is enabled per-repo only once that repo's fixture harness has a track record. |

**Non-goals.** Not replacing `issue-triage-fanout` / `issue-research-fanout` (they remain the front door that decides *which* issues enter the factory). Not replacing `merge-pr-with-gate` for ordinary PRs. Not touching the security-scan half of this repo.

**Merge-authority policy note (2026-08-15).** Single-PR merges behind a deterministic gate are now agent-decided when the gate passes (the **gated-autonomous** class in `2026-06-21-workflow-improvement-spine.md` §2.3); human approval remains only for batched destructive landings, releases/deploys, and guardrail edits. The factory's `fix-verified` trust token (§5) is a separate, stricter per-issue gate and is deliberately unchanged by that policy — whether the *factory* may set `execute:true` unattended is the autonomy design in [#65](https://github.com/schmug/shipofclaudius/issues/65), and replacing the human token with fixture evidence (gate condition 9) is [#64](https://github.com/schmug/shipofclaudius/issues/64).

## 4. Architecture

```
L4  SCHEDULER   target repo: .github/workflows/factory.yml
                cron + issues.labeled + workflow_dispatch          ← versioned, revertable
                        │
L3  DRIVER      claude -p → Skill(factory-issue-fix) → Workflow tool
                        │
L2  PHASES      reproduce → diagnose → verify → fix                ← isolated subagents,
                handoff artifact: report.md on the scratch branch     fresh context each
                        │
L1  GATE        packages/factory-gate  (pure code, NO model)       ← runs from main, in CI
                9 fail-closed conditions → merge | escalate
```

**Why the gate is code and the phases are agents.** The phases need judgement, so they get models. The merge decision must not be a judgement call — issue bodies are public, attacker-writable text, and an injected instruction cannot move a `<=` comparison. Everything that decides *whether code lands* is deterministic; everything that decides *what the code should be* is a model whose output is then gated.

## 5. Label state machine

State is the label set. The driver is stateless: each Action run reads labels, advances at most one transition, writes labels back. A human interrupts by applying `needs-you` or `pipeline-paused` at any point.

```
 [issue enters the factory: `factory` label applied by issue-triage-fanout or a human]
        │
        ▼
   needs-repro ──────► repro-failed ─────► needs-you
        │  (fixture committed, red on main)
        ▼
    repro-ok
        │
        ▼
   diagnosed ────────► not-a-bug ────────► closed with rationale
        │
        ▼
  fix-proposed   ← draft PR + preview URL posted as an issue comment
        │
        ├─ human applies `fix-verified` ──► FACTORY GATE ──► squash-merge
        │                                        └────────► needs-you (escalate)
        └─ reporter says still broken ──► back to `diagnosed`
```

**Label inventory** (created idempotently by `.factory/setup-labels.sh`):

| Label | Applied by | Meaning |
|---|---|---|
| `factory` | triage / human | opted into the pipeline |
| `needs-repro` `repro-ok` `repro-failed` | driver | reproduce phase outcome |
| `diagnosed` `not-a-bug` | driver | diagnose + verify outcome |
| `fix-proposed` | driver | draft PR is open |
| **`fix-verified`** | **human** (later: fixture) | **the trust token — the only thing that unlocks the gate** |
| `needs-you` | driver / human | escalated, factory will not touch it |
| `pipeline-paused` | human | **kill switch** — checked first, every run, no-op if present |

**Retired:** `spec-approved`, and the `auto-impl` implementer Routine that consumed it.

## 6. The `report.md` handoff contract

One file per issue, on the scratch branch `factory/issue-<N>`, appended to by each phase and posted as an issue comment at every transition. It is both the inter-phase memory and the human's read-in.

```markdown
# Factory report — issue #<N>
<!-- factory:version=1 factory:issue=<N> -->

## Reproduce            <!-- phase 1 -->
- **Verdict:** REPRODUCED | NOT_REPRODUCED | NEEDS_INFO
- **Fixture:** `test/fixtures/<slug>.json`
- **Test:** `test/fixtures.test.ts::<name>`
- **Red on base:** <exact failing output, verbatim>
- **Command:** `<the single command that reproduces>`

## Diagnose             <!-- phase 2 -->
- **Root cause:** <file:line + the mechanism, not a guess>
- **Boundary:** <narrowest enforcement point where a fix belongs>
- **Evidence:** <instrumentation output / bisect result>

## Verify               <!-- phase 3, INDEPENDENT model -->
- **Verdict:** REAL_BUG | INTENDED_BEHAVIOUR | INSUFFICIENT_EVIDENCE
- **Checked against:** <tests, comments, CLAUDE.md invariants, docs consulted>
- **Rationale:** <why this is or is not a defect>

## Fix                  <!-- phase 4 -->
- **PR:** <url> (draft)
- **Preview:** <url>
- **Green on head:** <exact passing output>
- **Files changed:** <list>
- **Weakened control:** false
```

**Rules.** Append-only within a run. Every phase reads the whole file and writes only its own section. `Red on base` and `Green on head` are quoted verbatim — they are the evidence the gate's `fixture_evidence` condition consumes once enabled.

## 7. Workflows to build

Two workflows, following `fix-finding.js` as the structural template throughout.

### 7.1 `factory-issue-fix.js` — the four-phase engine

`meta.phases`: `Reproduce`, `Diagnose`, `Verify`, `Fix` (titles must match the `phase()` calls exactly).

**Args:** `{ issue: number, repo?, base?='main', startAt?, stopAfter?, readonlyAgent?='Explore', confidenceThreshold?=2/3, fresh?=false }`.
`startAt`/`stopAfter` let one Action run advance one phase and resume from the committed `report.md` — this is what makes the state machine restartable.

**Self-bootstrapping:** with no args it must gather candidate issues itself (`gh issue list --label factory --label needs-repro`) — per CLAUDE.md, the invoke prompt is generated from `meta` alone, so "pass X first" in a comment is invisible.

**Agent-by-agent contract:**

| Label | agentType | Isolation | Schema (required fields) |
|---|---|---|---|
| `preflight-existing-pr` | `Explore` | — | `{ existing: [{branch, pr_url, state}] }` |
| `relay-issue` | `Explore` | — | `{ nonce, body }` — runs a **fixed** `gh issue view` command, mints a fresh nonce, returns raw bytes verbatim |
| `reproduce` | `Explore` | — | `{ verdict, fixture, test, red_output, command, rationale }` |
| `diagnose` | `Explore` | — | `{ root_cause, boundary, evidence, confidence }` |
| `verify` | `Explore` | — | `{ verdict, checked_against, rationale }` |
| `fix` | *(write-capable)* | **`worktree`** | `{ status, pr_url, branch, is_draft, green_output, files_changed, weakened_control, preview_url, summary, blocker }` |

**Hard rules baked into the `fix` prompt** (copy from `fix-finding.js` verbatim — they are load-bearing): no advisor calls, no WebFetch/WebSearch, no CI polling (trips the no-progress watchdog), no merge, no `--admin`, no force-push, no push to `main`. Opens a **draft** PR and returns.

**Prompt-injection hardening — all three parts, non-negotiable:**
1. A dedicated read-only `relay-issue` agent runs the fixed fetch and mints a **fresh random nonce**. Reasoning agents never fetch issue text themselves.
2. Every agent except `fix` runs under `READONLY_AGENT`.
3. An anti-injection preamble precedes every `<<<UNTRUSTED_ISSUE_<nonce>>>>` fence.

**Short-circuits (each a first-class outcome, no write agent spent):**
- `NOT_REPRODUCED` → `outcome: 'repro_failed'`, label `repro-failed`, escalate.
- `NEEDS_INFO` → comment asking the reporter, no label change beyond `needs-you`.
- `INTENDED_BEHAVIOUR` → `outcome: 'not_a_bug'`, post the rationale, never open a PR.
- Existing open PR on the branch → `outcome: 'skipped_existing'` (bypass with `fresh:true`).

**Verify must use a different model family from Diagnose.** Set it via `args.verifyModel` → `agent(..., { model })`. A same-model verifier agrees with itself; independence is the entire value of the phase.

**Returns:** `{ outcome, phase_reached, report, fixture, test, pr_url, preview_url, evidence: { fixtureTest, redOnBase, greenOnHead }, confidence, autonomy, spineVersion }`. The `evidence` block is shaped **exactly** as the gate's `fixture_evidence` input — that typed handoff is the point.

### 7.2 `factory-land.js` — gated landing

`meta.phases`: `Gather`, `Gate`, `Land`.

Gathers PR + linked issue + CI state via read-only relays, builds the gate input, calls `evaluate()` **in script code** (not via an agent — the gate must not be model-mediated), posts `renderVerdict()` as the audit comment, and squash-merges only on `pass`.

- **Stage by default.** `execute: true` required to merge. Same ladder as `merge-pr-with-gate`.
- **Never** `--admin`, never `--delete-branch` on a predecessor in a stack, never force-push.
- On `escalate`: apply `needs-you`, post the verdict table, stop.
- Re-derive eligibility **in code** from the gate result — never trust an agent's boolean. (Direct port of the deterministic backstop in dmarcheck's `.claude/workflows/pr-triage.js`.)

### 7.3 Wrapper skills

`skills/factory-issue-fix/SKILL.md` and `skills/factory-land/SKILL.md`. Frontmatter `name:` matching the directory, non-empty `description`, body containing:

```
Workflow({ scriptPath: "${CLAUDE_PLUGIN_ROOT}/.claude/workflows/<name>.js", args: { ... } })
```

`factory-issue-fix` is read-mostly but its fix phase **WRITES** — say so, and note it needs a write-scoped `gh` token. `factory-land` **WRITES (merges)** — stage-by-default, `execute:true` to merge.

## 8. The gate — `packages/factory-gate/` ✅ **LANDED**

Pure, model-free, dependency-free. 48 unit tests, all passing.

| # | Condition | Fails when |
|---|---|---|
| 1 | `author_allowlisted` | issue author absent or not in `allowlistAuthors` |
| 2 | `required_labels` | `fix-verified` missing (case-insensitive) |
| 3 | `no_blocking_labels` | `needs-you` / `pipeline-paused` / … present on PR **or** issue |
| 4 | `single_closes` | zero **or** ambiguous `Closes #N`, after stripping fences, inline code, HTML comments, blockquotes |
| 5 | `no_risk_paths` | any changed file matches the denylist; **`.factory/**` and `.github/workflows/**` are mandatory and cannot be removed by config** |
| 6 | `within_size_limits` | > `maxChangedFiles` or > `maxChangedLines`, or size data unavailable |
| 7 | `no_scope_drift` | a changed file is outside the issue's ` ```scope ` block — **no scope block means every file is drift** |
| 8 | `ci_green` | any required context missing/running/failing, or `mergeStateStatus` not CLEAN/HAS_HOOKS — **UNKNOWN is never a pass** |
| 9 | `fixture_evidence` | (opt-in) fixture not proven red-on-base **and** green-on-head |

**Invariants:** every condition fails closed; all nine are evaluated every run so the comment is one-pass feedback and the failure histogram is a metric; the verdict stamps `configSource` for provenance.

**The gate-from-main invariant is the caller's responsibility.** `bin/gate.mjs` reads what it is pointed at; the Action must extract both the package and `.factory/gate.json` from the base branch. Condition 5 is the defence in depth that makes a mis-wired caller escalate rather than merge.

**Exit codes:** `0` merge · `2` escalate · `1` the gate itself broke. Three distinct codes on purpose — "the gate broke" must never read as either answer.

## 9. GitHub Actions integration (target repo)

`.github/workflows/factory.yml`, three jobs:

```yaml
on:
  issues:              { types: [labeled] }
  pull_request_target: { types: [labeled] }     # for fix-verified
  schedule:            [{ cron: "0 */4 * * *" }]
  workflow_dispatch:

concurrency:
  group: factory-${{ github.event.issue.number || github.event.pull_request.number || 'cron' }}
  cancel-in-progress: false                      # never cancel a run mid-write

permissions: { contents: read }                  # jobs elevate explicitly
```

1. **`killswitch`** — resolve `pipeline-paused` on any open issue; every other job `needs:` it. Cheap, no model, runs first.
2. **`advance`** — `claude -p` invoking `factory-issue-fix` for one issue. Timeout 30 min. Write-scoped token, **distinct identity from the code owner** (GitHub forbids self-approval; see #299).
3. **`land`** — on `fix-verified`. Checks out the **base** ref, extracts gate sources and `.factory/gate.json` **from `main`**, builds `gate-input.json` via `gh`, runs `bin/gate.mjs`, comments the verdict, merges on exit 0.

Every third-party action pinned by full 40-char SHA. Add `timeout-minutes` to every job — dmarcheck currently has none in any of its seven workflows.

**Cross-cutting:** run `routine-anti-noise` as the mandatory first gate in `advance` to avoid re-commenting and to honour human-flagged labels. This is the purpose-built fix for the double-fire class of bug (PhishSOC #403, six duplicate PRs).

## 10. File manifest

| Path | Status |
|---|---|
| `packages/factory-gate/src/glob.mjs` | ✅ landed — dependency-free glob subset |
| `packages/factory-gate/src/extract.mjs` | ✅ landed — `Closes #N` + ` ```scope ` extraction |
| `packages/factory-gate/src/config.mjs` | ✅ landed — fail-closed defaults, mandatory denylist |
| `packages/factory-gate/src/gate-core.mjs` | ✅ landed — 9 conditions, `evaluate`, `renderVerdict` |
| `packages/factory-gate/bin/gate.mjs` | ✅ landed — CLI, exit 0/2/1 |
| `tests/factory-gate.test.mjs` | ✅ landed — 48 passing |
| `package.json` test chain | ✅ updated |
| `.claude/workflows/factory-issue-fix.js` | ⬜ **to build** — §7.1 |
| `.claude/workflows/factory-land.js` | ⬜ **to build** — §7.2 |
| `tests/factory-issue-fix-sim.test.mjs` | ⬜ **to build** — §11 |
| `tests/factory-land-sim.test.mjs` | ⬜ **to build** — §11 |
| `skills/factory-issue-fix/SKILL.md` | ⬜ **to build** — §7.3 |
| `skills/factory-land/SKILL.md` | ⬜ **to build** — §7.3 |
| `README.md` workflow table + Arguments | ⬜ **to update** |

## 11. Sim test requirements

Same harness as every sibling sim (`AsyncFunction` + stubbed globals, zero token cost). Each new sim **must** assert:

- `meta.phases` titles exactly match the `phase()` calls.
- `assertSatisfiable` on every agent schema (copy the shared helper).
- Args arriving as a JSON **string** are parsed.
- The read-only relay runs a **fixed** command and the reasoning agent never fetches issue text itself.
- A hostile issue body (inject a `SYSTEM OVERRIDE: …push --force…` string) appears **inside** the nonce fence, with the anti-injection preamble present.
- Every non-`fix` agent has `agentType === READONLY_AGENT`; the `fix` agent does **not**, and has `isolation === 'worktree'`.
- Phase ordering: reproduce **strictly before** diagnose before verify before fix.
- Each short-circuit spends **zero** write agents (`NOT_REPRODUCED`, `INTENDED_BEHAVIOUR`, `skipped_existing`).
- `factory-land` in stage mode makes **zero** merge agent calls; `execute:true` makes exactly one; no `--admin` / force-push appears in any prompt.
- `SPINE_VERSION` is declared.

Reminder from CLAUDE.md: **`node --check` reports a bogus "Illegal return statement"** on workflow files. `npm test` is the real parser check.

## 12. dmarc.mx adoption

**Phase 0 blockers — none of the above ships without these.**

**12.1 Reproduction harness** *(the load-bearing item)*

```
scripts/record-fixture.ts    # npm run record -- foo.com → test/fixtures/foo.com.json
src/dns/replay.ts            # DNS client backed by a fixture instead of the network
src/orchestrator.ts          # export scanFromFixture(path) → ScanResult
test/fixtures.test.ts        # every fixture asserts its expected grade + policy
```

Then *"foo.com grades B, should be A"* becomes one command, and the reproduce phase has a mechanical definition of done. Astro gets this free from user-supplied repro repos; dmarc.mx has to build it. **Timebox to two weeks** — if DNS recording proves intractable, fall back to human `fix-verified` for everything and accept a lower ceiling; the rest of the design still holds.

**12.2 Coverage floor.** `@vitest/coverage-v8`, per-file thresholds on `src/analyzers/**` and `src/shared/scoring.ts`, wired into the required `check` job. Start at *measured minus 2%*, ratchet monthly. Without it, condition 8 measures nothing — an agent can delete a branch of logic and CI stays green.

**12.3 Rollback lever.** `wrangler versions upload` + `versions deploy`, so a `prod-smoke` failure can shift traffic back. Minimum viable: a `workflow_dispatch` revert workflow with a CODEOWNERS exemption so a revert never needs approval to land. **A factory without a revert path is not a factory** — and today production deploys leave GitHub entirely via the Cloudflare Git integration.

**12.4 Bot identity (#299).** Resolve it; register the identity in `dco.yml`'s bot allowlist beside `cursoragent@cursor.com`. **Reconcile the four docs that disagree** about whether the CODEOWNERS gate is enforcing (`CLAUDE.md` says live; `MAINTAINERS.md`, `docs/OSPS-DEVIATIONS.md`, and `.claude/workflows/pr-triage.js` all say advisory). Verify empirically against the live ruleset API first.

**12.5 Two footguns.** `.gitignore` contains `.claude/` while 11 files under it are tracked — any *new* agent-authored skill silently fails to `git add`. And the `PreToolUse` commit hook has `"timeout": 30` for ~1,446 tests plus `tsc`; verify whether it fires or fails open.

**12.6 Widen the lane.** `src/index.ts` is 1,740 lines / ~50 routes and is CODEOWNERS-gated, making it the universal bottleneck. Split routes into `src/routes/*` (ungated), keeping validation and security primitives in a gated module. Bigger throughput win than any prompt engineering.

**12.7 `.factory/gate.json`** — the starting config:

```jsonc
{
  "allowlistAuthors": ["schmug"],
  "requiredLabels": ["fix-verified"],
  "riskPathDenylist": [
    "src/auth/**", "src/db/**", "src/analyzers/**", "src/orchestrator.ts",
    "src/shared/scoring.ts", "src/account/**", "src/rate-limit.ts",
    "wrangler.toml", "package.json", "package-lock.json",
    "mta-sts-worker/**", "scripts/routine-gate/**"
  ],
  "maxChangedLines": 250,
  "maxChangedFiles": 8,
  "requireScopeBlock": true,
  "requireGreenCI": true,
  "requireFixtureEvidence": false,
  "gateFromRef": "main"
}
```

Mirrors CODEOWNERS deliberately: anything a code owner must approve is also something the gate refuses to auto-merge. `.factory/**` and `.github/workflows/**` are added automatically.

**12.8 Issue template.** The gate's two most common escalation causes — no ` ```scope ` block, no resolvable `Closes #N` — have no form eliciting them. dmarc.mx has **no `.github/ISSUE_TEMPLATE/` at all**. Add a bug form with a required scope field.

**12.9 Migration additivity.** `migrate.yml` races the Cloudflare deploy and every migration must be additive, enforced by nobody. Add a SQL lint for `DROP` / `RENAME` / type-change to the required check **before** an agent is allowed near `src/db/`.

## 13. Metrics

- **Fixture rate** — % of issues where reproduce commits a red-on-base fixture. *The throughput number; everything else is downstream.*
- **Machine-verified rate** — `fix-verified` applied mechanically vs by a human. The autonomy dial.
- **Escalation rate, broken out by failed condition id.** Rising `no_risk_paths` ⇒ widen the lane (§12.6). Rising `no_scope_drift` ⇒ fix the issue template (§12.8).
- **Failure-signal yield** — codebase-quality issues filed per 10 agent failures, and how many get merged.
- **Time-to-first-fixture** — issue opened → fixture committed.
- **Revert rate** — auto-merged PRs later reverted. If not ~0, the gate is too loose.

## 14. Failure-as-signal loop

Astro's most transferable cultural rule: **an agent failure is a defect report about the codebase.** Every `repro-failed` / `not-a-bug` / gate escalation gets classified into *opaque abstraction* · *missing documentation* · *insufficient testing*, and files a follow-up issue against the repo.

The memory substrate already exists and already works — `.jules/sentinel.md` in PhishSOC traces one bug class (dynamic env-var lookup from a user-controlled name) across four PRs and three call sites over four months. Formalize it as `.factory/learnings/<persona>.md`, append-only, `Failure / Learning / Prevention` per entry, fed back into the phase prompts.

## 15. Risks

| Risk | Mitigation |
|---|---|
| **PhishSOC's `issues.opened` routine auto-merges from public issues today** | Disable before *any* factory work. Two documented incidents: PR #565 leaked 9 unpatched Highs from private GHSA drafts; issue #403 double-fired into six duplicate PRs. Not a factory risk — a live one. |
| Fixture harness proves intractable | Timebox §12.1 to two weeks; fall back to human `fix-verified` throughout. |
| CODEOWNERS overlap caps throughput | Measure escalation rate by condition before/after §12.6. |
| `shipofclaudius` is licensed proprietary, all rights reserved | Fine while everything is yours; blocks a collaborator or a public `factory-action` release. Decide the licence posture **now**, not after. |
| The factory optimizes for what it can measure | It fixes what has fixtures and ignores what doesn't. Treat a growing permanently-escalated pile as a defect in the factory, not a property of the issues. |
