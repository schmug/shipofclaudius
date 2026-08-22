# Factory adoption kit

Copy-and-fill templates for a repo adopting the software factory. Nothing here runs in
`shipofclaudius` itself — GitHub only executes workflows under `.github/workflows/`, so
`factory.yml` sitting here is inert by design.

The contract these implement is [`docs/specs/2026-08-05-software-factory-design.md`](../../docs/specs/2026-08-05-software-factory-design.md).

| Template | Copy to | What it is |
|---|---|---|
| [`factory.yml`](factory.yml) | `.github/workflows/factory.yml` | The scheduler + driver + gated landing job (spec §9). Three values to fill in, marked in the header. |
| [`gate.example.json`](gate.example.json) | `.factory/gate.json` | The repo's gate config (spec §12.7). **Strip the `//` keys** — the gate reports unknown keys as warnings. |
| [`setup-labels.sh`](setup-labels.sh) | `.factory/setup-labels.sh` | Creates the label state machine (spec §5). Idempotent; run once. |

## Adoption order

1. **`setup-labels.sh`** — the state machine has to exist before anything can advance through it.
2. **`gate.json`** — start restrictive. `allowlistAuthors: []` means nobody is trusted and every PR
   escalates; that is the correct starting position, not a misconfiguration. Mirror your CODEOWNERS
   into `riskPathDenylist`: anything a code owner must approve is something the gate should refuse
   to land unattended.
3. **An issue template with a required scope field.** The gate's two most common escalation causes
   are a missing ` ```scope ` block and an unresolvable `Closes #N`, and neither has a form
   eliciting it by default. Without this, `no_scope_drift` fails on essentially every PR.
4. **`factory.yml`** — last, once the three above exist. Run it with `workflow_dispatch` and
   `stop_after: reproduce` first: that exercises the whole driver path while the write ladder can
   still only produce a read-only verdict.

## Before you trust it

- **`requireFixtureEvidence` stays `false`** until the repo's reproduction harness has a track
  record. Enabled without one it fails every PR.
- **The factory needs a revert path.** A gate that can land changes unattended, in a repo where a
  bad deploy cannot be rolled back from GitHub, is not a factory — it is an unattended production
  writer. Sort the rollback lever before raising `allowlistAuthors` off empty.
- **A coverage floor makes `ci_green` mean something.** Without per-file coverage thresholds on the
  code the factory is allowed to touch, an agent can delete a branch of logic and CI stays green.
- **The write token must be a distinct identity from the code owner.** GitHub forbids
  self-approval, so a token acting as the code owner can never satisfy a CODEOWNERS requirement.

## The two human-only labels

`fix-verified` is the trust token — the only thing that unlocks the merge gate. Apply it only after
reviewing the draft PR and its preview. `pipeline-paused` is the kill switch: apply it to any open
issue and the whole factory halts on its next run, no PR or redeploy required.

## Arming ladder — from human-gated to machine-gated

Removing the human is **not one flag**. `fix-verified` is simultaneously gate condition 2 (a
required label) and the land job's clock (`pull_request_target: [labeled]`), so turning on machine
verification without also replacing the trigger produces a factory that never lands anything, and
dropping the label requirement without machine evidence removes the check entirely rather than
replacing it.

Climb these in order. **Each rung has a precondition, and each is independently revertable.** Stop
at any rung — every one of them is a valid resting posture, and rung 0 is the default.

| # | Change | Precondition | Revert |
|---|---|---|---|
| 0 | *(default)* human applies `fix-verified`; gate requires it | — | — |
| 1 | The evidence producer runs | A repo fixture harness exists and the `fixture-evidence` job's two FILL-IN commands are filled in | Delete the job; nothing consumes its artifact |
| 2 | `requireFixtureEvidence: true` | Rung 1 green on real PRs — check the artifact is produced and `redOnBase` is actually `true` | Set back to `false`; condition 9 auto-passes again |
| 3 | Drop `fix-verified` from `requiredLabels` | Rung 2 has a track record. **This is the rung that removes the human judgement**, so it should sit the longest | Put the label back in `requiredLabels` |
| 4 | `FACTORY_AUTO_LAND=true` (repo variable) | Rung 3 stable. Enables the `land-sweep` job | Unset the variable; the sweep stops firing |

**Rung 3 is the load-bearing one.** Rungs 1, 2 and 4 are plumbing; rung 3 is the moment nothing
human is required for a merge. Do not climb 3 and 4 in the same change — if something lands that
should not have, you want to know which rung did it.

**Why the sweep is a cron, not a push trigger.** `land-sweep` runs on `schedule` /
`workflow_dispatch` only. A `check_suite: completed` trigger would let a PR author choose when a
write-privileged workflow fires; dispatching from `advance` would couple the writer to the lander.
A cron is reachable by nobody, and selection is by `fix-proposed` — a label the factory's own
privileged job applies, which a PR author has no permission to set.

**What the sweep will not do.** It never readies a draft (the write ladder still ends at a draft;
readying is the human's approval in the labelled path, so the sweep skips drafts entirely), never
passes `--admin`, never deletes a branch, and never checks out PR-authored code. `pipeline-paused`
halts it exactly as it halts everything else.
