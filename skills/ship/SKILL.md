---
name: ship
description: Use when a feature branch is ready to become a pull request and land — before opening the PR, when the user says "ship it", or when work is done and needs the pre-PR gates (tests, lint, typecheck, spec re-read) run in order. Not a Workflow wrapper; this is a session-long process skill.
workflow: none
---

# /ship — pre-PR checklist

You are about to open a pull request. Run this checklist **in order**.
Stop and report failure at the first red step — do not proceed past a failure
without explicit confirmation from the user.

## 1. Verify worktree

```bash
git rev-parse --abbrev-ref HEAD
git status --porcelain
git rev-parse --show-toplevel
pwd
```

Confirm: am I on the intended branch, in the intended worktree, with the
intended changes staged? If anything looks off (wrong worktree, branch named
after a different feature, surprise files), stop and ask.

## 2. Run the test suite

Use the project's test command. Read `package.json`, `pyproject.toml`,
`Makefile`, or CLAUDE.md to find it. Common patterns:

- `npm test`, `pnpm test`, `yarn test`
- `uv run pytest`, `pytest`
- `flutter test`
- `go test ./...`
- `cargo test`

Report the result explicitly. If tests fail, fix them. Do not skip.

## 3. Run lint

If the project has a linter (biome, eslint, ruff, prettier, dart format,
gofmt, etc.), run it. Auto-fix what you can. Report unresolvable warnings.

## 4. Run typecheck / static analysis

- `npm run typecheck`, `tsc --noEmit`
- `astro check`
- `flutter analyze`
- `mypy`, `pyright`
- `go vet`, `cargo clippy`

Stop on errors.

## 5. Re-read the spec

If this branch has a corresponding spec (`docs/spec.md`, a GitHub issue, a
design doc, a `.claude/plans/*.md`), re-read it now. Compare what shipped to
what was specified. List any gaps explicitly. **For each gap, either fix it
now or file a follow-up GitHub issue with rationale.**

A branch that quietly ships only a fraction of its spec is the failure this
step exists to prevent.

## 6. Push and open the PR

```bash
git push
gh pr create --fill
```

Or if the commit-commands plugin is installed: `/commit-commands:commit-push-pr`.

PR description must include:
- A short summary of changes
- Test results (e.g., "313 passing, 0 failing")
- Any spec gaps captured as follow-up issues with links

## 7. Never push directly to main

If main is the current branch, refuse and explain. Open a feature branch
(`feat/`, `fix/`, `chore/`, `security/`, `seo/`) and target `main` (or the
repo's integration branch, e.g. `dev`, where one is in use).

## 8. Merge through the gate

The merge decision is the agent's — but only through a mechanical gate.
Check whether the repo is gated: the default branch must have a
**server-side ruleset or branch protection with required CI checks**.

```bash
BRANCH=$(gh repo view --json defaultBranchRef --jq .defaultBranchRef.name)
gh api "repos/{owner}/{repo}/rules/branches/$BRANCH" --jq '[.[] | select(.type=="required_status_checks")]'
gh api "repos/{owner}/{repo}/branches/$BRANCH/protection" --jq '.required_status_checks'
```

Gated = at least one of those reports required status checks on the default
branch. If both come back empty, error out, or you can't tell (UNKNOWN),
treat the repo as **ungated — fail closed**.

**Gated:** merge it yourself. Once every required check is green,
squash-merge; or enable auto-merge so it lands when green — only after every
correctness fix is already pushed to the branch.

```bash
gh pr merge --squash          # checks already green
gh pr merge --auto --squash   # land automatically when green
```

**Ungated:** do not merge. Stop at the open PR and say exactly which gate is
missing (e.g. "no ruleset with required CI checks on main"). Offer to add
the gate — free on public repos.

Still ask first, gated or not: batched landings bundling force-push or
branch deletion, production releases/deploys/tags, and any change to the
guardrails themselves (settings.json permissions/hooks, rulesets/branch
protection, merge-gate workflow code).
