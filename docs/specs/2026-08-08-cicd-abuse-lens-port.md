# Porting the CI/CD pipeline-abuse lens out of the retired `security-diff-scan` skill

Date: 2026-08-08 · Issue: [#89](https://github.com/schmug/shipofclaudius/issues/89) · Decision context: [#87](https://github.com/schmug/shipofclaudius/issues/87)

## Why this existed

`#87` ruled that **the plugin is canonical** and the hand-rolled `~/.claude/skills/` copies are
retired. Applying that to `security-diff-scan` surfaced a gap: the retired local copy was not an
older rendering of the plugin's workflow — it carried a **CI/CD pipeline-abuse detection lens that
never existed in this repo**. Content search against `origin/main` confirmed it: `cicd`,
`ci-abuse`, and `workflow_run` returned nothing, and `pull_request_target` appeared only in
`docs/specs/2026-08-05-software-factory-design.md` and `tests/plugin-integrity.test.mjs`, both
about this repo's *own* CI rather than the scan lens.

So retiring the directory was correct for consistency but would have silently dropped a deliberate
2026-06-19 capability. This note records what was ported, what was judged already-superseded, and
the evidence for each call — so `~/.claude/retired-skills/security-diff-scan/` can be deleted
without losing anything.

## Source inventory and disposition

| Retired file | Size | Disposition |
|---|---|---|
| `references/methodology.md` | 10276 b | **Superseded, except the lens** — lens ported, rest already implemented |
| `tests/ci-abuse-lens.test.mjs` | 3217 b | **Ported** → `tests/ci-abuse-lens.test.mjs` |
| `assets/report-template.html` | 5177 b | **Superseded** — byte-duplicate of a template the workflow already uses |
| `SKILL.md` | 6615 b | **Superseded** — its pipeline, target resolution, and guardrails are the workflow |

### `methodology.md` — superseded except the lens

The lens was the only absent content, exactly as `#89` predicted. It was **prose-embedded across
three phases**, not a self-contained block, so all three touches were ported, not just the Phase 2
section:

| Methodology phase | Touch | Ported to |
|---|---|---|
| Phase 1 — threat model | "CI/CD config is itself a trust boundary" | `CICD_TRUST_NOTE`, appended to `CHANGE_BLOCK` so **every** reasoning stage sees it |
| Phase 2 — discovery | the lens + its six vectors + provenance | `CICD_ABUSE_LENS`, a gated extra discovery worker |
| Phase 4 — severity | "CI secret exfiltration is high/critical" | `CICD_SEVERITY_RULE`, appended to `severityPrompt` |

Everything else in the file was checked against
[`.claude/workflows/security-diff-scan.js`](../../.claude/workflows/security-diff-scan.js) element
by element and is already implemented as orchestration rather than prose — a stronger form, since
the workflow *executes* the phases instead of describing them:

- **Phase 1** — per-worker threat model, trust boundaries, attacker-controlled input, invariants.
- **Phase 2** — low discovery bar, "distrust the narrative / trust the code", expansion to
  newly-exposed siblings, the candidate ledger (`CANDIDATE_SCHEMA`), fan-out with a merge point
  (`addCandidate` dedup).
- **Phase 3** — disprove-first validation, `confirmed` / `refuted` / `needs-info`, the recorded
  `proof_gap`, and a second independent pass (the `Verify` phase, which the prose only suggested).
- **Phase 4** — `impact × reachability × preconditions`, the `critical…info` map, the mechanical
  reportability gate (`meetsThreshold`), and "suppressed ≠ deleted" (the visible appendix).
- **Phase 5** — `report.html` + `report.md`, mandatory HTML-escaping of untrusted content, the
  coverage statement.
- **Coverage discipline** — reviewed surfaces, explicit exclusions, degraded-worker accounting, and
  the "found nothing ≠ didn't look" / "not observed ≠ not scanned" distinction.

Porting the prose file itself would have duplicated all of that in a form nothing executes or
tests. It is not carried over.

### `report-template.html` — superseded

`diff` against the live `~/.claude/skills/security-scan/assets/report-template.html` shows the two
are **byte-identical apart from the footer skill name and a "keep these in sync" note** — the
retired copy was always a duplicate. The workflow's report agent already instructs: use
`~/.claude/skills/security-scan/assets/report-template.html` if present, otherwise produce an
equivalent self-contained HTML report. Nothing is lost.

### `SKILL.md` — superseded

Its substance is the five-phase pipeline (now the workflow's phases), the scan-workspace layout
(the workflow creates `.security-scans/<UTC-timestamp>-diff`), target resolution (`git diff`,
`git diff base...head`, `gh pr diff`, `git show` — all in the resolve relay prompts), and four
guardrails (stay change-anchored, read before concluding, escape untrusted content, no silent
truncation) — all present in the workflow. Its only unique content was the discovery-bullet pointer
at the lens, which is what this port replaces.

## What shipped

- **Gated in code, not in prose.** `isCicdPath()` over the *resolved changed files* decides
  activation, so "did the lens fire" is deterministic and assertable without spawning an agent.
  A non-CI diff spawns no extra worker and pays nothing.
- **Diff-anchored, deliberately.** The CI worker receives the same `SCOPE_RULE` as every other
  lens — each candidate must trace to a changed hunk. `#89` named widening this to a whole-repo CI
  sweep as an explicit non-goal; `tests/ci-abuse-lens.test.mjs` asserts the boundary in both
  directions, and a mutation that forces the gate always-on fails the suite.
- **Additive to `args.lenses`.** The lens is a gate, not a default lens, so a custom lens list
  never silently disables it. `args.cicdLens` forces it on or off.

## Provenance

The threat taxonomy is derived from **elastic/cicd-abuse-detector** (Apache-2.0; a prototype, and
explicitly **not** an officially supported Elastic product). The recorded decision in `#89` was
*not* to adopt that tool as a `defense-scan` layer — wrong shape (three files you commit into a
repo to run as CI steps, not a binary you invoke) — but to borrow the detection framing into the
diff review. Only the framing is borrowed. The attribution is preserved in the lens text itself,
in `README.md`, and is pinned by the content-contract test.

## Follow-up

`~/.claude/retired-skills/security-diff-scan/` can be deleted once this lands. That is a change to
`~/.claude/`, outside this repo, and is the user's to make.
