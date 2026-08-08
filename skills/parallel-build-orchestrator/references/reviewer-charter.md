# Reviewer charter

Two uses, same content:

1. **The `defectClasses` payload** handed to `stacked-impl-lanes` in Phase 2 — each class below becomes one `{key, title, focus}` entry, with the `focus` text passed through verbatim. Caller classes *replace* that workflow's generic defaults, which is the point: the defaults stay generic because it ships publicly, and these are the classes that actually recur here.
2. **The Gate A reviewer's mandate**, handed to a subagent that did **not** write the code.

Keys, in order: `css-specificity`, `key-normalization`, `cli-flags`, `stale-artifacts`, `unenforced-claims`. Set them explicitly — a derived key is truncated at 24 characters, and on the `pr-review-fanout` path a collision silently drops a lens.

Note the upstream default taxonomy carries `silent-override` — the generic form of class (a), covering any last-writer-wins collision rather than only CSS. In a repo with no stylesheets, prefer that generalization; in a repo with CSS, the specific version below finds more.

You are reviewing one node's PR. Your job is not to read the diff and form an impression — it is to **run things and report what happened**. A finding with a command and its output beats five findings with reasoning. Absence of findings has to be earned: if you report `PASS`, you must state, per class below, which procedure you ran and what you looked at. "Looks fine" is not a review.

Two properties make this gate worth anything, so do not trade them away: you did not write this code, and you re-run rather than trust. The PR body's pasted output is a claim by an interested party. Reproduce it.

## Gate A — empirical re-verification

In a fresh worktree at the PR head, in your own shell:

1. Run the node's exact `verify` command from the plan. Record the full output.
2. Run the repo's full suite. Record the count.

If your run disagrees with the PR body, your run wins. Report the discrepancy explicitly — a verification command that passes for the author and fails for you is usually uncommitted state, an ordering dependency, or a missing fixture, and every one of those is a real defect.

## Gate B — the five defect classes

These recur here. Each has a mechanical procedure; run the procedure rather than eyeballing for the pattern.

### (a) CSS specificity & inheritance collisions

A new rule silently overriding an existing one, or being silently overridden.

For each selector added or changed: compute its specificity, then find existing rules that could match the same elements and compare — remembering that at equal specificity **source order wins**, which makes bundler/import order load-bearing. Check specifically for shorthand properties resetting longhands (`background` wiping `background-image`, `font` wiping `line-height`), inherited properties (`color`, `font-*`, `line-height`, `visibility`) newly set on an ancestor and reaching further than intended, custom properties redefined at a broader scope, `!important` escalation, and `:where()` (contributes zero specificity) versus `:is()` (takes its most specific argument).

Empirically: grep every changed property name across the whole stylesheet set to find competing declarations, and where a component renders, diff computed styles before and after.

### (b) Key normalization & dedup

Two logically identical records treated as distinct — or two genuinely different ones collapsed together.

Enumerate every key expression introduced or changed: `Map`/`Set` keys, object keys, `groupBy`/`distinct`/`uniqBy`, join and `WHERE x = y` conditions, cache keys, idempotency keys. For each, ask what two logically-identical inputs produce *different* keys, and what two different inputs produce the *same* key. Work the checklist: case; leading/trailing whitespace; Unicode NFC vs NFD; URLs (trailing slash, scheme, default port, query-param order); number vs string (`1` vs `"1"`); `null` vs `undefined` vs `""`; date precision and timezone; element order in a composite key; locale-dependent `toLowerCase` (Turkish dotless ı); email case and plus-addressing.

Empirically: feed both variants through the actual code and assert on the count that comes out. This class hides from reading and appears instantly under a two-variant test.

### (c) Misused CLI/API flags

Flags that are syntactically fine and fail only at runtime, usually in CI where nobody sees it until it matters.

Extract every flag from changed shell scripts, Makefiles, package scripts, and `.github/workflows/**`. Verify each against `--help` or the real docs — **never** from memory; this class exists precisely because flags are misremembered. Known traps in this codebase's history: `gh api -R` is not a thing (`gh api` takes the repo in the path); GitHub Actions `run:` steps use `bash -e` without `pipefail`, so a failing command mid-pipeline is masked and the step passes; an `if:` condition gating on a value that is empty for the triggering event fails **open**. Also check flags valid on one subcommand but not a sibling, `--force` where `--force-with-lease` is meant, and any command path CI does not actually exercise.

Empirically: run each command with `--help` (or `--dry-run`) in your shell and confirm the flag is really listed.

### (d) Stale artifacts after removal

Code removed, its satellites left behind.

List every symbol, file, export, config key, env var, route, column, and fixture deleted or renamed in the diff. Grep the **whole repo** for each — tests, fixtures, seed scripts, docs, CI config, generated snapshots. Flag: tests importing a deleted module but skipped instead of removed; fixtures nothing loads; seed scripts referencing dropped columns; snapshots for deleted components; and the sharpest one — a test that would still pass if the entire change were reverted, which means it asserts nothing about the new behavior.

Empirically: run the suite and confirm the test count moved in the direction the diff implies. A removal that leaves the count unchanged is worth explaining.

### (e) Unenforced PR claims

Extract every factual or behavioral claim in the PR body as a list. For each, name the **specific** check that would fail if the claim stopped being true — a test name, a lint rule, a CI job, a type. If you cannot name one, the claim is unenforced; report it as such.

Recurring unenforced shapes: "backwards compatible" with no compatibility test, "no performance regression" with no benchmark, "handles X safely" with no test for X, "documented in the README" with nothing checking docs against behavior, "only runs on main" with no test of the trigger condition.

Empirically: for each claim you believe is enforced, run the named check. Ideally confirm it actually fails when the behavior is inverted — a check that passes either way enforces nothing.

## Verdict contract

Return:

- `verdict`: `PASS` or `FAIL`.
- `gate_a`: the two commands, their exit codes, and their output (full suite count included).
- `findings[]`: `{ class: a|b|c|d|e, severity, file:line, what_breaks, command_run, output }`. Every finding needs a concrete failure scenario — inputs or state that produce a wrong result. A finding that cannot be stated that way is a style opinion; drop it.
- `classes_checked`: one line per class naming the procedure you ran and what you inspected. Required even on `PASS`.

`FAIL` on any confirmed finding or any Gate A discrepancy. Report `PASS` only when you ran both gates and can show it.
