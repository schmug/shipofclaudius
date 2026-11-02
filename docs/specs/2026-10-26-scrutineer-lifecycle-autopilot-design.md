# Scrutineer Lifecycle Autopilot — Design Spec

**Date:** 2026-10-26
**Repo:** `schmug/shipofclaudius`
**Status:** Draft for Schmug's approval. No code until approved; the next step is
`superpowers:writing-plans`.

---

## 0. Intent

Scrutineer (`alpha-omega-security/scrutineer`, running locally at `http://localhost:8081`)
finds vulnerabilities in Schmug's repos and automates the first steps of each finding's
lifecycle (revalidate, critic, verify). Every step after that is a manual click in the UI.
On Schmug's own repos those clicks are mechanical: Schmug is the maintainer, so the
upstream-disclosure half of the lifecycle collapses into "open a fix PR and merge it".
155 findings currently sit on Schmug's repos, 123 of them at `new` (§2.8).

The autopilot is a local scheduled task plus a shipofclaudius skill that moves those
findings from `new` to `published` through Scrutineer's HTTP API, opens and lands fix PRs,
and stops for Schmug only when a fix would break something or change behaviour. It also
decides how often to rescan each repo, from what a scan costs and how much model headroom
is left.

Success: findings on Schmug's repos reach `published` with a merged fix PR as the record,
without Schmug clicking anything, and without the autopilot ever spending into the
subscription limit Schmug needs for their own work.

## 1. Decided before this spec (Schmug confirmed each point)

Restated close to the original wording. Do not relitigate.

- **Scope.** Only repos under `github.com/schmug`. Everything else in Scrutineer is left
  untouched. Scrutineer itself is not Schmug's repo and must not be modified; the
  autopilot uses its API only.
- **Lifecycle.** (1) Verify the finding. (2) Mark it triaged when revalidate and verify
  agree. (3) Run patch and reattack. (4) Open a fix PR on the repo. (5) Merge it through
  the repo's required-CI gate. (6) Mark it fixed, then published.
- **No public issues and no GHSAs.** The fix PR is the record.
- **False-positive or uncertain verdicts are parked with a note, never auto-rejected.**
- **Stop and ask Schmug only** when a fix would break something or change functionality.
  The signal is the finding's `breaking_change` / `breaking_change_rationale` fields; when
  either flags it, leave the PR open and ping Schmug. (§2.3 shows this signal does not
  exist today; see open question Q1.)
- **Cadence tiers per repo:** every diff, every PR, every release, weekly, and so on. The
  tier is chosen from model spend: Scrutineer's per-scan `cost_usd` history is the cost
  proxy (API list price, not the real subscription charge); remaining headroom comes from
  `codexbar usage --format json`; a run starts only when its estimated cost fits the
  remaining headroom with a margin. `pause_on_overage` and per-run `max_cost_usd` stay as
  backstops.
- **Where it lives.** The code goes in shipofclaudius. A skill shim lets a Claude session
  that is securing code start the autopilot or check on it.
- **Open going in:** event tiers (diff, PR, release) need polling GitHub each tick or a
  hook. Resolved in §7.1.

**Answered by Schmug 2026-11-01** (the questions are recorded in §15):

- **Stop signal:** the autopilot's own behaviour check (§8 step 5) is the primary signal.
  `breaking_change` is honoured whenever Scrutineer has set it.
- **Deploy-on-merge repos and shipofclaudius:** open the fix and stop for Schmug's merge.
  Every other gated repo auto-merges.
- **Public disclosure window:** run the behaviour check before anything is pushed. A fix
  that will auto-merge gets a PR with a regression test. A stopped fix stays an unpushed
  local branch until Schmug answers.
- **Budget:** Scrutineer runs on Codex, so `codexbar --provider codex` gates scans and
  `--provider claude` gates the autopilot's own agents. Schmug: "we can use codexbar to
  proxy usage limits. we're using codex as a backend." There is **no dollar ceiling**; the
  codexbar usage limits are the backstop.
- **Medium/Low:** triage on verify `confirmed` plus a critic verdict. High/Critical still
  need revalidate and verify to agree.
- **Ping:** a push notification, plus a note on the Scrutineer finding.
- **Scrutineer upgrade:** done by Schmug on 2026-11-01 (§2.1).

## 2. Recon findings that shape the design

Observed 2026-10-26 against the running instance and the Scrutineer source at `d5158e3`.
Each one changes something below.

### 2.1 The running Scrutineer is older than its docs

`/opt/homebrew/bin/scrutineer` → Homebrew `2026.10.10.1`, started as
`scrutineer --backend codex --addr localhost:8081`.

- `GET /api/v1/findings/{id}` returns **405** on this build. The docs and `openapi.yaml`
  at `d5158e3` define it.
- `GET /api/v1/findings` (JSONL) works, but its rows carry **none** of the fields the
  autopilot needs to read state: `last_revalidate_verdict`, `production_viability`,
  `verification`, `remediation`, `suggested_fix`, `breaking_change`. `openapi.yaml`'s
  `FindingExport` (allOf `FindingDetail`) defines all of them.

**Update 2026-11-01:** Schmug upgraded to Homebrew `2026.10.24.1` (still
`--backend codex`). Observed on that build:

- `GET /api/v1/findings/{id}` returns 200 with `last_revalidate_verdict`,
  `production_viability`, `suggested_fix`, `suggested_fix_commit` and `breaking_change`.
- `verification` and `remediation` are **absent**, even on findings that have finished
  verify scans (ids 5, 14, 15, 25).
- The verify outcome is still readable from the operator surface:
  `GET /api/v1/scans?skill=verify&status=done` rows carry `finding_id` and a JSON
  `report` whose `status` is `confirmed`, `fixed`, `inconclusive`, and so on. 50 of 53 have
  a report.

So the autopilot reads verify and reattack outcomes from the **latest done scan of that
skill for that finding**. It parses `report.status` for verify, and `outcome`/`status`
per `skills/reattack/schema.json` for reattack. No reattack scan exists yet, so that
parse is written to the schema and is unverified.

**Consequence:** the autopilot requires a Scrutineer build whose `GET /api/v1/findings/{id}`
returns those fields. It feature-detects this on every tick and does
nothing (reports "Scrutineer too old") when the fields are missing. It never falls back to
reading `scrutineer.db` directly or scraping HTML: both couple to internals Schmug does not
own.

### 2.2 Scans spend Codex, not Claude

The instance runs `--backend codex`. Of 726 scans, 456 ran on GPT models (`gpt-6-luna`
alone: 347). Three consequences:

- Headroom for **Scrutineer scans** must be read from `codexbar usage --provider codex`,
  not `--provider claude`. The autopilot's **own** agents (fix-PR builder, behaviour
  check, merge gate) run on Claude, so they are gated on `--provider claude`. The design
  uses two budgets, one per provider, and picks the scan provider from the running
  backend. See Q2.
- `openapi.yaml`: the `max_cost_usd` cap "does not apply to the codex backend, which
  emits no usage events." The per-run backstop is void on this instance.
- `docs/usage.md`: `pause_on_overage` acts "when Claude reports paid subscription
  overage". It is a Claude signal. On the codex backend it is not a backstop either.

### 2.3 `breaking_change` is never populated, and the autopilot cannot populate it

- 0 of 799 findings carry a `breaking_change` value.
- It is written only by the `breaking-change` skill (`internal/worker/skill_parsers.go:1365`).
  No worker path auto-enqueues that skill, and no operator or UI route runs it: the UI's
  finding routes (`server.go:607-622`) cover verify, critic, disclose, patch, reattack,
  public-issue and mitigate, and the generic `POST /repositories/{id}/skill-scan` takes no
  `finding_id`. The only route that takes a finding is
  `POST /api/findings/{id}/skills/{name}/run`, which needs a per-scan token from a
  running scan.
- The skill also answers a narrower question than the one Schmug asked. It judges
  whether a fix breaks the library's **top dependents' call sites**. Most of Schmug's
  repos are apps and sites with no dependents, where the real risk is behaviour change for
  users.

The decided stop signal therefore cannot work as stated. See Q1.

### 2.4 Medium and Low findings never get revalidated

Revalidate auto-runs only on new High/Critical findings and on imports. There is no
operator route to run it. "Mark triaged when revalidate and verify agree" can only be
evaluated for High/Critical. 114 of the 123 `new` findings are Medium or Low. See Q3.

### 2.5 How the UI POST routes behave

- Every finding action route enqueues a scan and answers **303** with `Location:
  /scans/{id}`. The autopilot reads the scan id from `Location` (no redirect following).
  A duplicate request while one is open redirects to the open scan instead of enqueueing.
- `POST /findings/{id}/status` writes any status in the enum with no transition graph.
  `ready` needs a disclosure draft, and `ready`/`reported` are refused on a `NON_VIABLE`
  finding; the autopilot uses neither.
- `POST /findings/{id}/reattack` pins the newest gated patch attempt and its base commit;
  it returns 412 when there is none.
- Bearer-token POSTs from loopback are documented but **not yet verified** (§11).

### 2.6 Scrutineer already has a per-repo clock

`POST /repositories/{id}/schedule` stores a cron in `scan_schedule`, and the scheduler
runs a diff-rescan group on it. It does not consult headroom. All 10 Schmug repos have
it unset today.

### 2.7 Required-CI gates per repo

Read from `gh api repos/schmug/<r>/rules/branches/main` on 2026-10-26:

| Scrutineer repo id | Repo | Visibility | Required checks |
|---|---|---|---|
| 286 | dungelo | private | test, e2e |
| 8 | dewpt | public | ci |
| 1 | dmarc.mx | public | check, provenance |
| 3 | shipofclaudius | public | test (Node 20), test (Node 22) |
| 2 | donthype-me | private | Test, Viewport Tests, Lint, Build, Deploy to Staging |
| 4 | phishsoc | public | **none** |
| 6 | clodcast | public | lint-and-test (3.10/3.11/3.12) |
| 5 | cortech.online | public | **none** |
| 7 | doohub | public | pipeline, site |
| 15 | wormbench | public | checks |

The rulesets endpoint does not show classic branch protection, so "none" is unverified
for phishsoc and cortech.online. Per Schmug's global loop, the autopilot never merges in a
repo without a required-check gate. It opens the PR and reports the missing gate.

### 2.8 Current backlog and cost history

- Schmug-repo findings: 155 — `new` 123, `enriched` 15, `duplicate` 13, `triaged` 3,
  `acknowledged` 1. By severity among `new`: High 9, Medium 66, Low 48.
- Median `cost_usd` per completed scan: security-deep-dive $3.14 (max $79.17), verify
  $0.21, revalidate $0.41, patch $0.57 (n=2), reattack: no history. These are list-price
  estimates.

### 2.9 Prior art (`~/librarian`)

- `wiki/sources/1password-frontier-models-vulnerability-patches-flawed.md` and
  `wiki/concepts/LLM patch failure modes.md`: about 26% of frontier-model security patches
  fully mitigate with no side effects. About half leave an exploit path, and about 1 in 4
  introduce a new bug. Behaviour drift is a named failure mode. This is why §8 keeps
  four independent gates in front of an unattended merge, and why the behaviour check in
  §9 exists at all.
- `wiki/sources/blog.cloudflare.com-vulnerability-discovery-remediation.md`: a comparable
  pipeline that proposes patches but never applies them. The autopilot goes further than
  that by merging, which is why §9 fails closed.
- Nothing in the vault covers headroom-gated scheduling or `codexbar`.

## 3. Goals, non-goals, anti-goals

**Goals**
- Drive each Schmug-repo finding along §6's state machine through Scrutineer's API.
- Open a fix PR for each confirmed finding and land it through the repo's required checks.
- Choose each repo's scan tier from cost history and live headroom, and start nothing that
  does not fit.
- Report what it did and what it parked, and let a Claude session start it, pause it, or
  check on it.

**Non-goals**
- Anything outside `github.com/schmug/*`.
- Changing Scrutineer. Gaps in its API are worked around, or filed upstream only with
  Schmug's approval (Q1).
- Public issues, GHSAs, CVEs, PVR reports, disclosure drafts.
- Auto-rejecting a finding, or marking it `duplicate`.
- Webhooks or anything exposed beyond loopback.

**Anti-goals** (a failure even if everything else works)
- Spending into the subscription limit Schmug needs for their own sessions.
- Merging a fix that changes user-visible behaviour, or merging without a required-check
  gate.
- Touching a finding or repo it does not own, or the Scrutineer instance's settings.
- Leaving exploit detail in a public PR before it merges.
- Silent failure. Every park, skip and refusal leaves a note on the finding and a line in
  the run report.

## 4. Relationship to the existing finding workflows

The autopilot stays **separate** from `triage-finding`, `fix-finding` and
`track-findings`, and drives only `merge-pr-with-gate`.

| Workflow | Use? | Why |
|---|---|---|
| `triage-finding` | No | It is a disprove-first triage of external findings. Scrutineer's revalidate + verify + critic already does that job for these findings, and the decided rule keys triage on Scrutineer's own verdicts. A second triage would cost tokens and add a third verdict to reconcile. |
| `fix-finding` | No | It writes its own TDD fix and draft PR. The decided lifecycle uses Scrutineer's patch + reattack, which is stronger evidence: reattack runs at least three root-cause variants plus a benign control against the exact diff. Running both would produce two competing fixes. `fix-finding`'s idea of an independent, different-model reviewer is reused in §8 step 5. |
| `track-findings` | No | It files GHSAs and issues. Decided: neither. |
| `merge-pr-with-gate` | **Yes** | Step 5 is exactly its job: re-verify `mergeStateStatus` plus the required-check rollup and squash-merge only when green. It is invoked as `workflow('shipofclaudius:merge-pr-with-gate', { pr, repo, execute: true })`. |

## 5. Architecture

Four parts. The split follows the repo's rule: model-free logic is a package with unit
tests, agent orchestration is a workflow with a sim, and process guidance is a
`workflow: none` skill.

```
~/.claude/scheduled-tasks/scrutineer-autopilot/SKILL.md   (local scheduled task, hourly)
        │  invokes skill
        ▼
skills/scrutineer-autopilot/SKILL.md     (process skill: tick | status | pause | resume | dry-run)
        │  1. runs the deterministic tick
        ▼
packages/scrutineer-autopilot/           (Node built-ins only, no model calls)
  client.mjs     Scrutineer HTTP (GET /api/v1/*, POST UI routes with bearer)
  github.mjs     gh-CLI polling for pushes / merged PRs / releases
  budget.mjs     codexbar reader, cost estimator, $→% calibration
  lifecycle.mjs  pure: finding snapshot → next action
  ledger.mjs     state file under ~/.claude/scrutineer-autopilot/
  tick.mjs       CLI: one tick, prints a JSON plan of agent work it could not do itself
        │  2. for each "needs agent" item in the plan
        ▼
.claude/workflows/scrutineer-fix-pr.js   (one finding: build fix PR → behaviour check → merge gate)
        └─ workflow('shipofclaudius:merge-pr-with-gate', …)
```

- **The tick does everything that needs no model:** polling, budgeting, enqueueing
  Scrutineer scans, reading verdicts, status writes, notes. It is safe to run with
  `--dry-run`, which prints the actions without POSTing.
- **The workflow does the three things that need a model:** writing the regression test
  and opening the PR, the behaviour check, and the merge gate.
- **Names.** The skill is `scrutineer-autopilot` and the workflow is `scrutineer-fix-pr`,
  so no skill shadows a workflow (`plugin-integrity` enforces this).
- **Public plugin.** No personal values are hard-coded. Owner, base URL, token path and
  repo allowlist come from `~/.claude/scrutineer-autopilot/config.json`. The owner
  defaults to `gh api user --jq .login`, the token path to `~/scrutineer/data/operator-token`.
- **Scheduled task.** A Claude desktop local scheduled task, same shape as the existing
  `~/.claude/scheduled-tasks/dependabot-triage`, pointing at `PLUGIN-FALLBACK.md` for the
  `Unknown skill` failure. Local because Scrutineer is loopback-only. It runs hourly (my
  call); the tick exits early with a one-line report when there is nothing to do, so an
  idle hour costs one short session.
- **Fallback if the scheduled session cannot run write workflows unattended** (§16;
  verify first): the session launches one capped `claude -p` child per fix item in its
  own worktree, the pattern `implement-issue` uses. Its prompt runs `scrutineer-fix-pr`,
  under the same Claude budget gate. The tick and ledger are unchanged.

## 6. Lifecycle state machine

`lifecycle.mjs` maps a finding snapshot (`GET /api/v1/findings/{id}`) plus the ledger
entry to exactly one next action. In scope: findings whose repository is in the
allowlist and whose status is not `rejected`, `duplicate` or `published`. Severity scope
depends on Q3.

| Current state | Condition | Action |
|---|---|---|
| `new`/`enriched` | no open finding scan, no `verification` | `POST /findings/{id}/verify` (budget-gated) |
| `new`/`enriched` | verify or revalidate still running | wait |
| `new`/`enriched`, High/Critical | `last_revalidate_verdict=true_positive` and verify `confirmed` | `status=triaged`, note "autopilot: revalidate and verify agree" |
| `new`/`enriched`, Medium/Low | verify `confirmed` and a critic verdict (run critic first if empty) | `status=triaged`, note "autopilot: verify confirmed; no revalidate for this severity" |
| `new`/`enriched` | either verdict is `false_positive`, `uncertain` or `inconclusive`, or they disagree | **park** with a note quoting both verdicts |
| `new`/`enriched` | `already_fixed` or verification `fixed` | **park** with note (my call: confirming already-fixed is cheap for Schmug and has no fix PR to record it) |
| any | `production_viability` is `NON_VIABLE` or `SAMPLE_OR_TEST` | **park** with note (my call: no release build is affected, so a fix PR is a judgement call) |
| `triaged` | `production_viability` empty (critic only auto-chains after revalidate, so Medium/Low have none) | `POST /findings/{id}/critic` first (my call: median cost $0.01) |
| any | `production_viability` is `CONDITIONAL_VIABLE` or `VIABLE` | proceed (my call) |
| `triaged` | no remediation attempt | `POST /findings/{id}/patch` |
| `triaged` | latest attempt has no reattack | `POST /findings/{id}/reattack` |
| `triaged` | reattack `verified_secure` | hand to `scrutineer-fix-pr` |
| `triaged` | reattack `bypassed_patch` | re-run patch (Scrutineer stages the bypass for the next attempt), at most 2 patch attempts per finding (my call), then **park** |
| `triaged` | reattack `verification_incomplete` | re-run reattack once, then **park** |
| `triaged` + PR open | `scrutineer-fix-pr` returned `stopped` | wait for Schmug; re-check the PR each tick |
| `triaged` + PR merged | merge commit on default branch | `status=fixed`, note with PR URL and merge SHA |
| `fixed` | set by autopilot | `status=published`, note "fix PR is the record; no advisory" |
| `acknowledged` | existing, set by hand | left alone (my call: Schmug set it manually) |

**Parking.** The ledger marks the finding `parked` with a reason, and the autopilot posts
one note via `POST /findings/{id}/notes`. It does not touch the finding again until its
`updated_at` moves past the park time, which means a human or Scrutineer acted on it.

**Idempotency.** Before any enqueue, the tick checks the ledger and the finding's open
scans. Scrutineer also deduplicates open finding scans (§2.5). The fix-PR branch is
deterministic (`scrutineer/finding-<id>`) and the workflow checks for an open PR on it
first, like `fix-finding`'s preflight.

## 7. Cadence and budget

### 7.1 Event tiers by polling (resolves the open design point)

Each tick polls GitHub with `gh api` for each allowlisted repo since the last tick:
default-branch head SHA (diff tier), merged PRs (PR tier), and releases (release tier).
Hooks were rejected: a GitHub webhook or Action cannot reach a loopback-only Scrutineer
without exposing it, which is a non-goal. With hourly ticks, an event is picked up within
an hour, which is fast enough for a security rescan. The cost is about 3 REST calls per
repo per tick: 30 per hour for 10 repos, well inside the 5,000/hour authenticated limit.

A PR the autopilot merged itself does not trigger a rescan of that repo; that diff is the
autopilot's own fix.

### 7.2 What each tier runs

| Tier | Trigger | Scrutineer call |
|---|---|---|
| `diff` | default-branch head moved | `POST /repositories/{id}/scan` `rescan_mode=diff` |
| `pr` | ≥1 PR merged since last scan | same diff rescan, at most one per tick |
| `release` | new release published | same diff rescan, baseline = last scanned release |
| `weekly` / `monthly` | clock, only if the head moved since the last scan | same diff rescan |
| `full` | Scrutineer version changed, or 90 days since the last full scan (my call) | `POST /repositories/{id}/scan` (full deep-dive) |

Per `docs/diff-based-rescans.md`, diff rescans are for "the project changed" and full
scans for "Scrutineer changed". Scrutineer's own `scan_schedule` is left **off** on
autopilot repos, so every scan passes one budget gate. The tick refuses to run on a repo
whose `scan_schedule` is set, and reports it.

### 7.3 Cost estimate per run

`est(repo, kind)` is the p75 of `cost_usd` over that repo's last 10 completed groups of
that kind (diff group or full). Fallbacks: the instance-wide p75 for that kind, then a
fixed default ($5 diff, $15 full). Finding-step estimates (verify, patch, reattack) use the
instance-wide p75 per skill. p75 and the fallbacks are my call.

### 7.4 Headroom and the $→% conversion

`codexbar` reports `usedPercent` per window (5-hour `primary`, weekly `secondary`), not
dollars. To compare a dollar estimate with a percentage, the ledger records
`(weekly usedPercent, Σ cost_usd of scans finished since the last tick)` every tick and
fits `pct_per_dollar` over a trailing 14 days. Until there are 20 samples it uses a
deliberately pessimistic seed (my call: 1 percentage point per $2 list price), so early
runs under-spend rather than over-spend.

A run may start only when **both** hold, for the provider that will pay for it:

```
weekly_used + est_pct(run) + margin ≤ 100 − reserve      (margin 5, reserve 30)
primary_used + est_pct(run) ≤ 80
```

`reserve` keeps 30% of the weekly window for Schmug's own work. The numbers are my call
and live in `config.json`. Agent work in `scrutineer-fix-pr` is gated the same way
against `--provider claude`, with a fixed $3 estimate per finding until there is history.

If `codexbar` fails or returns stale data (`updatedAt` older than 30 minutes), the tick
starts nothing. It fails closed.

### 7.5 Choosing a repo's tier

Each tick computes the projected weekly spend of each tier per repo:

```
weekly_cost(tier) = expected_runs_per_week(tier, repo) × est(repo, diff)
```

`expected_runs_per_week` comes from the repo's polled event history (pushes, merged PRs
and releases per week over the last 28 days). Repos are ranked by open High/Critical
findings, then by event rate. Walking that order, each repo gets the most frequent tier
(`diff` > `pr` > `release` > `weekly` > `monthly`) whose cumulative projected spend fits
`(100 − reserve − weekly_used) / pct_per_dollar` dollars for the rest of the week. Tiers
are recomputed every tick, so a repo drops to a slower tier as headroom shrinks and climbs
back after the weekly reset. Finding-lifecycle steps take priority over rescans: an open
finding is cheaper to finish than a new one is to find.

### 7.6 Backstops

- **Claude backend:** `pause_on_overage` (instance setting) and `max_cost_usd`. The UI
  finding routes do not accept `max_cost_usd`; only `POST /repositories/{id}/skill-scan`
  does. So the per-run cap applies only to repo-level skill scans enqueued that way.
- **Codex backend (current):** neither backstop applies (§2.2). Per Schmug, the codexbar
  usage limits are the backstop, and there is no dollar ceiling. Concretely:
  - the §7.4 gate, which fails closed on stale or failed codexbar output;
  - at most 1 scan group running at a time;
  - at most 10 enqueues per tick (my call).

## 8. Building and landing the fix PR (`scrutineer-fix-pr`)

One finding per run. Input: the finding id and the repo. The workflow reads the finding
and the patch itself through a read-only relay; it never receives them as caller text.

1. **Preflight (read-only).** Skip if `scrutineer/finding-<id>` already has an open PR, or
   if the repo is not in the allowlist.
2. **Apply.** A worktree-isolated write agent clones the repo, branches from the current
   default branch, and applies `suggested_fix` with `git apply --3way`. If the diff no
   longer applies, the run stops; the tick re-runs `patch` once against a fresh scan,
   then parks the finding.
3. **Regression test.** The agent adds a test that fails on the default branch and passes
   with the diff, touching only test files. The workflow
   checks with `git diff --name-only` that the Scrutineer diff's non-test hunks are
   unchanged, because reattack verified that exact diff.
4. **Local gates.** Run the repo's test/lint/build commands. A red gate stops the run with
   the PR left in draft.
5. **Behaviour check.** A read-only agent on a **Claude** model (my call: the patch was
   written by Scrutineer's GPT backend, so a Claude reviewer is already independent of
   its author; on a Claude backend, use a different Claude family from the patch scan's
   `model`), paid from the Claude budget. It returns `behaviour_change: none | changed | unknown` with
   evidence. Details in §9.
   Steps 2–5 run in a local clone and **nothing is pushed before step 5 returns**. If §9
   would stop the fix, the branch stays unpushed under
   `~/.claude/scrutineer-autopilot/held/<finding-id>/`. Schmug gets the ping, and pushing
   or discarding it is Schmug's call (the skill's `status` lists held fixes).
6. **Push and open the PR** (only for fixes §9 clears). Title `fix(security): <one-line class> in <file>`. The body names the
   class, the file, the Scrutineer finding id, reattack `verified_secure`, and the test
   output. It carries **no** attacker story, payload or PoC, because 8 of 10 repos are
   public and the PR is visible before it merges.
7. **Merge.** If §9 clears it and the repo has required checks:
   `workflow('shipofclaudius:merge-pr-with-gate', { pr, repo, execute: true })`. That
   workflow has no `pending` outcome: CI_PENDING, BEHIND and DIRTY all come back as
   `ESCALATED`. The fix workflow reads the escalation reason (my call):
   - CI_PENDING: not a stop. The ledger marks the PR `awaiting_ci`, and each tick emits a
     separate **re-gate** item that calls `merge-pr-with-gate` again (step 1's preflight
     skip does not apply to re-gate items). It never polls.
   - BEHIND: `gh pr update-branch` (a merge commit, never a force-push), then re-gate.
   - DIRTY: re-apply `suggested_fix` onto the current default branch once, then stop.
   - A red required check or a blocking review: stop (§9).

   **At most one open fix PR per repo** (my call). Further triaged findings in that repo
   wait, so merges do not keep knocking each other BEHIND.
8. **Return** `{ outcome: merged | pending | stopped | failed, pr_url, merge_sha, reason }`.
   The tick then writes `fixed` and `published` (§6).

Hard rules in the write agent's prompt, copied from `fix-finding` and `stacked-impl-lanes`:
no push to the default branch, no `--admin`, no `--no-verify`, no CI polling, and a
per-finding scratch path under `${TMPDIR:-/tmp}/scrutineer-autopilot/<finding-id>/`.

## 9. When to stop and ask

The fix is held, unmerged (unpushed if the stop is known before step 6, as in rules 1, 2
and 5), and Schmug is pinged when **any** of these hold:

1. `breaking_change` is `breaking` or `unknown`, or `breaking_change_rationale` names an
   affected dependent, whenever Scrutineer has populated it. Today it never is (§2.3).
2. The §8 step-5 behaviour check returns `changed` or `unknown`. The check compares the
   diff against the repo's tests, routes, public exports and user-facing strings, and
   answers one question: "would a user or caller see a difference other than the
   vulnerable input being refused?"
3. The repo has no required-check gate (phishsoc and cortech.online today).
4. `merge-pr-with-gate` escalates with a red required check, a blocking review, or DIRTY
   after one re-apply (§8 step 7).
5. The repo's `merge_policy` in `config.json` is `stop`. Per Schmug, that is every repo
   that deploys on merge, plus shipofclaudius. The starting list is donthype-me, dmarc.mx,
   cortech.online, doohub and shipofclaudius. The builder confirms each by reading the
   repo's `.github/workflows/`, and reports any other repo whose default-branch push runs
   a deploy job. Allowed values: `auto | stop | exclude`.

   For a `stop` repo the fix is pushed and opened as a PR **without** the merge call,
   because Schmug merges it. On a public `stop` repo this re-opens the disclosure window
   Schmug chose to close for stopped fixes, so the default for public `stop` repos is to
   hold the fix unpushed, as for rules 1 and 2 (my call). The ping says so.

**The ping.** A push notification from the scheduled session (the `PushNotification`
tool), with the repo, the finding id, the rule that fired, and the PR URL or held-branch
path. The autopilot also adds a note on the Scrutineer finding. It is a push rather than a
PR comment because GitHub does not notify you of your own @-mention under your token. The
ledger records the finding as `stopped`. The tick only re-checks whether Schmug pushed,
merged or closed it. A closed, unmerged PR, or a deleted held branch, parks the finding.
Each stopped finding is notified once, plus a daily digest of everything still waiting
(my call).

## 10. State

`~/.claude/scrutineer-autopilot/` (outside every repo, like the vent sink):

- `config.json`: allowlist, base URL, token path, budget numbers, tier overrides.
- `ledger.json`: per finding (stage, attempts, PR, park reason, timestamps), per repo
  (last polled SHA/PR/release, tier, last scan group), and budget samples. Written
  atomically (temp file + rename). A lock file stops two ticks from overlapping.
- `runs/<timestamp>.json`: each tick's plan and outcome. The `status` subcommand reads the
  last few.
- `paused`: if this file exists, the tick reads and reports but writes nothing.

## 11. Security

- **Operator token.** It is read from the token file at call time and sent only to the
  configured loopback base URL. `client.mjs` refuses a non-loopback host (127.0.0.1,
  localhost or ::1), as the specificity mod's `isLoopback` does. The token is never
  logged and never passed into an agent prompt. Agents that need Scrutineer data get it
  through the tick or a read-only relay.
- **Untrusted text.** Finding titles, descriptions, `validation`, `suggested_fix` and
  breaking-change rationale were model-written from attacker-reachable source. Every agent
  sees them inside the repo's three-part defense: a read-only relay, a nonce fence, and the
  anti-injection preamble (CLAUDE.md "Prompt-injection hardening"). `scrutineer-fix-pr`
  becomes the seventh write workflow and is documented as such in README "Security model".
- **Scope check at every write.** Before any POST, the tick re-reads the finding and
  checks that its `repository_id` maps to an allowlisted `github.com/<owner>/` URL. This
  is what keeps the autopilot off non-Schmug repos even if the ledger is wrong.
- **Unverified prerequisite.** Bearer-token POSTs to the UI routes from loopback are
  documented in `docs/api.md` but have not been tried. Plan step 1 is to verify this on
  one harmless call (`POST /findings/{id}/notes` on a Schmug finding) before building on
  it. If it fails, the design needs Q1's upstream route, or a cookie session.

## 12. Skill shim (`skills/scrutineer-autopilot/SKILL.md`, `workflow: none`)

Triggers: "secure this repo with Scrutineer", "what is the autopilot doing", "pause the
autopilot". Subcommands:

- `status`: last runs, per-repo tier, findings by autopilot stage, parked findings with
  reasons, open stopped PRs, budget left per provider.
- `tick` / `dry-run`: run one tick now, or print what a tick would do.
- `pause` / `resume`: create or remove the `paused` file.
- `install`: write the scheduled task and `config.json` after showing them to Schmug.
  Creating a scheduled task is persistent configuration, so it asks first.

A session securing a repo uses `status` to see whether a finding is already moving
before it starts its own fix. That stops a session and the autopilot from opening
duplicate PRs.

## 13. Testing

- `packages/scrutineer-autopilot`: unit suites in the `factory-gate` style, Node
  built-ins only. They cover every §6 row, the budget gate (stale codexbar, both
  providers, calibration seed), tier choice, the loopback refusal, ledger atomicity, and
  `Location` parsing. A stub HTTP server built on `node:http` stands in for Scrutineer.
- `.claude/workflows/scrutineer-fix-pr.js`: a sim in `tests/` that asserts the fence
  shapes, the `merge-pr-with-gate` qualified name, the different-model rule, and that a
  `changed`/`unknown` behaviour verdict or a missing gate never reaches the merge call.
- Every new suite is appended to the `package.json` test chain.
- End-to-end acceptance is a `dry-run` against the real instance, then one real finding
  walked from `new` to `published` on a low-risk repo Schmug picks. That needs the §2.1
  Scrutineer upgrade first.

## 14. Calls made in this spec (check while reading)

- Spec path `docs/specs/` (the repo's convention) instead of `docs/superpowers/specs/`.
- Autopilot drives only `merge-pr-with-gate`, not triage/fix/track-findings (§4).
- Package + workflow + process skill split; names `scrutineer-autopilot` /
  `scrutineer-fix-pr` (§5).
- Hourly Claude desktop scheduled task (§5); event tiers by polling, not hooks (§7.1).
- Park, rather than auto-handle, `already_fixed`, `NON_VIABLE`, `SAMPLE_OR_TEST`, and
  manually `acknowledged` findings (§6).
- 2 patch attempts and 1 reattack retry before parking (§6).
- Scrutineer's own `scan_schedule` stays off on autopilot repos (§7.2).
- Budget numbers: p75 estimates, $5/$15 fallbacks, 30% reserve, 5-point margin, 80% cap
  on the 5-hour window, a seed of 1 point per $2, and 10 enqueues per tick (§7).
- Public `stop` repos hold the fix unpushed; ping once per stop plus a daily digest (§9).
- Verify and reattack outcomes are read from scan reports, because the export omits them
  (§2.1).
- Full rescan every 90 days or on a Scrutineer version change (§7.2).
- Ping as a PR comment (§9). No exploit detail in PR bodies (§8).
- Run critic when `production_viability` is empty; proceed on `CONDITIONAL_VIABLE` (§6).
- Merge-gate escalations: CI_PENDING → re-gate next tick; BEHIND → `update-branch`;
  one open fix PR per repo (§8).
- Behaviour check runs on Claude, independent of the GPT patch author (§8).
- `claude -p` child fallback if scheduled sessions cannot run write workflows (§5).
- Never read `scrutineer.db` or scrape HTML; refuse to run on a build without the
  `FindingExport` fields (§2.1).

## 15. Open questions for Schmug

**All answered 2026-11-01. The answers are in §1, and the questions are kept for the
record.**

- **Q1. Stop signal.** `breaking_change` is never set, and the autopilot cannot trigger it
  (§2.3). Recommended: the §8 step-5 behaviour check is the primary signal, and
  `breaking_change` is honoured whenever it is present. Alternative: ask upstream for an
  operator route, or for patch to auto-chain breaking-change. That needs approval to file
  on a repo Schmug does not own.
- **Q2. Repos that deploy on merge, and guardrail code.** Some repos deploy on merge
  (donthype-me's gate includes "Deploy to Staging"; the site repos probably deploy from
  `main`). shipofclaudius holds the merge gate and the autopilot itself. Global CLAUDE.md
  says production deploys and guardrail changes need approval. Each repo gets a policy:
  auto-merge, always stop, or excluded.
- **Q3. Public disclosure window + regression test (old Q4).** On a public repo the diff,
  the title, and especially a test that fails on `main` are a working pointer to the bug
  while the PR is open. A stopped PR can stay open for days. Options:
  - (a) accept it;
  - (b) run the behaviour check before opening anything, and hold stopped fixes as an
    unpushed local branch until Schmug answers;
  - (c) no regression test on public repos.

  Separately: does the test-first rule apply to these PRs at all, given that reattack
  already verified the exact diff?
- **Q4. Which provider pays, and the backstops.** Scans currently run on Codex (§2.2), so
  `--provider claude` does not measure their spend. On codex, `max_cost_usd` and
  `pause_on_overage` do nothing. Confirm two budgets (codex for scans, claude for the
  autopilot's agents) and the $150/week hard ceiling as the backstop.
- **Q5. Medium/Low scope.** These findings get no revalidate (§2.4). Options:
  - (a) triage on verify `confirmed` alone;
  - (b) High/Critical only;
  - (c) import Medium/Low to trigger revalidate (rejected: it creates duplicates).

  114 of the 123 `new` findings are Medium or Low.
- **Q6. Ping channel.** PRs and comments go out under Schmug's `gh` token, and GitHub
  does not notify you of your own @-mention, so a PR-comment ping is silent. Options: a
  `/issue` decision brief (the global unattended rule), a push notification, or a bot
  identity.
- **Q7. Scrutineer upgrade.** `GET /api/v1/findings/{id}` landed after the installed
  `2026.10.10.1` (tag `v2026.10.24.1` exists, but Homebrew stable has not reached it).
  The options are to wait for the formula, `brew install --HEAD`, or build from
  `~/scrutineer`. Until then the plan builds offline against a stub server.

## 16. Verified vs unverified

**Observed 2026-10-26:** everything in §2, apart from the classic-branch-protection caveat
in §2.7.

**Not verified; the plan must check these before building on them:** bearer POSTs to UI
routes (§11); the reattack report parse (§2.1, no reattack scan exists yet); whether
`PushNotification` is available in a scheduled session (§9); `codexbar`'s codex `secondary` window (§7.4:
the codex output showed `pace.secondary` but its `usage` block was truncated in recon);
and whether a Claude desktop scheduled task can run a Workflow with write agents
unattended.
