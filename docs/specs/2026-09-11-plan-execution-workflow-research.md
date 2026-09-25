# Plan-Execution Workflow — Research & Recommendation

**Date:** 2026-09-11
**Repo:** `schmug/shipofclaudius`
**Status:** Research and design only, per [#218](https://github.com/schmug/shipofclaudius/issues/218). No
workflow built here — that is explicitly out of scope for #218 and is instead sketched below as a
follow-up.

---

## 0. The question

Does shipofclaudius need a workflow for executing a **written implementation plan document** — a
`superpowers`-style task DAG with explicit `Interfaces: Consumes / Produces` contracts between
steps — and if so, what shape does it take? Every workflow in this repo currently takes a **GitHub
issue or PR** as its unit of work; plan-shaped work does not fit any of them.

## 1. Evidence (from #218)

Two independent attempts to route plan-shaped work through this suite both concluded "use
`superpowers:subagent-driven-development` instead":

- **A 5-task port slice**, run through `parallel-build-orchestrator`. Phase 0 failed three of five
  preflight gates (no git remote yet, no filed issues — the skill requires issue numbers per lane
  — and the repo's own gates were unreadable because the task itself was what would create them).
  Phase 1's overlap matrix then returned 3 overlapping pairs, critical path 5 of 5, **max useful
  concurrency 1**.
- **A 5-task audio-runtime plan**, same skill. The overlap matrix returned **10 of 10 pairs
  overlapping** (every task appended its own test file to `package.json`), critical path 4 of 5.
  Again, no filed issues.

## 2. Why plan tasks don't fit this suite's model

### 2.1 The unit of work is wrong

Every `.claude/workflows/*.js` here assumes GitHub issues (or PRs derived from them) as the unit
of work: `stacked-impl-lanes` requires issue numbers per lane; `issue-triage-fanout` /
`issue-research-fanout` classify issues; `stacked-merge-walk` / `merge-pr-with-gate` walk PRs that
trace back to issues via `Closes #N`. `parallel-build-orchestrator` (a session-long **process
skill**, not a Workflow — see `skills/parallel-build-orchestrator/SKILL.md`) already tries to
bridge "epic → lanes," but its Phase 0 hard-requires filed issues before Phase 1 can run, so it
inherits the exact same shape. A plan document is not a backlog of issues; converting it into one
is a lossy translation the issue names precisely: a plan task carries an explicit
`Interfaces: Consumes / Produces` block because each implementer sees only its own task, and an
issue body has nowhere structural to hold that contract.

### 2.2 The scheduling primitive doesn't transfer

`issue-triage-fanout` / `issue-research-fanout` compute a **file-overlap wave plan** in script code
(README §"File-overlap wave plan") — issues whose file footprints are disjoint parallelize, issues
that collide serialize. This primitive assumes the input is closer to a **set** with occasional
dependency edges. A plan is close to the opposite: by construction, each task's `Produces` is the
next task's `Consumes`, so the dependency graph is close to a **chain**. Both #218 attempts
demonstrate this empirically — 3/5 and 10/10 pairs overlapping is not an unlucky pair of plans, it
is what a linear plan's overlap matrix looks like when measured honestly. A workflow built around
this suite's wave-plan primitive would compute `waves: [{ parallel: [one task] }, …]` every time
and pay full DAG-planning cost for a result that was chain-shaped from the start.

### 2.3 Workflow scripts can't read a plan file directly

Workflow scripts have no file IO (see `CLAUDE.md` / README "Read-checkpoint" — the existing
per-item state cache is agent-mediated for exactly this reason: a `load` agent `cat`s the file, the
script never does). A plan-execution workflow would need the same pattern: an agent reads
`plan.md`, returns its task list as structured JSON, and the script drives `agent()` calls from
that. This is a real but known cost, not a blocker — it's the same shape as the read-checkpoint's
load step.

## 3. What is genuinely missing

Not per-task TDD execution. `superpowers:subagent-driven-development` already does this — both
#218 attempts landed there and neither reported it as inadequate. Duplicating a working per-task
runner inside this suite would be effort spent with no comparative advantage.

What #218 names as the actual gap is narrower: **the adversarial review gate**. Plan execution (as
run today) has no equivalent of `stacked-impl-lanes`' Phase 3 — an independent agent that did not
write the code, re-running the verification command **itself**, plus a read-only adversarial
defect-class critic holding a fixed taxonomy. That machinery already exists in this suite and
already generalizes past issues: it operates on a **branch and a verify command**, and nothing
about it requires the branch to have come from an issue-numbered lane.

## 4. Recommendation

**Build a workflow — but a narrow one, not a plan orchestrator.** Do not attempt to wrap or replace
`subagent-driven-development`'s per-task loop; that duplicates working machinery this suite has no
edge on (§2.1, §3). The piece worth adding is the review gate, applied to **one already-implemented
branch at a time**, independent of how that branch was produced.

Answering #218's four questions directly:

1. **Worth a workflow?** Yes, narrowly — see above. The broader "does shipofclaudius need to
   execute plans end-to-end" answer is **no**; that would duplicate `subagent-driven-development`.
2. **Wrap or replace `subagent-driven-development`?** Neither. A new sibling workflow —
   sketched as `gate-plan-branch` below — sits downstream of it: `subagent-driven-development`
   (or a human, or anything else) produces a branch for one completed plan task; the new workflow
   gates that branch. It never sees the plan document itself and never converts anything to an
   issue, satisfying #218's explicit constraint.
3. **Landing?** Unchanged. `merge-pr-with-gate` already does exactly the staged-then-squash-merge
   sequence a gated branch's PR needs — hand off to it rather than reimplement landing.
4. **Does the overlap-matrix / wave-plan primitive transfer?** No (§2.2). `gate-plan-branch`
   should process **one branch per invocation** and make no attempt to schedule or parallelize
   plan tasks; that is `subagent-driven-development`'s job, and it already does it sequentially by
   design. Forcing a wave-plan model onto a workload that both measured attempts showed is close
   to a chain would add planning overhead without adding parallelism.

### 4.1 Sketch: `gate-plan-branch`

For the follow-up implementation session, not built here:

- **Inputs:** `{ branch (required), verify (required — the exact command that proves the task), base? (default main), defectClasses? (same convention as stacked-impl-lanes'), repo? }`. No issue number, no plan path — the workflow operates purely on a branch and a command, exactly what a completed plan task actually is once implemented.
- **Gate A — empirical re-verification.** A write-capable-nothing, read-and-execute agent checks
  out `branch` in a fresh worktree/clone and runs `verify` itself, then the repo's full suite.
  Pasted output from whoever implemented the task is never trusted, mirroring
  `parallel-build-orchestrator`'s Phase 3 Gate A and `stacked-impl-lanes`' Gate A pattern.
- **Gate B — adversarial defect-class critic.** One read-only agent holding the whole
  `defectClasses` taxonomy (same defaults and override convention as `stacked-impl-lanes`),
  required to report verbatim `commands_run` — identical shape to the existing critic, reused
  rather than reinvented.
- **Output:** `PASS` (with both gates' evidence) or `FAIL` (the specific findings, routed back to
  whoever is driving plan execution — never auto-fixed inline, same independence rule as
  `stacked-impl-lanes` Phase 3).
- **Landing:** out of scope for this workflow — on `PASS`, the caller opens (or already has) a PR
  from `branch`, and `merge-pr-with-gate` gates + squash-merges it exactly as it does for any other
  PR today.
- **What it explicitly does not do:** parse a plan document, dispatch multiple tasks, compute an
  overlap/wave plan, or touch GitHub issues. One branch in, one verdict out.

### 4.2 What not to build

- Not a plan-file parser/orchestrator that walks a whole plan and dispatches all N tasks —
  `subagent-driven-development`'s job, no comparative advantage here (§3).
- Not a plan-shaped variant of `stacked-impl-lanes` — its lane/batching machinery assumes GitHub
  issue numbers end to end (`Closes #n` on every lane), and #218 is explicit that converting plan
  tasks to issues is the lossy step to avoid.

## 5. Boundary documented in README

A short new README section routes a reader with plan-shaped work directly to
`superpowers:subagent-driven-development`, names the review-gate gap this doc identifies, and
points at this file and the follow-up issue rather than re-deriving the analysis.

## 6. Follow-up

Filed as a follow-up issue (linked from the PR that lands this doc) proposing `gate-plan-branch`
per §4.1, so a future implementation session has the interface settled without repeating this
analysis. Implementing it is explicitly out of scope for #218's own acceptance criteria.
