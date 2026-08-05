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
