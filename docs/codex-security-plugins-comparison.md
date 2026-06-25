# Codex security plugins vs. shipofclaudius

A concept-level comparison of two external "codex security" corpora against the
security workflows already in this repo (`deep-security-scan`,
`security-diff-scan`, `defense-scan`, plus the security dimension of
`pr-review-fanout` and the security-hardening pass in `stacked-impl-lanes`):

1. **OpenAI's [`codex-security`](https://github.com/openai/plugins/tree/main/plugins/codex-security/skills) plugin** — a 10-skill, MCP-backed security-review product. This is the *direct* comparison: it even shares two skill **names** with us (`deep-security-scan`, `security-diff-scan`).
2. **[`trailofbits/skills`](https://github.com/trailofbits/skills)** — a 74-skill / 39-plugin marketplace of mostly *atomic specialist* security tools (per-chain contract scanners, fuzzers, sanitizers, crypto side-channel, SAST-engine wrappers, rule authoring, reversing).

The goal is the same as the [Cloudflare harness evaluation](cloudflare-harness-evaluation.md):
not "should we copy it," but **for each skill, do we have it, and is our version
better or worse** — and which handful of genuinely new ideas are worth adopting.

> Sourcing note: both repos were read directly via `gh api` (skill `SKILL.md`
> bodies, schemas, references, manifests). OpenAI's plugin is **Proprietary**-licensed
> (concepts only — no code reuse). Trail of Bits is CC BY-SA 4.0.

---

## TL;DR

- **vs. OpenAI codex-security:** This is the closest peer to shipofclaudius — both
  are multi-agent, disprove-first, coverage-honest security pipelines that
  converged on the same core. We are **ahead** on three axes (a deterministic
  prefilter `foxguard`; indirect-prompt-injection hardening; a layered
  `defense-scan` orchestrator) and roughly even on the two namesakes. OpenAI is
  **ahead** on four concepts worth stealing, highest value first:
  1. **A sealed, content-addressed, schema-validated artifact contract** (manifest
     + findings + coverage, with fingerprints and a coverage *schema* that
     distinguishes "not observed" from "not scanned"). This is the enabler for the
     stateful/incremental runs the Cloudflare eval already flagged we lack.
  2. **A dedicated `attack-path-analysis` severity stage** (facts → severity →
     policy, with an auditor-grade rubric and an explicit "should not be
     high/critical" list). We fold severity into the validator; theirs is sharper.
  3. **A saturation loop in `deep-security-scan`** — repeat discovery rounds until a
     full round adds zero new candidates. We do a single fan-out round; theirs is
     loop-until-dry.
  4. **`triage-finding`** (intake *external* findings — SARIF/CVE/GHSA/scanner
     tickets — and triage them against the repo). We have no analog.
- **vs. Trail of Bits:** A *different category of thing*. It's a marketplace of
  deep, single-purpose specialist tools; we're an orchestration layer. We have
  near-zero direct overlap and **shouldn't** — only `differential-review`,
  `fp-check`, and the `static-analysis`/`supply-chain` skills map onto anything we
  do, and there our orchestrated versions are comparable-or-better. The rest
  (smart-contract scanners, fuzzers, crypto side-channel, reversing, rule
  authoring) are depth we don't have and aren't trying to be — though a few are
  worth knowing about as *tools a `defense-scan` layer could shell out to*.

---

# Part 1 — OpenAI `codex-security` (the direct comparison)

## Architecture contrast

| Axis | OpenAI codex-security | shipofclaudius |
|---|---|---|
| Runtime | A real **MCP server** (bundled, Brotli-split binary) + an "MCP Apps" HTML workspace + connectors (Linear/GitHub/Atlassian), with capability **preflight** and goal-tool "don't stop until closed" contracts, and dual Codex-app/CLI routing | **Workflow-tool-native** JS: `agent()`/`parallel()`/`pipeline()` fan-out, schema-enforced structured output, no server, no app surface |
| Decomposition | **10 discrete skills**: 3 orchestrators (`security-scan`, `security-diff-scan`, `deep-security-scan`) that invoke 4 phase skills (`threat-model`, `finding-discovery`, `validation`, `attack-path-analysis`) + 3 utilities (`triage-finding`, `fix-finding`, `track-findings`) | **3 monolithic workflows** with phases inlined as code (`Tools → Discovery → Validate → Report`). Phases are not independently invocable skills |
| Pipeline shape | **Strict separated linear phases** ("do not amortize effort across phases"), with a **candidate-ledger** receipt spine (`discovery`/`validation`/`attack-path` receipts per finding) enforcing coverage | **Parallel fan-out + barrier merge**: K independent lensed workers → semantic dedup → chunked disprove-first validators → one report |
| Output | **Sealed 3-doc bundle**: `scan-manifest` (immutable, `sealedAt`), `findings` (content-addressed `findingId`/fingerprints, CWE, CVSS, remediation), `coverage` (schema-level "complete/partial/unknown", reviewed surfaces, explicit exclusions). SARIF is a downstream projection | **One HTML + markdown report** + a structured return object; coverage is a mandatory **prose** statement; structured output is schema-enforced *inline* at every stage but not persisted as a content-addressed bundle |
| Recall amplifier | `deep-security-scan` = **6 workers × up to 10 rounds, loop until saturated** (a round adds zero new candidates), all running the *same brief* (stochastic diversity) | `deep-security-scan` = **K workers in one round** (default 4, budget-scaled to 8), each a *different designed lens* (lens diversity) + a deterministic `foxguard` prefilter |
| False-positive control | `validation` (prefers a real PoC/ASan/test, static fallback) **then** `attack-path-analysis` (separate severity + policy stage, auditor rubric) | Single **disprove-first validator**: trichotomy (`confirmed`/`refuted`/`needs-info`) + >80% confidence floor + severity folded in; **trace-only** (no builds — concurrent builds stalled prior runs) |
| Prompt-injection hardening | Not a focus (scans treat code as data implicitly) | **First-class**: nonce-fenced untrusted diff/PR text, read-only `agentType`, read-scoped token, HTML-escaped report (see README *Security model*) |
| Deterministic prefilter | None (agents do all discovery) | **`foxguard`** Phase 0 (SAST taint + secrets + OSV SCA + PQC), zero-token candidates fed ahead of agents in the merge |
| Layered/dynamic coverage | None (code-at-rest only) | **`defense-scan`** composes supply-chain / DAST / LLM-red-team / network-template / governance layers |

**Net:** They're a heavier *product* (server, app, connectors, sealed artifacts,
governance plumbing). We're a leaner *orchestration layer* that is ahead on
prefiltering, injection safety, and breadth of layers. The interesting
exchange is in the middle — the phase methodology.

## Per-skill verdict

| OpenAI skill | What it is | Do we have it? | Better / worse |
|---|---|---|---|
| **`security-scan`** | Repo/scoped-path orchestrator, 5 linear phases, sealed output | **Yes** — `deep-security-scan` is our repo scanner (we have no separate single-pass scanner; our "deep" *is* the repo audit) | **Mixed.** We add `foxguard` + injection hardening + budget-scaling; they add the sealed artifact contract + coverage schema + goal-closure |
| **`security-diff-scan`** | Same pipeline scoped to a git change; deterministic per-row worklist; **diff-scoped sibling coverage** + unchanged siblings as **negative controls** | **Yes** — namesake `security-diff-scan` | **Even, different strengths.** Ours: K independent lenses, an explicit `removed-guard`/`exposed-existing` taxonomy, a change-scope gate, **nonce-fenced PR text**. Theirs: deterministic worklist (every row reviewed), sibling-expansion reasoning, negative controls, sealed artifacts |
| **`deep-security-scan`** | Recall wrapper: **6×10 same-brief workers, loop until saturated**, remediation-subsumption merge | **Yes (namesake) — but different mechanism** | **Mixed.** Ours uses *lens diversity* + a deterministic prefilter and is cheaper; theirs uses *round-saturation* (loop-until-dry) we lack. The saturation loop is a real gap |
| **`threat-model`** | Standalone, **persisted, repo-scoped** threat model reused by later phases | **No standalone** — each of our workers builds its *own per-lens* threat model inline; nothing shared/persisted | **Worse / absent** — by design (independence drives our recall). Echoes the Cloudflare eval's "shared recon artifact" (#5) |
| **`finding-discovery`** | Discrete discovery phase with **deep class-specific checklists** (deserialization codecs, SAML assertion selection, archive traversal, SSRF destinations…) | **Folded in** — our Discovery workers do this, but with 4 light lens prompts, not exhaustive per-class checklists | **Worse on checklist depth**, comparable on mechanism. Echoes Cloudflare eval #4 (business-logic/chained lenses) |
| **`validation`** | Prefers a **real reproduction** (crash PoC → ASan → debugger → test → static); "confidence from method, not bug-class" | **Yes** — our disprove-first validator (trichotomy + 80% floor) | **Mixed.** Ours is **trace-only** (safe/cheap/bounded — no builds by deliberate choice); theirs can produce stronger evidence (actual PoC) at higher cost/risk. Their "method-not-bug-class" calibration is sharper |
| **`attack-path-analysis`** | **Separate** severity stage: facts → severity → mechanical policy pass; counterevidence pass; auditor-grade rubric + explicit "should-not-be-high" list | **Folded into the validator** (impact×reachability×preconditions, optional CVSS) | **Worse** — theirs is materially sharper at severity calibration & FP suppression. Strongest single-concept adoption candidate (overlaps Cloudflare eval #3 anti-patterns) |
| **`triage-finding`** | Intake **external** findings (SARIF/CVE/GHSA/scanner tickets/Jira/Linear/GitHub) → triage vs repo → `confirmed`/`not_actionable`/`needs_review` + exploitability stack-rank | **No analog** — our `pr-triage-fanout`/`issue-triage-fanout` triage PRs/issues, not security findings | **Gap.** (ToB's `fp-check` is the nearest external thing) |
| **`fix-finding`** | Minimal validated remediation of one finding (or prove already fixed) + regression test, scoped to the narrowest invariant boundary | **Partial** — `stacked-impl-lanes` implements issues and runs a security-hardening review; built-in `/code-review --fix` and `/security-review` are adjacent; no dedicated "fix one finding minimally + prove" skill | **Worse / partial** |
| **`track-findings`** | File a finding from a **sealed** scan into Linear/Jira/GitHub issue or a **draft GHSA**, with dedup + payload preview + readback | **Partial** — we have `/issue` (file issues-as-prompts) and `/ghsa` (full GHSA lifecycle incl. CVSS), but **no automated sealed-scan → tracker bridge** with dedup/preview/readback | **Mixed** — we have the destinations, they have the integrated pipeline |

## The adoption candidates, in detail (OpenAI side)

1. **Sealed, content-addressed artifact contract + coverage *schema* — highest value.**
   We already emit schema-enforced structured findings and a prose coverage
   statement, but not a *persisted, fingerprinted, machine-consumable bundle*.
   Adopting a finding fingerprint + a coverage object (with `complete/partial/unknown`
   and explicit exclusions) is the missing substrate for **stateful/incremental
   runs** (Cloudflare eval #2): re-run per release, dedup against a prior bundle,
   report a coverage delta, and project SARIF for free. This is the single
   highest-leverage idea across both corpora.

2. **A dedicated severity/attack-path stage (their `attack-path-analysis`).**
   Split severity calibration out of the validator into its own pass with the
   facts→severity→policy separation, a counterevidence sweep on interpretive
   fields, and an explicit "should-not-be-high/critical" anti-pattern list
   (self-XSS, theoretical memory-corruption, internal-only, "could matter if
   chained"). This sharpens calibration and cuts report noise — and dovetails with
   the validator-prompt sharpening already recommended in the Cloudflare eval (#3).

3. **A saturation loop in `deep-security-scan` (their round model).**
   Today we run one fan-out round of K lensed workers. Their model keeps spawning
   discovery rounds until a full round adds **zero** new merged candidates
   (`saturated`, capped at 10). This is the canonical *loop-until-dry* pattern and a
   genuine recall lever we don't pull. The natural shipofclaudius form: keep our
   *lens diversity* but wrap it in a budget-bounded `while (newCandidates > 0 &&
   round < cap)` loop, deduping each round against all prior rounds.

4. **`triage-finding` as a new skill.** Intake an external findings file
   (SARIF/CVE/GHSA/scanner output) and triage each item against the current repo
   to `confirmed`/`not_actionable`/`needs_review` with an exploitability rank. This
   is backlog burn-down we have no story for, and it composes naturally with our
   `foxguard` prefilter output and `/ghsa` / `/issue` for the confirmed items.

5. **Richer per-class discovery checklists (their `finding-discovery`).** Cheap
   prompt edits: fold the class-specific hunt checklists (deserialization codecs,
   SAML/SSO assertion selection, archive traversal, SSRF destination classes) into
   our lens prompts. Same recommendation as Cloudflare eval #4, now with a concrete
   source.

### What *not* to adopt from OpenAI
- **The bundled MCP server + app surface + connectors + capability preflight +
  goal-tool plumbing.** That's product scaffolding for the Codex desktop/CLI
  runtime; the Workflow tool gives us fan-out, structured output, and progress
  natively. Adopting the *artifact contract* (concept #1) does not require adopting
  the server.
- **Dropping trace-only validation to chase real PoCs.** Their reproduce-first
  validation is stronger evidence but we made trace-only a deliberate choice
  (concurrent builds stalled large runs). Keep trace-only as the default; a
  real-repro mode could be an opt-in, not the baseline.
- **Filesystem run-dirs as the state channel.** If we add stateful runs, pass the
  prior bundle as an `arg`, consistent with the Cloudflare eval's conclusion.

---

# Part 2 — Trail of Bits `skills`

## What it is, and why the comparison is asymmetric

`trailofbits/skills` is a **Claude Code plugin marketplace** (also loadable by
Codex via Claude-marketplace compatibility — no `.codex/skills` sidecars) of **74
skills across 39 plugins**. Almost all are **atomic, deep, single-purpose
specialist tools** encoding Trail of Bits' audit methodology. shipofclaudius is an
**orchestration layer** (multi-agent fan-out + validation + reporting). So unlike
the OpenAI comparison, this is mostly **"different category — no overlap, and
correctly so."** The useful output is: (a) the few that *do* overlap, and (b) the
specialist tools worth knowing about as `defense-scan` shell-out candidates.

## Where we overlap (the only apples-to-apples subset)

| ToB skill | What it is | Do we have it? | Better / worse |
|---|---|---|---|
| **`differential-review`** | Security-focused diff/PR review with regression detection | **Yes** — `security-diff-scan` | **Comparable; ours more orchestrated** (K lenses + adversarial validation + report + injection-fenced PR text) vs. their focused single skill |
| **`fp-check`** | Verify a suspected bug → TRUE/FALSE-POSITIVE verdict with evidence | **Yes, as an internal phase** — our disprove-first validator (and OpenAI's `validation`/`triage-finding`) | **Comparable in substance**; theirs is a *standalone* skill, ours is baked into the pipeline |
| **`static-analysis` (codeql / semgrep / sarif-parsing)** | Run CodeQL/Semgrep, parse/dedupe SARIF | **Partial** — `foxguard` is our deterministic SAST/secrets/SCA prefilter; we don't wrap CodeQL/Semgrep specifically or parse external SARIF | **Mixed** — we have a prefilter; they have engine-specific depth + SARIF tooling (which pairs with OpenAI's SARIF projection idea) |
| **`supply-chain-risk-auditor`** | Flag deps at heightened takeover/exploit risk | **Partial** — `defense-scan` Layer 2 (bumblebee) + `foxguard` OSV SCA | **Comparable**, different emphasis (theirs: takeover risk; ours: known-CVE + malicious-package intel) |
| **`audit-context-building` / `trailmark` family** | Line-by-line context building; **code-graph** taint/blast-radius/attack-surface | **No** — our per-worker threat models are prose, not a queryable code graph | **Worse** (they have real graph tooling) — but it's specialist depth, not our lane |
| **`variant-analysis`** | Find variants of a known bug across a codebase via CodeQL/Semgrep | **No** | **Gap** (specialist) |
| **`agentic-actions-auditor`** | Audit GitHub Actions for prompt-injection reaching AI agents in CI | **No dedicated skill** (our scans would catch some) | **Gap** — topical given our own injection-hardening focus; a plausible niche skill |

## Where there is no overlap (and shouldn't be)

These are deep specialist domains shipofclaudius does not address and is not trying
to — listed so the gaps are explicit, not silent:

- **Smart-contract scanners** (7): `algorand`/`cairo`/`cosmos`/`solana`/`substrate`/`ton-vulnerability-scanner`, `token-integration-analyzer`, plus `entry-point-analyzer`, `building-secure-contracts` audit helpers, `spec-to-code-compliance`. *No analog; out of scope.*
- **Fuzzing / PBT / sanitizers** (~15, the `testing-handbook-skills`): AFL++, libFuzzer, LibAFL, atheris, cargo-fuzz, ruzzy, OSS-Fuzz, AddressSanitizer, coverage analysis, harness writing, dictionaries, `property-based-testing`, `mutation-testing`, `genotoxic`. *No analog; dynamic-testing depth.*
- **Crypto / side-channel / formal verification**: `constant-time-analysis`, `constant-time-testing`, `wycheproof`, `vector-forge`, `crypto-protocol-diagram`, `mermaid-to-proverif`, `dimensional-analysis`, `zeroize-audit`. *No analog; specialist crypto.*
- **Reverse engineering / mobile**: `dwarf-expert`, `firebase-apk-scanner`, `burpsuite-project-parser`. *No analog.*
- **Detection-rule authoring**: `semgrep-rule-creator`, `semgrep-rule-variant-creator`, `yara-rule-authoring`. *Different purpose (we consume detection, don't author rules).*
- **Audit-process / language / meta tooling**: `audit-prep-assistant`, `code-maturity-assessor`, `guidelines-advisor`, `secure-workflow-guide`, `sharp-edges`, `insecure-defaults`, `modern-python`, `c-review`, `second-opinion`, `skill-improver`, `designing-workflow-skills`, plus non-security (`gh-cli`, `git-cleanup`, `devcontainer-setup`, `culture-index`, `let-fate-decide`, …). *Mostly out of scope; `insecure-defaults`/`sharp-edges`/`c-review` overlap our discovery lenses but as standalone checklists.*

## What's worth taking from Trail of Bits

Not skills to clone — **tools/ideas to reference**:

1. **`defense-scan` shell-out candidates.** ToB packages clean wrappers around
   exactly the kind of deterministic tools `defense-scan` already shells out to.
   `codeql`/`semgrep` (deeper than our `foxguard` SAST), the smart-contract
   scanners, and the fuzzers are all plausible **opt-in layers** if we ever target
   those domains. Worth tracking as a menu.
2. **`fp-check` as the standalone shape for a `triage-finding` skill.** If we build
   the OpenAI-style `triage-finding`, ToB's `fp-check` (TRUE/FALSE-POSITIVE verdict
   from evidence) is the cleanest single-finding precedent to mirror.
3. **`agentic-actions-auditor`** is a small, on-brand niche given our injection
   hardening — auditing CI workflows for attacker-controlled input reaching AI
   agents is adjacent to what our *Security model* already cares about.
4. **SARIF as an interchange format** (`sarif-parsing` + OpenAI's SARIF projection)
   reinforces concept #1: if our findings bundle can emit/ingest SARIF, both ToB's
   static-analysis output and OpenAI's projection become interoperable with us.

---

# Combined priority (both corpora)

Folding these in with the still-open Cloudflare eval candidates, the ranked list of
genuinely-new ideas worth adopting:

1. **Sealed, fingerprinted findings + coverage-schema bundle** (OpenAI) → unlocks
   **stateful/incremental runs** (Cloudflare #2) and **SARIF interop** (ToB). *Highest leverage.*
2. **Dedicated severity/attack-path stage** (OpenAI `attack-path-analysis`) +
   **validator-prompt sharpening / anti-patterns** (Cloudflare #3). *Cheap-ish, high quality gain.*
3. **Saturation loop in `deep-security-scan`** (OpenAI round model) — loop-until-dry
   over our lens-diverse workers. *Medium change, real recall lever.*
4. **`triage-finding` skill** (OpenAI), shaped like ToB `fp-check`, feeding `/ghsa` / `/issue`. *New capability, no current analog.*
5. **Richer per-class discovery checklists + business-logic/wildcard lens**
   (OpenAI `finding-discovery` + Cloudflare #4). *Pure prompt edits.*
6. **Independent factual-verification gate** (Cloudflare #1) — still open; complementary to #2.

Each is a self-contained workflow edit guarded by the offline simulators in
`tests/`, so adoption can land incrementally without token-cost regression — same
conclusion as the Cloudflare eval.

---

## Status (landed)

This comparison is the source-of-record for a batch of security-workflow work that
has since shipped. All six ranked ideas above — plus the two additional gaps
surfaced in review (`fix-finding`, `track-findings`) — were filed as issues
**#21–#28** and have all landed on `main`:

| Idea (this doc) | Issue | PR |
|---|---|---|
| #1 Sealed fingerprinted findings + coverage bundle (+ SARIF) | #21 | #32 |
| #2 Dedicated severity/attack-path stage + validator anti-patterns | #22 | #37 |
| #3 Saturation loop in `deep-security-scan` | #23 | #36 |
| #4 `triage-finding` skill | #24 | #35 |
| #5 Richer per-class discovery checklists + business-logic/wildcard lens | #25 | #30 |
| #6 Independent factual-verification gate (Verify phase) | #28 | #31 |
| Gap: `fix-finding` skill | #26 | #33 |
| Gap: `track-findings` bridge | #27 | #34 |

Two scoped follow-ups remain open: **#38** (make the saturation budget floor
measured, not a flat estimate) and **#39** (surface the severity-calibration tally
in `defense-scan`'s Layer 1 coverage statement).
