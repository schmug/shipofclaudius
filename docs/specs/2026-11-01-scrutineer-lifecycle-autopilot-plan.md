# Scrutineer Lifecycle Autopilot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A local scheduled task and a shipofclaudius process skill that move Scrutineer
findings on Schmug's repos from `new` to `published` through Scrutineer's HTTP API. They
open and land fix PRs, and choose each repo's rescan tier from codexbar headroom.

**Architecture:** A model-free Node package (`packages/scrutineer-autopilot/`) does one
"tick": poll, budget, read verdicts, enqueue Scrutineer scans, write statuses and notes. It
prints the agent work it cannot do as a JSON plan. A new write workflow,
`scrutineer-fix-pr`, does that agent work for one finding: build the fix and regression test,
run the behaviour check, push or hold, then call `merge-pr-with-gate`. A `workflow: none` skill
(`scrutineer-autopilot`) runs the tick, dispatches the workflow, and offers
status/pause/install. The scheduled task invokes that skill hourly.

**Tech Stack:** Node ≥ 20 built-ins only (`node:fs/promises`, `node:child_process`,
`node:http`, `node:assert/strict`), the `gh` CLI, `codexbar` CLI, and Claude Code Workflow
runtime globals.

**Spec:** `docs/specs/2026-10-26-scrutineer-lifecycle-autopilot-design.md`. Read §1 (decided
and answered), §2 (observed API facts), §6, §7, §8 and §9 before any task.

## Global Constraints

- Zero npm dependencies and no lockfile; tests use only Node built-ins (CLAUDE.md "Commands").
- Every new suite is appended to the `&&` chain in `package.json` `test`, before
  `plugin-integrity.test.mjs`.
- `npm test` must end `0 failing`. The count only goes up: compare against a base-commit run.
  Never pin a total in README or CLAUDE.md.
- No personal values in shipped files: no `schmug`, no `/Users/cory`, no `8081`. These come
  from `~/.claude/scrutineer-autopilot/config.json`. Owner defaults to
  `gh api user --jq .login`.
- The Scrutineer base URL host must be `127.0.0.1`, `localhost` or `::1`; anything else is
  refused.
- The operator token is read from its file at call time. It is never logged, never written to
  the ledger or run files, and never placed in an agent prompt.
- Never read `scrutineer.db` and never scrape HTML. If `GET /api/v1/findings/{id}` lacks
  `last_revalidate_verdict`, `production_viability`, `suggested_fix` or `breaking_change`, the
  tick reports `scrutineer-too-old` and writes nothing.
- Fail closed: stale or failed codexbar output (older than 30 minutes) starts nothing.
- Budget numbers (spec §7): reserve 30, margin 5, primary-window cap 80, seed
  `pct_per_dollar = 0.5`, calibration after 20 samples over a trailing 14 days, cost estimates
  are p75 of the last 10, fallbacks $5 diff / $15 full, fix estimate $3 on Claude, at most 10
  enqueues per tick, at most 1 scan group running, full rescan every 90 days. No dollar
  ceiling.
- Retry limits (spec §6): at most 2 patch attempts per finding, and 1 reattack retry after
  `verification_incomplete`.
- At most one open fix PR per repo (spec §8).
- `merge_policy` values: `auto | stop | exclude`. The `stop` defaults are donthype-me,
  dmarc.mx, cortech.online, doohub and shipofclaudius.
- On a public repo, nothing is pushed for a fix that §9 stops (rules 1, 2 and 5). It stays held
  under `~/.claude/scrutineer-autopilot/held/<finding-id>/`.
- PR bodies carry no attacker story, payload or PoC.
- No public issues, no GHSAs, no `rejected` or `duplicate` writes.
- Conventional commit prefixes. End each commit with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Scrutineer down or token file missing:** the tick exits non-zero with one clear line,
   writes no ledger change, and leaves the lock released (Task 8).
2. **A human changes a finding between the tick's read and its write:** the tick re-reads
   right before every POST and skips if `status` or `updated_at` moved (Task 8).
3. **Repo URL case and suffix variance** (`https://github.com/Schmug/PhishSOC.git` vs
   `schmug/phishsoc`): allowlist matching is case-insensitive and strips `.git` and a trailing
   slash (Task 1).
4. **Overlapping ticks** (scheduled and manual): the second tick sees the lock and exits
   `locked` without touching anything. A lock older than 2 hours is stale and taken over
   (Task 6).
5. **Odd codexbar output** (an empty array, a missing `secondary` window, multiple sources, or
   a non-JSON error): fail closed with a reason (Task 4).

---

### Task 1: Prerequisite probe, package scaffold, config

Verifies the one unverified API claim everything else rests on, then lays down config.

**Files:**
- Create: `packages/scrutineer-autopilot/src/config.mjs`
- Create: `packages/scrutineer-autopilot/README.md` (one screen: what it is, the config
  keys, and the "agent-maintained" audience note)
- Test: `tests/scrutineer-autopilot-config.test.mjs`
- Modify: `package.json` (append the suite)
- Modify: `docs/specs/2026-10-26-scrutineer-lifecycle-autopilot-design.md` §11 and §16
  (record the probe result)

**Interfaces:**
- Produces:
  - `DEFAULTS`: a frozen object holding every Global Constraints number.
  - `normalizeConfig(raw: object, { owner: string }) -> Config`, where
    `Config = { owner, baseUrl, tokenPath, allowlist: string[] /* "owner/name" lowercase */,
    repoPolicy: Record<string, 'auto'|'stop'|'exclude'>, budget: {...DEFAULTS budget keys},
    stateDir }`. It throws on a non-loopback `baseUrl`.
  - `isLoopback(url: string) -> boolean`
  - `repoKey(url: string) -> string|null`: `"owner/name"` lowercased, from any GitHub URL
    form, or null when the URL is not GitHub.
  - `policyFor(config, key) -> 'auto'|'stop'|'exclude'`: unknown repos get `exclude`, and
    allowlisted repos default to `auto`.
  - `loadConfig(path = ~/.claude/scrutineer-autopilot/config.json, { exec }) -> Promise<Config>`

- [ ] **Step 1: Probe the bearer POST (manual, before any code).** Pick a Schmug-repo
  finding id from `GET /api/v1/findings?repository_id=<a schmug repo id>`. Run:

  ```bash
  curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' -X POST \
    -H "Authorization: Bearer $(cat <token-path>)" \
    --data-urlencode 'body=scrutineer-autopilot probe: bearer POST from loopback (safe to ignore)' \
    http://127.0.0.1:<port>/findings/<id>/notes
  ```

  Expected: `303 http://127.0.0.1:<port>/findings/<id>`. Record the observed code in spec §11
  and §16 with the date. **If it is not 303, stop the plan and report to Schmug**: spec §11
  says the design then needs a cookie session or an upstream route.

- [ ] **Step 2: Write the failing tests** in `tests/scrutineer-autopilot-config.test.mjs`,
  using the runner shape from `tests/factory-gate.test.mjs`:
  - `isLoopback`: true for `http://127.0.0.1:1`, `http://localhost:1` and `http://[::1]:1`;
    false for `http://127.0.0.2`, `http://localhost.evil.com` and `https://example.com`.
  - `normalizeConfig` throws `/loopback/` for `baseUrl: 'http://10.0.0.5:8080'`.
  - `repoKey`: `https://github.com/Schmug/PhishSOC.git` → `schmug/phishsoc`;
    `git@github.com:schmug/dewpt.git` → `schmug/dewpt`; `https://gitlab.com/a/b` → `null`.
  - `policyFor`: an allowlisted repo with no entry → `auto`; a repo not on the allowlist →
    `exclude`; `repoPolicy: { 'schmug/dmarc.mx': 'stop' }` → `stop`.
  - `normalizeConfig({}, { owner: 'o' }).budget` deep-equals the Global Constraints numbers.
  - No string literal `schmug` appears in `src/config.mjs`. The test reads the file and greps.
- [ ] **Step 3: Run it and confirm it fails.** Run `node tests/scrutineer-autopilot-config.test.mjs`.
  Expected: it fails with `Cannot find module`.
- [ ] **Step 4: Implement `src/config.mjs`.** `loadConfig` runs
  `exec('gh', ['api','user','--jq','.login'])` only when `owner` is absent. The `stop`
  defaults from Global Constraints are applied only for repos under the resolved owner.
- [ ] **Step 5: Run it and confirm it passes.** Expected: `all N passed`. Then append the
  suite to `package.json` and run `npm test` (expected: 0 failing).
- [ ] **Step 6: Commit.**
  `feat(scrutineer-autopilot): config, loopback guard, repo policy`

### Task 2: Scrutineer client

**Files:**
- Create: `packages/scrutineer-autopilot/src/client.mjs`
- Create: `tests/lib/stub-scrutineer.mjs` (a `node:http` stub server that records requests and
  serves fixtures)
- Test: `tests/scrutineer-autopilot-client.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: `isLoopback` (Task 1).
- Produces `createClient({ baseUrl, tokenPath, readFile = fs.readFile, fetch = globalThis.fetch }) -> Client`,
  with these methods:
  - `getFinding(id) -> Promise<Finding>`. It throws a `ScrutineerTooOld` error when any of
    the 4 required fields is absent.
  - `listFindings(query) -> Promise<Finding[]>`, `listScans(query) -> Promise<Scan[]>` and
    `listRepositories() -> Promise<Repo[]>`. All three parse JSONL.
  - `runFindingSkill(id, skill: 'verify'|'critic'|'patch'|'reattack') -> Promise<{ scanId: number|null, duplicate: boolean }>`.
    It reads `Location` from a 303 with `redirect: 'manual'`. `/scans/<n>` gives `scanId: n`.
    A 303 to `/findings/<id>` means a duplicate (the flash path).
  - `setStatus(id, status) -> Promise<void>`. It refuses `rejected`, `duplicate`, `ready` and
    `reported` locally, by throwing.
  - `addNote(id, body) -> Promise<void>`
  - `scanRepo(repoId, { mode: 'diff'|'full' }) -> Promise<void>`. `diff` sends
    `rescan_mode=diff`.
  - The error class `ScrutineerError(status, path)`.
- Every request sends `Authorization: Bearer <token>`. POSTs are
  `application/x-www-form-urlencoded`. Every request URL is checked with `isLoopback` before
  it is sent.

- [ ] **Step 1: Write the failing tests** against the stub:
  - `getFinding` on a fixture missing `breaking_change` rejects with `ScrutineerTooOld`.
  - `runFindingSkill(5,'verify')` → stub answers `303 Location: /scans/77` →
    `{ scanId: 77, duplicate: false }`. The stub saw `POST /findings/5/verify` with the bearer
    header.
  - `setStatus(5,'rejected')` throws, and the stub saw zero requests.
  - The token value never appears in any thrown error message. Make the stub return 500 and
    assert `!err.message.includes(token)`.
  - `listFindings` parses 3 JSONL lines into 3 objects and ignores a trailing blank line.
  - A token file that does not exist rejects with `/operator token/`.
- [ ] **Step 2: Run it and confirm it fails.** Run
  `node tests/scrutineer-autopilot-client.test.mjs` (expected: module not found).
- [ ] **Step 3: Implement `src/client.mjs`** and the stub `tests/lib/stub-scrutineer.mjs`.
  The stub exports `startStub(routes) -> { url, requests, close }`.
- [ ] **Step 4: Run it and confirm it passes.** Append the suite and run `npm test`.
- [ ] **Step 5: Commit.** `feat(scrutineer-autopilot): loopback Scrutineer client`

### Task 3: Verdict readers from scan reports

The operator export omits `verification` and `remediation` (spec §2.1). This task derives
them from scan reports, failing closed exactly as Scrutineer's
`internal/db/remediation.go:RemediationPatchStatus` does.

**Files:**
- Create: `packages/scrutineer-autopilot/src/reports.mjs`
- Test: `tests/scrutineer-autopilot-reports.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces:
  - `verifyOutcome(scans: Scan[], findingId) -> 'confirmed'|'fixed'|'inconclusive'|'deferred'|'not_attempted'|null`.
    It reads the newest `done` scan with `skill_name==='verify'` and that `finding_id`,
    parses `report` (a string or an object), and returns `report.status`. It returns null
    when there is no such scan or the report is unparseable.
  - `latestPatch(scans, findingId) -> { scanId, finishedAt } | null`: the newest `done` patch
    scan.
  - `patchAttemptCount(scans, findingId) -> number`: the count of `done` patch scans.
  - `reattackStatus(scans, findingId) -> 'verified_secure'|'bypassed_patch'|'verification_incomplete'|null`.
    It considers only done reattack scans created after `latestPatch(...).finishedAt`, and
    returns null when there are none. The rule, written out because tests alone do not fix
    it:

    ```js
    // any report with outcome 'bypassed_patch' or any variant outcome 'bypassed' → 'bypassed_patch' (sticky)
    // else newest report: outcome 'failed_to_bypass'
    //   && variants.filter(v => v.valid === true && v.outcome === 'blocked').length >= 3
    //   && benign_control.reached_sink === true && benign_control.crashed === false
    //   → 'verified_secure'
    // else → 'verification_incomplete'
    ```

- [ ] **Step 1: Write the failing tests**, one per branch of the rule above, plus these:
  - A verify report stored as a JSON string with `status:'confirmed'` → `'confirmed'`.
  - A reattack scan created *before* the latest patch scan is ignored → `null`.
  - An older report with a bypass and a newer clean one → `'bypassed_patch'`.
  - Clean, but only 2 blocked valid variants → `'verification_incomplete'`.
  - `benign_control.crashed === true` → `'verification_incomplete'`.
- [ ] **Step 2: Run it and confirm it fails** (expected: module not found).
- [ ] **Step 3: Implement `src/reports.mjs`.**
- [ ] **Step 4: Run it and confirm it passes.** Append the suite and run `npm test`.
- [ ] **Step 5: Commit.** `feat(scrutineer-autopilot): fail-closed verdict readers from scan reports`

### Task 4: Budget

**Files:**
- Create: `packages/scrutineer-autopilot/src/budget.mjs`
- Test: `tests/scrutineer-autopilot-budget.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces:
  - `readUsage(provider: 'codex'|'claude', { exec, now }) -> Promise<Usage>`, where
    `Usage = { ok: true, weeklyUsed: number, primaryUsed: number, updatedAt: string } | { ok: false, reason: string }`.
    It runs `codexbar usage --provider <p> --format json`. The output is an array, and it
    picks the first element whose `provider === p`. Claude reads `usage.secondary` and
    `usage.primary`. Codex reads `openaiDashboard.primaryLimit` as weekly, and `usage.primary`
    (if present) as the 5-hour window; check this against a live run in Step 1, because spec
    §16 lists the codex window as unverified. `ok:false` when `updatedAt` is older than 30
    minutes, a window is missing, or the output is not JSON.
  - `estimate(scans, { repoId, kind: 'diff'|'full'|'verify'|'critic'|'patch'|'reattack' }) -> number`:
    p75 of the last 10 positive `cost_usd` for that repo and kind, then instance-wide, then
    the fallback (diff 5, full 15; finding skills use the instance p75 or 1).
  - `calibrate(samples: {at, weeklyUsed, dollars}[], now) -> number`: `pct_per_dollar` fitted
    over 14 days. It returns the seed of 0.5 when there are fewer than 20 samples or the fit
    is ≤ 0.
  - `canStart(usage, estDollars, pctPerDollar, budget) -> { ok: boolean, reason: string }`,
    applying both spec §7.4 inequalities.
  - `diffGroupCost(scans, repoId) -> number[]`: sums the scans that share a `scan_group`. The
    scans export may lack `scan_group`; in that case it groups by repository and a 2-hour
    `created_at` window. Note this fallback in a code comment.
- `kind` mapping: diff and full are scan groups, the rest are single scans by `skill_name`.

- [ ] **Step 1: Capture real fixtures.** Run `codexbar usage --provider codex --format json`
  and `... --provider claude ...`. Save them as `tests/fixtures/codexbar-codex.json` and
  `codexbar-claude.json`, with the emails replaced by `user@example.com`.
- [ ] **Step 2: Write the failing tests:**
  - The real fixtures parse to `ok:true` with numeric windows when `now` is within 30 minutes
    of `updatedAt`.
  - The same fixture with `now` 31 minutes later → `ok:false`, `/stale/`.
  - `[]`, `'error: not signed in'`, and an array without the provider → `ok:false`.
  - `canStart({weeklyUsed:60, primaryUsed:10}, 4, 0.5, DEFAULTS)` → ok, because
    60 + 2 + 5 ≤ 70.
  - `canStart({weeklyUsed:64, ...}, 4, 0.5, ...)` → not ok (64 + 2 + 5 > 70).
  - `canStart({weeklyUsed:10, primaryUsed:79}, 4, 0.5, ...)` → not ok (79 + 2 > 80).
  - `calibrate` with 19 samples → 0.5. With 20 linear samples at 1%/$4 → 0.25 ± 0.01.
  - `estimate` with no history, `kind:'diff'` → 5.
- [ ] **Step 3: Run it and confirm it fails.**
- [ ] **Step 4: Implement `src/budget.mjs`.**
- [ ] **Step 5: Run it and confirm it passes.** Append the suite and run `npm test`.
- [ ] **Step 6: Commit.** `feat(scrutineer-autopilot): codexbar headroom gate and cost estimates`

### Task 5: Lifecycle state machine

**Files:**
- Create: `packages/scrutineer-autopilot/src/lifecycle.mjs`
- Test: `tests/scrutineer-autopilot-lifecycle.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: the Task 3 readers' return values (passed in, not called).
- Produces
  `nextAction(snap, entry, ctx) -> Action`, pure, with these inputs:
  - `snap = { finding, verify, reattack, patchAttempts, openScan: boolean }`
  - `entry`: the ledger entry, or `{}`
  - `ctx = { policy, repoHasOpenFixPr: boolean, prState: null|'OPEN'|'CLOSED'|'MERGED', heldBranchExists: boolean, now }`
  - `Action = { type, note?, reason? }`, where `type` is one of:
    `'verify'|'critic'|'triage'|'patch'|'reattack'|'fix'|'mark_fixed'|'mark_published'|'park'|'wait'|'skip'`
- It implements every row of spec §6, in table order. Rows that this task's tests pin:
  - High, `true_positive` + `confirmed` → `triage`, with the exact note
    `autopilot: revalidate and verify agree`.
  - Medium, `confirmed` + `production_viability:''` → `critic`. Then with `'VIABLE'` →
    `triage`, with the note `autopilot: verify confirmed; no revalidate for this severity`.
  - `false_positive`, `uncertain` or `inconclusive`, or disagreement → `park`, with a note
    containing both verdicts verbatim.
  - `NON_VIABLE` or `SAMPLE_OR_TEST` → `park`. `CONDITIONAL_VIABLE` proceeds.
  - `triaged` with `patchAttempts === 0` → `patch`. With a patch and `reattack === null` →
    `reattack`.
  - `verified_secure` and `!repoHasOpenFixPr` → `fix`. With `repoHasOpenFixPr` → `wait`.
  - `bypassed_patch` with `patchAttempts < 2` → `patch`. With `patchAttempts >= 2` → `park`.
  - `verification_incomplete` with `entry.reattackRetries` not set to 1 → `reattack`.
    Otherwise → `park`.
  - `entry.stage==='parked'` and `finding.updated_at <= entry.parkedAt` → `skip`.
  - `entry.stage` in `stopped|opened|awaiting_ci` with `prState==='MERGED'` → `mark_fixed`.
    With `prState==='CLOSED'` → `park` and the note
    `autopilot: fix PR closed unmerged`.
  - `entry.stage==='held'` and `!heldBranchExists` → `park` and the note
    `autopilot: held fix discarded`. A held fix that Schmug pushed and PR'd is picked up
    through `prState`.
  - `entry.stage==='merged'` → `mark_fixed`. `status==='fixed'` and `entry.stage==='marked_fixed'` → `mark_published`.
  - `status==='acknowledged'` without an autopilot entry → `skip`.
  - `openScan` → `wait`.
  - `policy==='exclude'` → `skip`.

- [ ] **Step 1: Write the failing tests:** one test per pinned row, named after the row.
- [ ] **Step 2: Run it and confirm it fails.**
- [ ] **Step 3: Implement `nextAction`** as an ordered list of `[predicate, action]` pairs, so
  the table order is the code order.
- [ ] **Step 4: Run it and confirm it passes.** Append the suite and run `npm test`.
- [ ] **Step 5: Commit.** `feat(scrutineer-autopilot): finding lifecycle state machine`

### Task 6: Ledger, lock, run log

**Files:**
- Create: `packages/scrutineer-autopilot/src/ledger.mjs`
- Test: `tests/scrutineer-autopilot-ledger.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces:
  - `openLedger(stateDir) -> Promise<Ledger>`, where
    `Ledger = { data: { findings: {}, repos: {}, budgetSamples: [] }, save(): Promise<void> }`.
    `save` writes `ledger.json.tmp` and then renames it. A missing file starts empty.
  - `acquireLock(stateDir, { now, staleMs = 2*3600e3 }) -> Promise<{ ok: true, release() } | { ok: false, reason: 'locked' }>`.
    It uses an `O_EXCL` create of `tick.lock` holding `{pid, at}`. A lock older than `staleMs`
    is replaced.
  - `isPaused(stateDir) -> Promise<boolean>`: true when the `paused` file exists.
  - `writeRun(stateDir, run: object, now) -> Promise<string>`: writes
    `runs/<ISO-with-colons-replaced>.json` and returns its path.
  - `recentRuns(stateDir, n) -> Promise<object[]>`
- Every test uses a `mkdtemp` directory, never `~/.claude`.

- [ ] **Step 1: Write the failing tests:**
  - A second `acquireLock` while the first is held → `{ok:false, reason:'locked'}`.
  - After `release()` → ok.
  - A lock file timestamped 3 hours ago → ok (stale takeover).
  - `save` then `openLedger` round-trips the data.
  - A crash simulated by leaving `ledger.json.tmp` behind does not corrupt `ledger.json`.
  - `writeRun` filenames contain no `:`.
- [ ] **Step 2: Run it and confirm it fails.**
- [ ] **Step 3: Implement `src/ledger.mjs`.**
- [ ] **Step 4: Run it and confirm it passes.** Append the suite and run `npm test`.
- [ ] **Step 5: Commit.** `feat(scrutineer-autopilot): atomic ledger, tick lock, run log`

### Task 7: GitHub polling and tier choice

**Files:**
- Create: `packages/scrutineer-autopilot/src/github.mjs`
- Create: `packages/scrutineer-autopilot/src/tiers.mjs`
- Test: `tests/scrutineer-autopilot-tiers.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces:
  - `pollRepo(key, since: { sha?, prMergedAt?, releaseAt? }, { exec }) -> Promise<RepoEvents>`,
    where
    `RepoEvents = { defaultBranch, visibility: 'public'|'private', headSha, pushed: boolean, mergedPrs: {number, mergedAt, headRef}[], releases: {tag, publishedAt}[] }`.
    It makes three `gh api` calls:
    - `repos/{key}` (read `.default_branch` and `.visibility`; treat `internal` as private),
      then `repos/{key}/commits/{branch}` with `--jq .sha`;
    - `repos/{key}/pulls?state=closed&sort=updated&direction=desc&per_page=20`;
    - `repos/{key}/releases?per_page=5`.

    PRs whose `headRef` starts with `scrutineer/finding-` are excluded from `mergedPrs`, so
    the autopilot's own merges do not trigger a rescan.
  - `requiredChecks(key, branch, { exec }) -> Promise<string[]>`, from
    `repos/{key}/rules/branches/{branch}`, plus classic protection from
    `repos/{key}/branches/{branch}/protection/required_status_checks` (a 404 there means
    none). An empty list means there is no gate.
  - `prState(key, pr, { exec }) -> Promise<'OPEN'|'CLOSED'|'MERGED'>` and `mergeSha`, from
    `gh pr view <pr> -R <key> --json state,mergeCommit`.
  - `chooseTiers(repos: {key, openHigh: number, eventsPerWeek: {push, pr, release}, estDiff: number}[], dollarsLeft: number) -> Record<key, 'diff'|'pr'|'release'|'weekly'|'monthly'>`.
    It sorts by `openHigh` descending, then total events descending. For each repo it picks
    the most frequent tier whose `runsPerWeek × estDiff` fits the remaining dollars, and
    subtracts the cost. `runsPerWeek` is `push` for `diff`, `pr` for `pr`, `release` for
    `release`, 1 for `weekly` and 0.25 for `monthly`. `monthly` is the floor and is assigned
    even when it does not fit.
  - `dueScan(repoState, events, tier, now) -> 'diff'|'full'|null`. It returns `full` when 90
    days have passed since `lastFullAt` or `scrutineerVersion` changed. It returns `diff` when
    the tier's trigger fired; the clock tiers fire only when `headSha !== lastScannedSha`.
    Otherwise null.

- [ ] **Step 1: Write the failing tests** (with `exec` stubbed):
  - A merged PR from `scrutineer/finding-12` is excluded.
  - `chooseTiers` with $10 left and two repos at `estDiff` 3, events
    `{push:2}` and `{push:5}`, with `openHigh` 1 and 0. The first gets `diff` (cost 6), and
    the second gets `weekly` (3 fits the remaining 4, 15 does not).
  - With $0 left everything is `monthly`.
  - `dueScan` returns `null` for `weekly` when the head is unchanged, and `full` at day 91.
- [ ] **Step 2: Run it and confirm it fails.**
- [ ] **Step 3: Implement both files.**
- [ ] **Step 4: Run it and confirm it passes.** Append the suite and run `npm test`.
- [ ] **Step 5: Commit.** `feat(scrutineer-autopilot): GitHub event polling and budgeted tier choice`

### Task 8: The tick (orchestrator and CLI)

**Files:**
- Create: `packages/scrutineer-autopilot/src/tick.mjs`
- Create: `packages/scrutineer-autopilot/bin/tick.mjs`
- Create: `packages/scrutineer-autopilot/bin/finding.mjs`. This is the read-only relay
  command for the workflow: it prints one finding's JSON (`title`, `severity`, `location`,
  `cwe`, `suggested_fix`, `suggested_fix_commit`, `breaking_change`,
  `breaking_change_rationale`) and never the token.
- Test: `tests/scrutineer-autopilot-tick.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: everything from Tasks 1–7.
- Produces
  `runTick({ config, client, exec, now, dryRun }) -> Promise<TickResult>`, where:
  - `TickResult = { status: 'ok'|'locked'|'paused'|'scrutineer-too-old'|'scrutineer-down'|'budget-unavailable', actions: object[], agentItems: AgentItem[], parked: object[], stopped: object[], notes: string[] }`
  - `AgentItem = { kind: 'fix'|'regate', findingId, repo: key, pr?: number, policy: 'auto'|'stop', visibility: 'public'|'private', hasGate: boolean }`
- A `park` action posts `addNote(id, action.note)` and sets the ledger `stage:'parked'` and
  `parkedAt`. Every status write also posts a note saying why.
- The Scrutineer version for `dueScan` comes from `exec('scrutineer', ['--version'])`. On
  failure it is treated as unchanged.
- The order inside one tick:
  1. Lock, then check paused.
  2. Read config, then feature-detect on one finding. With no in-scope findings, call
     `GET /api/v1/findings?limit=1`.
  3. Read codex and claude usage, and append a budget sample.
  4. List repos, keep the allowlisted ones, and refuse any repo whose Scrutineer
     `scan_schedule` is set: it goes into `notes` and is skipped.
  5. List in-scope findings and scans. For ledger entries with a PR, fill `ctx.prState`
     through `prState`. For held entries, fill `ctx.heldBranchExists` by stat-ing the held
     path. Then compute `nextAction` for each. Lifecycle actions go
     first, highest severity first, each gated by `canStart(codex)` and the 10-enqueue cap.
  6. Rescans: poll each repo, choose tiers, call `dueScan`. Each is gated by `canStart`, and by
     whether any of the instance's scans are `queued` or `running`.
  7. Emit `agentItems`: `fix` items are gated by `canStart(claude, 3)`; `regate` items go out
     for every ledger PR in `awaiting_ci`.
  8. Save the ledger, write the run file, release the lock.
- Before every POST, re-read the finding. Skip when `status` or `updated_at` changed since the
  list read, and check that its `repository_id` maps to an allowlisted key (spec §11).
- `bin/tick.mjs [--dry-run] [--json]` prints the `TickResult`. Exit codes: 0 for `ok`,
  `paused` or `locked`; 2 for `scrutineer-too-old`, `scrutineer-down` or `budget-unavailable`.
- `--dry-run` performs every GET, no POST, and no ledger save, and labels every action
  `would`.

- [ ] **Step 1: Write the failing tests** against `tests/lib/stub-scrutineer.mjs`, with stubbed
  `exec` for gh and codexbar:
  - **Review Focus 1:** the stub is not listening → `status:'scrutineer-down'`, the ledger
    file is unchanged, and the lock is released.
  - **Review Focus 2:** the finding's `updated_at` changes between the list read and the
    pre-POST read → no POST is sent, and the action is reported `skipped: changed`.
  - A finding on a repo outside the allowlist is never POSTed, even if a forged ledger entry
    says `stage:'triaged'`.
  - `dryRun: true` → zero POST requests are recorded by the stub.
  - Stale codexbar → `status:'budget-unavailable'` and zero POSTs.
  - The 11th eligible verify in one tick is not enqueued.
  - A repo with `scan_schedule` set is reported in `notes` and never scanned.
  - `verified_secure` on a repo with no open fix PR → one `AgentItem{kind:'fix'}`.
  - The token string appears nowhere in `JSON.stringify(result)` or in the run file.
- [ ] **Step 2: Run it and confirm it fails.**
- [ ] **Step 3: Implement `src/tick.mjs`, `bin/tick.mjs` and `bin/finding.mjs`.**
- [ ] **Step 4: Run it and confirm it passes.** Append the suite and run `npm test`.
- [ ] **Step 5: Dry run against the real instance.** Write a local `config.json` (owner,
  base URL, token path, allowlist of the 10 repos, the `stop` defaults) and run
  `node packages/scrutineer-autopilot/bin/tick.mjs --dry-run --json`. Expected: `status:'ok'`,
  `would` actions only, no POSTs, and in-scope findings ≈ 155 minus the
  duplicate/published ones. Paste the summary counts into the PR description.
- [ ] **Step 6: Commit.** `feat(scrutineer-autopilot): tick orchestrator, dry-run CLI, finding relay`

### Task 9: `scrutineer-fix-pr` workflow

**Files:**
- Create: `.claude/workflows/scrutineer-fix-pr.js`
- Test: `tests/scrutineer-fix-pr-sim.test.mjs`. Use the harness from
  `tests/merge-pr-with-gate.test.mjs`, including `assertSatisfiable`.
- Modify: `package.json`

**Interfaces:**
- Consumes: `bin/finding.mjs` (Task 8) through a read-only relay, and
  `workflow('shipofclaudius:merge-pr-with-gate', {pr, repo, execute:true})`. Its result's
  `outcome.status` is `MERGED|ESCALATED|FAILED`, and `outcome.verdict` is one of
  `READY|UNKNOWN|NEEDS_REBASE|CONFLICT|BLOCKED|CI_FAILING|CI_PENDING`.
- `args`:
  - `{ mode: 'fix'|'regate', findingId, repo: 'owner/name', pr?, policy: 'auto'|'stop', visibility: 'public'|'private', hasGate: boolean, binDir, buildModel?='sonnet', checkModel?='opus', readonlyAgent?='Explore' }`
  - Parse-guarded with the shared `A` idiom.
  - It throws when `buildModel === checkModel`, or when `findingId` or `repo` is missing.
- Returns
  `{ outcome: 'merged'|'awaiting_ci'|'opened'|'held'|'stopped'|'failed'|'skipped', pr_url, merge_sha, held_path, stop_rule: null|'breaking_change'|'behaviour'|'no_gate'|'merge_escalated'|'policy_stop', reason }`.
- `meta`:
  - `name: 'scrutineer-fix-pr'`
  - `phases: Preflight, Build, Check, Ship, Merge`
  - a non-empty `description` and `whenToUse`
- Phases:
  1. **Preflight**, read-only:
     - The relay runs exactly `node "<binDir>/finding.mjs" <id>`, mints a nonce, and returns
       the raw output.
     - A second read-only agent runs
       `gh pr list -R <repo> --head scrutineer/finding-<id> --state open --json number`.
       If a PR is already open, return `skipped`.
  2. **Build**, a write agent with no `isolation` (it works in a different repo, as
     `factory-build` does):
     - Clone into `${TMPDIR:-/tmp}/scrutineer-autopilot/<id>/repo` and branch
       `scrutineer/finding-<id>` from the default branch.
     - `git apply --3way` the fenced `suggested_fix`.
     - Add a regression test that fails on the default branch and passes with the fix.
     - Assert that `git diff <default>... -- . ':!<test paths>'` equals the Scrutineer diff's
       files.
     - Run the repo's test, lint and build commands.
     - Commit and do **not** push.
     - It returns `{status: 'BUILT'|'APPLY_FAILED'|'GATES_RED', branch, test_added, red, green, diff_files}`.
  3. **Check**, a read-only agent on `checkModel`. It returns
     `{behaviour_change: 'none'|'changed'|'unknown', evidence}`. A `breaking_change` of
     `breaking` or `unknown` in the fenced finding also counts as a stop.
  4. **Ship**:
     - `stop_rule` is computed in script code, not by an agent.
     - Held when there is a stop and `visibility==='public'`, or when `policy==='stop'` and the
       repo is public: return `held` with
       `held_path = ~/.claude/scrutineer-autopilot/held/<id>/`. The write agent moves the
       clone there.
     - Otherwise a write agent pushes and runs `gh pr create` with the fixed title
       `fix(security): <class> in <file>` and a body built from a script template. The
       template names the finding id, reattack `verified_secure`, and the test red/green
       output, and carries no attacker story.
     - Then `stopped` when there is a stop rule, when `policy==='stop'` (`policy_stop`), or
       when `!hasGate` (`no_gate`; the PR is pushed, matching spec §9, where rule 3 is not a
       hold rule).
  5. **Merge**, only when `policy==='auto'`, `hasGate`, and there is no stop: call
     `merge-pr-with-gate`.
     Map the result:
     - `MERGED` → `merged`
     - `CI_PENDING` → `awaiting_ci`
     - `NEEDS_REBASE` → write agent `gh pr update-branch <pr> -R <repo>` → `awaiting_ci`
     - `CONFLICT` → `stopped`, `merge_escalated`, reason `conflict`. This drops the spec §8
       "re-apply once" retry; Task 9 Step 3 records that in spec §8 as a changed call.
     - `BLOCKED` or `CI_FAILING` → `stopped`, `merge_escalated`
  - `mode:'regate'` skips straight to Merge with `args.pr`.
- Every write prompt carries the hard rules from `fix-finding.js`: no push to the default
  branch, no `--admin`, no `--no-verify`, no CI polling, no merge by the write agent, and the
  per-finding scratch path.

- [ ] **Step 1: Write the failing sim tests:**
  - `buildModel === checkModel` throws.
  - A hostile `suggested_fix` and title from the relay reach the Build and Check prompts only
    inside `<<<UNTRUSTED_FINDING_<nonce>>>`, after the anti-injection preamble.
  - `behaviour_change:'changed'` on a public repo → no Ship-push agent, no
    `workflow()` call, outcome `held`.
  - The same on a private repo → the PR is opened, then `stopped`, with no `workflow()` call.
  - `hasGate:false` with a clean check → the PR is opened, `stopped`, `no_gate`, and there is
    no `workflow()` call.
  - `policy:'stop'` on a public repo with a clean check → `held`.
  - A clean check with `policy:'auto'` → `workflow` is called with exactly
    `'shipofclaudius:merge-pr-with-gate'` and `execute:true`.
  - Merge returns `ESCALATED`/`CI_PENDING` → `awaiting_ci`.
  - `NEEDS_REBASE` → an update-branch agent runs, then `awaiting_ci`.
  - `mode:'regate'` dispatches no Build agent.
  - The PR body template contains none of the fixture's `attacker_story` text.
  - `binDir` appears in the relay command, and the token-file path appears in no prompt.
  - Preflight finding an open PR → `skipped`, with zero write agents.
- [ ] **Step 2: Run it and confirm it fails.**
- [ ] **Step 3: Implement `.claude/workflows/scrutineer-fix-pr.js`.** Copy the `fence`,
  `INJECTION_GUARD` and parse-guard idioms from `triage-finding.js`, and the hard-rule block
  from `fix-finding.js`. In the spec §8 DIRTY bullet, replace "re-apply ... once, then stop"
  with "stop (`merge_escalated`, conflict); changed in the plan to avoid a second branch per
  finding".
- [ ] **Step 4: Run it and confirm it passes.** Append the suite and run `npm test`.
  `plugin-integrity` must still pass: `meta.whenToUse` is present and no skill shares the
  name.
- [ ] **Step 5: Commit.** `feat: scrutineer-fix-pr write workflow`

### Task 10: Process skill, scheduled-task template, docs

**Files:**
- Create: `skills/scrutineer-autopilot/SKILL.md`. Frontmatter is `name`, `description` and
  `workflow: none`.
- Create: `skills/scrutineer-autopilot/references/scheduled-task.md`. This is the template
  the `install` subcommand writes to
  `~/.claude/scheduled-tasks/scrutineer-autopilot/SKILL.md`, and it points at
  `~/.claude/scheduled-tasks/PLUGIN-FALLBACK.md` for `Unknown skill`.
- Create: `skills/scrutineer-autopilot/references/config.example.json`. It uses placeholder
  owner `your-gh-login` and no personal values.
- Modify:
  - `README.md` §Workflows: add a table row for `scrutineer-fix-pr`.
  - `README.md` §Security model: "six write workflows" → "seven", and add the
    `scrutineer-fix-pr` actors and mitigations to both lists at lines ~188 and ~222.
  - `README.md` §Process skills and §Layout: add the new skill and package.
- Modify `CLAUDE.md`:
  - "18 workflows" → "19" in the 2 places;
  - add `packages/scrutineer-autopilot` to the packages paragraph and Layout, with one
    sentence: model-free, unit-tested like `factory-gate`, state under
    `~/.claude/scrutineer-autopilot/`.
- Modify `tests/plugin-integrity.test.mjs` comment counts only if a test asserts them; do not
  change assertions.

The skill body says, in this order:
1. **`tick`:**
   - run `node "${CLAUDE_PLUGIN_ROOT}/packages/scrutineer-autopilot/bin/tick.mjs" --json`;
   - for each `agentItems` entry, call
     `Workflow({ name: 'shipofclaudius:scrutineer-fix-pr', args: { ...item, mode: item.kind, binDir: "${CLAUDE_PLUGIN_ROOT}/packages/scrutineer-autopilot/bin" } })`,
     serially;
   - record each result with `node .../bin/tick.mjs --record <findingId> <outcome-json>`
     (add this flag to Task 8's CLI: it writes the workflow outcome into the ledger stage);
   - send a `PushNotification` for each `held` or `stopped` outcome, naming the repo, the
     finding id, `stop_rule`, and the PR URL or held path;
   - send a once-a-day digest of all waiting items, tracked by `lastDigestAt` in the ledger.
2. **`dry-run`:** the same, with `--dry-run`, and no Workflow calls.
3. **`status`:** read `recentRuns(3)` and the ledger, and print the per-repo tier, findings by
   stage, parked findings with reasons, stopped/held fixes, and usage per provider.
4. **`pause` / `resume`:** create or remove the `paused` file.
5. **`install`:** show the resolved `config.json` and the scheduled-task file to Schmug, and
   write them only after an explicit yes. The scheduled task runs hourly.
6. **If a scheduled session cannot run Workflow:** the fallback is one capped `claude -p` per
   item, as in `skills/implement-issue/SKILL.md` (spec §5).

- [ ] **Step 1: Write the failing test.** Add `tests/scrutineer-autopilot-skill.test.mjs`:
  - the SKILL.md has `workflow: none`;
  - it names `shipofclaudius:scrutineer-fix-pr`;
  - every `references/<file>` it mentions exists;
  - `config.example.json` parses;
  - neither file contains `schmug`, `/Users/` or `8081`.
- [ ] **Step 2: Run it and confirm it fails.**
- [ ] **Step 3: Write the skill, the references and the doc edits.** Add `--record` to
  `bin/tick.mjs`, with one test in the tick suite asserting that `--record 5 '{"outcome":"merged"}'`
  sets `findings[5].stage = 'merged'`.
- [ ] **Step 4: Run `npm test`.** Expected: 0 failing, and a total higher than the base commit.
- [ ] **Step 5: Commit.** `feat: scrutineer-autopilot process skill and docs`

### Task 11: Live acceptance (attended, with Schmug)

No new code unless a check fails. Each failure becomes a fix in the owning task's files, with
a test.

- [ ] **Step 1: Ask Schmug which low-risk private repo and finding to walk first.** Wait for
  the answer.
- [ ] **Step 2: Run the install subcommand.** Run `install` and get Schmug's yes. Set every
  other repo to `exclude` in `config.json` for this first run.
- [ ] **Step 3: Tick by hand until the finding reaches `published` or a stop.** Run
  `tick` repeatedly. Record each step's real output. A Scrutineer scan finishing between
  ticks is expected.
- [ ] **Step 4: Verify the three spec §16 unknowns, and write the results into spec §16.**
  - Trigger the scheduled task once and confirm it ran `tick`.
  - Confirm whether `Workflow` ran inside it. If not, switch the skill to the `claude -p`
    fallback before continuing.
  - Confirm whether `PushNotification` arrived.
- [ ] **Step 5: Open the PR.** Open it against `main` through `/shipofclaudius:ship`, with
  the `npm test` output, the dry-run counts (Task 8 Step 5), and the live walk log in the
  body. Merge through the repo's required checks (`test (Node 20)`, `test (Node 22)`).
