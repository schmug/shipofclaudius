# Evaluating Cloudflare's vulnerability harness for shipofcladius

A concept review of Cloudflare's [*Build your own vulnerability
harness*](https://blog.cloudflare.com/build-your-own-vulnerability-harness/) and the
companion [`cloudflare/security-audit-skill`](https://github.com/cloudflare/security-audit-skill),
measured against the security workflows already in this repo
(`deep-security-scan`, `security-diff-scan`, `defense-scan`, `pr-review-fanout`).

The goal is not "should we copy it" — most of the architecture is already here,
convergently. The goal is to name the **handful of concepts shipofcladius does
not yet have** and decide which are worth adopting.

> Sourcing note: the blog post (`blog.cloudflare.com`) and its mirror are
> Cloudflare-firewalled to automated fetches (HTTP 403), so the harness-loop
> details below are drawn from the public release summary and the open-source
> skill the harness was built from. The skill files (`SKILL.md`,
> `RECONNAISSANCE.md`, `HUNTING.md`, `ATTACK-CLASSES.md`,
> `VALIDATION-AND-REPORTING.md`, `report-schema.json`, `validate-findings.cjs`)
> were read directly.

## TL;DR

- **shipofcladius already implements the core of the Cloudflare design** — parallel
  multi-agent fan-out, adversarial disprove-first validation, schema-constrained
  structured output, severity-thresholded reporting, single synthesized report —
  and is **ahead** on three axes the skill does not address at all: a deterministic
  prefilter (`foxguard`), indirect-prompt-injection hardening (the whole *Security
  model* section of the README), and a diff/PR-scoped sibling.
- The genuinely **new** ideas worth adopting, highest value first:
  1. **A separate independent *factual* verification gate (skill Phase 6)** —
     distinct from the exploitability validator. *Recommended.*
  2. **Stateful / incremental runs** — read a prior `findings.json` to skip known
     findings, target unexplored code, and report a coverage delta. *Recommended.*
  3. **Sharper validator prompt** — adopt the five named disprove tests + the
     "dynamic baseline" principle + the anti-pattern list. *Recommended (cheap).*
  4. **Business-logic / feature-abuse / chained + "wildcard" hunt lenses** —
     first-class in the skill, only implicit here. *Recommended (cheap).*
  5. **A shared recon artifact** feeding all hunt agents. *Optional.*

## Side-by-side

| Concept (Cloudflare) | shipofcladius today | Gap? |
|---|---|---|
| Phase 1 **Recon** → shared `architecture.md` | Each discovery worker builds its **own** per-lens threat model (`deep-security-scan.js:181`); no shared artifact | Partial — no shared recon |
| Phase 2 **Hunt**, parallel agents across attack classes | K independent threat-model **lenses** in `parallel()` (`deep-security-scan.js` `WORKERS`) | **Covered** |
| Phase 3 **Validate** — adversarial "disprove this" | Disprove-first validator, `confirmed`/`refuted`/`needs-info`, >80% confidence bar (`deep-security-scan.js:237,249`) | **Covered**, and stronger (trichotomy + confidence floor vs. binary confirmed/rejected) |
| — its five named tests (exploitation / impact / baseline / mitigation / parser-runtime) | Implicit in the validator prose | Partial — not named/enumerated |
| Phase 4 **Report** (`REPORT.md` + detail) | One HTML + markdown report, severity-sorted, coverage statement (`deep-security-scan.js:290+`) | **Covered** |
| Phase 5 **Structured output**, schema-validated | `agent({ schema })` enforces JSON shape at every stage; `additionalProperties:false` | **Covered** (enforced inline, no separate `validate-findings.cjs` step) |
| Phase 6 **Independent verification** (fresh agent re-checks file/line/root-cause/payload/prereqs/fix against source) | **Absent** in repo-wide scans. `pr-review-fanout` has a *skeptical-refute* verify (`pr-review-fanout.js:292`) but that re-litigates exploitability, not factual grounding | **Gap — strongest candidate** |
| **Automated triage loop / state across runs** (read prior `findings.json`, skip knowns, note coverage limits) | Every run is stateless / fresh | **Gap** |
| Routing around **LLM context limits** | Fan-out + chunked validators (chunks of 8, `deep-security-scan.js:226`) + budget-scaled rounds | **Covered** in spirit |
| "Dynamic baseline" — compare to comparable systems; ask why prod code wasn't already exploited | Not explicit | Partial |
| Anti-patterns (don't pad LOWs, don't rate defense-in-depth HIGH, don't report checklist deviations) | Not codified in prompts | Partial |
| Deterministic prefilter (SAST/secrets/SCA) feeding the merge | **Phase 0 `foxguard`** (`deep-security-scan.js:142`) | **Ahead of skill** |
| Indirect-prompt-injection hardening | Nonce-fence + read-only `agentType` + read-scoped token (README *Security model*) | **Ahead of skill** |
| Diff/PR-scoped audit | `security-diff-scan` with change-scope gate + coverage | **Ahead of skill** |
| Layered DAST/SCA/red-team/posture | `defense-scan` orchestrator | **Ahead of skill** |

## The adoption candidates, in detail

### 1. Independent factual-verification gate (skill Phase 6) — *recommended*

This is the most valuable concept the repo lacks. The skill draws a sharp line
between two *different* skeptical passes:

- **Validation (Phase 3)** asks *"is this exploitable?"* — the bias is killing
  false positives on **impact and reachability**. shipofcladius has this.
- **Verification (Phase 6)** asks *"is this finding factually true about the
  code?"* — a **fresh** agent confirms the cited file exists, the line numbers
  match the described code, the root cause is really present, the execution
  payload hits a real endpoint/method, no precondition was skipped, and the fix
  actually closes the hole without breaking legitimate behavior. Outcomes are
  `VERIFIED` / `CORRECTED` (fields patched, re-validated) / `REJECTED`.

Why it matters here: the disprove-first validator can confirm a *plausible*
exploit while still citing a wrong line, a slightly-misquoted sink, or a fix that
doesn't compile — the failure mode validation is *not* looking for. A second,
cheap, grounding-only gate catches the "confidently wrong citation" class.

**How to adopt:** add a `Verify` phase to `deep-security-scan` /
`security-diff-scan`, after `Validate`, running one read-only agent per
`reportable` finding (the set is already small post-threshold, so cost is bounded
and it can reuse the chunk-of-8 pattern). Its schema returns
`verified | corrected | rejected` plus corrected fields; the report agent consumes
the reconciled set. `pr-review-fanout`'s verify-per-finding is the in-repo
precedent for the call shape — this generalizes it to the repo-wide scans and
re-points it from "refute the exploit" to "ground the claim."

### 2. Stateful / incremental runs — *recommended*

The skill writes each run to `~/security-audit-skill/<repo>/run-<N>` and reads any
prior `findings.json` to **skip known findings, steer toward unexplored paths, and
record coverage limits**. shipofcladius runs are fully stateless.

**How to adopt:** an optional `args.priorFindings` (path to a previous report's
JSON) merged into the dedup step so re-runs surface only *new* candidates and the
coverage statement can say "delta vs run N." This turns the scans from one-shot
audits into a **monitor you can re-run per release** — the natural pairing with
the existing `security-diff-scan` (diff = new code, prior-findings = old verdicts).

### 3. Sharper validator prompt — *recommended, near-zero cost*

Fold three things from the skill into the existing validator prompts:

- **The five named tests** — exploitation, impact, baseline, mitigation,
  parser/runtime-behavior — as an explicit checklist the validator must answer,
  not leave implicit.
- **Dynamic baseline** — "compare to comparable systems; if untouched production
  code hasn't been exploited, understand *why* before reporting." A strong
  FP-killer the repo doesn't state.
- **Anti-patterns** — don't pad with LOWs, don't rate a missing *second* layer
  (defense-in-depth) as HIGH/CRITICAL, don't report OWASP-checklist deviations as
  findings. These sharpen severity calibration and cut report noise.

Pure prompt edits to the `VALIDATION_SCHEMA` agent prompts; covered by the
existing offline simulators.

### 4. Business-logic / feature-abuse / chained + "wildcard" lenses — *recommended, cheap*

The skill makes business logic, feature abuse, **chained** attacks, and a
deliberate **wildcard/creative** angle first-class hunt classes, explicitly
because "the standard vulnerability classes are what every scanner checks." The
four default `DEFAULT_LENSES` here cover injection, authz/multi-tenancy,
secrets/crypto/supply-chain, and resource/concurrency/logic — business-logic abuse
and chained exploits live only inside lens 4, and there is no creative wildcard
lens. Add a fifth business-logic/feature-abuse/chaining lens and let one of the
budget-scaled generalist passes be explicitly a "wildcard" pass.

### 5. Shared recon artifact — *optional*

The skill runs recon **once** into `architecture.md` and feeds it to every hunt
agent. shipofcladius deliberately has each worker recon **independently** — that
independence is the source of its recall win (N lenses don't miss the same
things), so a *shared* artifact trades some of that away. A middle path: an
optional cheap recon pre-pass that produces a shared map of surfaces/trust
boundaries handed to workers as *context they may extend*, not replace. Lower
priority — it optimizes cost/consistency, not recall, and partly cuts against the
existing design thesis.

## What not to adopt

- **A separate `validate-findings.cjs` structural check.** The skill needs it
  because its agents free-write `findings.json`; shipofcladius enforces JSON shape
  *inline* via `agent({ schema })` at every stage, so a post-hoc structural
  validator is redundant.
- **Filesystem run directories as the state channel.** The Workflow tool returns
  structured results directly; prefer passing prior findings as an `arg` over
  scanning `~/security-audit-skill/<repo>/run-<N>` from disk.
- **Dropping the deterministic prefilter or the injection hardening to "match" the
  skill.** Both are areas where this repo is *ahead*; the skill is the thing that
  should adopt from us, not the reverse.

## Suggested sequencing

1. **`Verify` gate** in `deep-security-scan` + `security-diff-scan` (#1) — highest
   value, bounded cost, in-repo precedent.
2. **Validator-prompt sharpening** (#3) + **business-logic/wildcard lenses** (#4) —
   cheap prompt edits, ship alongside #1.
3. **Incremental runs** (#2) — larger change (dedup + coverage-delta plumbing),
   own PR.
4. **Shared recon pre-pass** (#5) — only if cost/consistency becomes a concern.

Each of these is a self-contained workflow edit guarded by the existing offline
simulators (`tests/`), so adoption can land incrementally without token-cost
regression.
