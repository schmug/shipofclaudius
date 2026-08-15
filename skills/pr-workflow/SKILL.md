---
name: pr-workflow
description: Use when creating PRs, finishing features, or preparing code for merge. Use after local work is complete and ready for review/deployment. Not a Workflow wrapper; this is a session-long process skill.
workflow: none
---

# PR Workflow

## Overview

Structured workflow for creating PRs that verifies local tests, CI status, and (where the project has one) the deployment, then merges through the repo's mechanical gate.

## When to Use

- Finishing a feature branch
- Creating a pull request
- User says "create a PR", "ship it", "merge this"

## Workflow

```dot
digraph pr_workflow {
    rankdir=TB;
    node [shape=box];

    start [label="Ready to create PR" shape=ellipse];
    local [label="1. Run local verification\n(tests + typecheck + build,\ne.g. pnpm test && pnpm check && pnpm build)"];
    pass [label="All pass?" shape=diamond];
    fix [label="Fix issues first"];
    push [label="2. Push branch\ngit push -u origin HEAD"];
    ci [label="3. Verify GitHub CI\ngh pr checks (if PR exists)\ngh run list --branch (if not)"];
    ci_pass [label="CI green?" shape=diamond];
    wait [label="Wait for CI / fix failures"];
    cf [label="4. Check deployment\n(if the project deploys,\ne.g. via a Cloudflare MCP)"];
    cf_pass [label="Deployment OK?" shape=diamond];
    cf_fix [label="Check deploy logs/\nobservability for errors"];
    issues [label="5. Link related issues\nFind with: gh issue list"];
    gate [label="6. Gate check\nDefault branch has server-side\nruleset/protection with\nrequired CI checks?" shape=diamond];
    risky [label="Risky category?\n(schema/auth/payment/\nbreaking/large refactor)" shape=diamond];
    merge [label="Merge it yourself\ngh pr merge --squash (green)\ngh pr merge --auto --squash"];
    ungated [label="Stop at the open PR\nSay which gate is missing"];
    review [label="Ask user before merging\nExplain what needs review"];
    done [label="Done" shape=ellipse];

    start -> local;
    local -> pass;
    pass -> fix [label="no"];
    pass -> push [label="yes"];
    fix -> local;
    push -> ci;
    ci -> ci_pass;
    ci_pass -> wait [label="no"];
    ci_pass -> cf [label="yes"];
    wait -> ci;
    cf -> cf_pass;
    cf_pass -> cf_fix [label="no"];
    cf_pass -> issues [label="yes"];
    cf_fix -> cf;
    issues -> gate;
    gate -> ungated [label="no / UNKNOWN\n(fail closed)"];
    gate -> risky [label="yes"];
    risky -> review [label="yes"];
    risky -> merge [label="no"];
    merge -> done;
    ungated -> done;
    review -> done;
}
```

## Quick Reference

| Step | Command/Tool | Purpose |
|------|--------------|---------|
| Local tests | project's test/check/build commands | Verify code works |
| Push | `git push -u origin HEAD` | Push branch to remote |
| CI status | `gh pr checks` or `gh run list --branch <branch>` | Verify GitHub Actions |
| Deployment | deploy platform's CLI/MCP (if applicable) | Verify staging deploy |
| Find issues | `gh issue list` | Link related issues |
| Create PR | `gh pr create --title "..." --body "..."` | Open pull request |
| Gate check | `gh api repos/{owner}/{repo}/rules/branches/<default>` | Required checks on default branch? |
| Merge | `gh pr merge --squash` / `gh pr merge --auto --squash` | Land through the gate |

## Merge Criteria

The merge criterion is the **gate**, not the content of the change:

- **Gated** — the default branch has a server-side ruleset or branch
  protection with required CI checks: merge it yourself. Squash-merge once
  every required check is green, or enable auto-merge
  (`gh pr merge --auto --squash`) once every correctness fix is pushed.
  The merge decision is the agent's.
- **Ungated** — no required checks, or detection fails/UNKNOWN (fail
  closed): do not merge. Stop at the open PR and say which gate is missing,
  or add the gate first (free on public repos).

Gate check:

```bash
BRANCH=$(gh repo view --json defaultBranchRef --jq .defaultBranchRef.name)
gh api "repos/{owner}/{repo}/rules/branches/$BRANCH" --jq '[.[] | select(.type=="required_status_checks")]'
gh api "repos/{owner}/{repo}/branches/$BRANCH/protection" --jq '.required_status_checks'
```

**Ask-first carve-out** — even in a gated repo, ask before merging:
- Database schema changes
- Auth/security changes
- Payment/billing changes
- Breaking API changes
- Architectural decisions
- Large refactors
- Uncertainty about approach

This carve-out sits alongside the always-ask list — batched destructive
landings, production releases/deploys/tags, and changes to the guardrails
themselves — which needs a human go-ahead regardless of the gate.

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Creating PR before CI runs | Wait for `gh run list` to show completion |
| Skipping the deployment check | Verify staging works before merging (when the project deploys) |
| Not linking issues | Search with `gh issue list` and add `Closes #N` |
| Automerging risky changes | When in doubt, ask the user |
| Merging in an ungated repo | Stop at the PR; name the missing gate |
| Treating gate-detection failure as gated | UNKNOWN = ungated; fail closed |

## PR Body Template

```markdown
## Summary
- Brief description of changes

## Test plan
- [ ] Unit tests pass
- [ ] Typecheck passes
- [ ] Build succeeds
- [ ] Staging deployment verified (if applicable)

Closes #ISSUE_NUMBER
```
