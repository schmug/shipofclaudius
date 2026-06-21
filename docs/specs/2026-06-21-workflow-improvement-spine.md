# Dynamic Workflow Improvement Spine — Design Spec

**Date:** 2026-06-21
**Repo:** `schmug/shipofcladius` (this repo is the canonical source of truth)
**Status:** Design approved in principle; this doc is the handoff source of truth for a fresh agent.

---

## 0. Why this exists / how to read it

Goal: improve the dynamic-workflow suite in this repo along quality axes (idempotency,
resilience, confidence, outputs, autonomy, scale, coverage) while reducing errors,
incomplete solutions, security vulnerabilities, failed deployments, stale documentation,
and unnecessary "continues" — following the Anthropic Workflow-tool best practices
(<https://code.claude.com/docs/en/workflows>).

This spec was distilled from a planning session that had **false starts** (see §6). Trust
THIS document and the actual repo files over any prior chatter. If something here conflicts
with the live `~/.claude/workflows/*.js` runtime copies, **the repo is authoritative** —
those copies are hand-synced snapshots and have drifted.

---

## 1. Source of truth & editing process (READ FIRST)

- **Canonical = this repo (`~/shipofcladius`).** The live copies in `~/.claude/workflows/*.js`
  are hand-synced snapshots (see README "Install"). They have **drifted in both directions** —
  do not treat them as truth.
- **Editing loop for every change:**
  1. Branch (never commit to `main`).
  2. Edit the workflow `.js` **and** add/extend its `tests/<wf>-sim.test.mjs`.
  3. `npm test` must stay green (baseline **93 passing**; the number only goes up).
  4. Open a **PR** (never push `main`), conventional-commit prefixes, `Co-Authored-By: Claude`.
  5. The repo's `.claude/workflows/` is the Anthropic-supported **project-level** location;
     Claude Code auto-loads it for anyone working in the repo (v2.1.178+; a project workflow
     shadows a personal one of the same name), so a merge needs **no sync**. *(Optional)* for
     machine-wide use in OTHER repos, copy or symlink the `.js` into `~/.claude/workflows/` —
     those personal copies are snapshots that can drift.
- **Single self-contained file per workflow** — scripts cannot `import`. Shared "spine"
  helpers are **inlined** and stamped with a `SPINE_VERSION` constant so copies stay in sync.
- **Preserve existing return-shape keys** (additive changes only) — the workflows chain
  (`issue-triage-fanout → issue-research-fanout → stacked-impl-lanes`), so changing a return
  shape breaks a downstream consumer.

### Drift to reconcile (part of this work)
- Runtime `defense-scan.js` is **newer** than the repo copy → sync runtime → repo.
- `stacked-merge-walk.js` exists **only** in the runtime, not in the repo → add it to the
  repo **with** a `tests/stacked-merge-sim.test.mjs`.
- A throwaway `triage-issues.js` exists only in the runtime. **Do NOT add it to the repo.**
  Retire it; fold its two good ideas (deterministic gather-slice, synthesis report) into
  `issue-triage-fanout.js` (§4 Phase 1).

---

## 2. Design decisions (already made — do not re-litigate)

1. **Sequencing:** spine-first (define the cross-cutting patterns once), then apply
   per-workflow.
2. **Autonomy = confidence-gated, reversible-only floor.** A per-item confidence score gates
   autonomy, but it governs **reversible** actions only. **Irreversible** actions always stage
   for one-pass human approval, regardless of confidence. This honors the user's global
   CLAUDE.md hard gates: *never auto-merge an incomplete branch, never push to `main`,
   approval before batched destructive actions.*
3. **Confidence floor:** `confidence ≥ T` may auto-execute a **reversible** action; an
   **irreversible** action is **never** auto-executed by a workflow no matter the confidence.
4. **Idempotency = hybrid:**
   - **Writes → state-derived.** Before any write, verify GitHub truth (PR already open for
     this lane? issue already closed? PR already merged?) and skip if the end-state holds.
     Never duplicate a write.
   - **Reads → checkpoint.** Persist read-only analysis to
     `~/.claude/workflows/state/<repo>-<wf>.json`, entries keyed by
     `{number, updatedAt, SPINE_VERSION}`. Re-run: load → skip unchanged-done → run
     pending/changed → write back. `updatedAt` drift invalidates an entry. `args.fresh:true`
     bypasses the checkpoint.

---

## 3. What ALREADY EXISTS — do NOT rebuild

The repo is mature. These are done; build on them, don't reinvent:

- **Prompt-injection hardening** (issue #3): untrusted issue/PR text is fetched by a dedicated
  read-only **relay** agent, returned with a fresh **nonce**, wrapped in a **nonce-marked
  fence**, and reasoned over behind an **anti-injection preamble**; every subagent runs through
  a read-only **`agentType`** (default `Explore`; override `args.readonlyAgent`). Setup
  expectation: a **read-scoped `gh` token**. See README "Security model". Preserve all of this
  in any edit.
- **Sim-test harness:** `tests/*-sim.test.mjs` wrap each workflow in an `AsyncFunction` with
  stubbed runtime globals and assert orchestration logic at zero token cost. **93 passing.**
  Every spine change ships with new assertions here.
- **Schema-forced output, self-bootstrapping no-args gather, `args` JSON parse-guard,
  partial-tolerance (`filter(Boolean)`).**

---

## 4. The spine — gaps to close (the actual work)

Each item is a shared pattern. Inline the helper(s), stamp `SPINE_VERSION`, and assert in the
sim test.

| Axis | Gap | Concrete mechanism |
|---|---|---|
| **Resilience** | Single unbatched `parallel()` over all items hits the StructuredOutput concurrency cliff (~14 concurrent; agents past it fail). In `issue-triage-fanout` each item is a **relay→classify chain (2 agents)**, so exposure is doubled. | `runWaves(items, fn, batchSize=8)` — sequential waves of ≤8; await each wave before the next; per-wave `log`. |
| **Resilience** | Failed agents vanish silently from the result. | Compute `missing[]` = requested − assessed; `log` it and return it for a one-arg recovery re-run (`args.numbers=<missing>`). |
| **Idempotency** | No checkpoint / no skip-done. | Hybrid per §2.4. The **script cannot do file IO** — a gather agent reads the state file, and a single **writer agent runs between waves** (sequential → no race) to persist. |
| **Confidence** | Single-pass classification; no confidence signal for the autonomy gate. | Adversarial-verify: `N=3` skeptics (default) each prompted to **refute**, default-refuted on uncertainty; `confidence = fraction not-refuted`. **Invoke only on action-candidates** (items that would trigger a reversible auto-write) and on security findings — NOT on every read-only classification (keeps cost bounded). |
| **Autonomy** | No structured execution contract. | Tag each proposed action `REVERSIBLE {draft PR, comment, label, report}` vs `IRREVERSIBLE {merge, push-main, deploy, bulk close/delete, force-push}`. Return `auto_execute[]` (reversible AND `confidence ≥ T`, default `T=2/3`) and `gated[]` (everything else, ranked). The workflow itself **never** performs an irreversible action. |
| **Outputs** | Returns raw `{triaged, counts}`; the human report is left to the orchestrator. | Additive synthesis phase → `roadmap` with grouped, dependency-ordered buckets + a `markdown` report. **Additive only** — keep the existing keys. |
| **Coverage** | Only a count is logged. | No-silent-caps: log every drop/skip/cap with reason + count (non-author, non-open, limit-hit, batch-missing, checkpoint-skipped) + a final `gathered N / processed M / skipped K / missing J` line. |
| **Stale docs ↓** | Builder lanes don't enforce doc updates. | `stacked-impl-lanes`: a lane that changes behavior must update touched docs in the **same** PR; add a completeness-critic that flags doc drift. |

`T` (default `2/3`) and `N` (default `3`) are **tunable per workflow via args**; expose them.

---

## 5. Per-workflow application (priority order)

Each phase = its own branch + PR + sim-test additions.

- **Phase 1 — `issue-triage-fanout`** (start here; security is already done):
  add `runWaves` batching (remember: relay+classify = 2 agents/item), `missing[]`, and the
  additive synthesis report (preserve `{triaged, counts, total}`). Fold in the retired
  `triage-issues.js` ideas. Extend `tests/issue-triage-sim.test.mjs` to assert: batching wave
  shape, `missing[]` computation, synthesis present, injection-hardening call shapes unchanged.
- **Phase 2 — `pr-triage-fanout`:** batching, `missing[]`, **discover-once** required-check
  list (today each agent re-discovers it), state-derived skip for already-merged PRs, synthesis.
- **Phase 3 — `issue-research-fanout`:** batching, checkpoint, and a **web-stall timeout** (its
  agents use WebSearch/WebFetch — a hung call must fail one item, not the run).
- **Phase 4 — `stacked-impl-lanes`:** state-derived write idempotency (skip a lane whose PR
  already exists), confidence-gated **reversible** writes (open **draft** PR), doc-freshness in
  each lane. Keep the `security-hardening-reviewer` gate on invariant lanes.
- **Phase 5 — `stacked-merge-walk`:** **first add it to the repo** + a sim test (it is
  runtime-only today). This is the only workflow touching **irreversible** actions (merges), so
  the §2 gate policy is its core: it stages, ranks, and gates — never auto-merges.
- **Phase 6 (optional) — `deep-security-scan` / `defense-scan`:** already the most advanced
  (disprove-first validation = adversarial-verify; `foxguard` prefilter; HTML report). Only add
  a checkpoint so long scans resume cheaply. Reconcile the defense-scan runtime→repo drift here.

---

## 6. False starts to ignore (context hygiene)

The planning session that produced this spec made these mistakes; a fresh agent should NOT
repeat them:

- Built a **new `triage-issues.js`** from scratch instead of improving `issue-triage-fanout.js`
  — it is a near-duplicate. Retire it; do not add it to the repo.
- Analyzed the **stale runtime copies** in `~/.claude/workflows/` rather than the repo. Always
  read the repo files (this dir) as truth.
- Assumed tests and security hardening were missing — they **exist** (§3).

---

## 7. Out of scope

- Workflow **runtime** hardening (what `agent()` actually grants a subagent, sandbox egress) —
  upstream, not controllable here.
- Re-doing the security model — done (§3).
- Publishing the repo — it is **proprietary / private** (see LICENSE).

---

## 8. Definition of done (per phase)

- Workflow edited; existing return keys preserved; spine helpers inlined + `SPINE_VERSION`
  stamped.
- `tests/<wf>-sim.test.mjs` extended; `npm test` green (≥ prior count).
- Injection-hardening call shapes unchanged (assert in test).
- PR opened (not `main`), conventional commit, `Co-Authored-By: Claude`.
- In-repo use needs **no sync** — the merged `.js` auto-loads from the project-level
  `.claude/workflows/`. *(Optional)* machine-wide install: copy or symlink it into
  `~/.claude/workflows/` for use in OTHER repos.
