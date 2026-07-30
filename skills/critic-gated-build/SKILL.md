---
name: critic-gated-build
description: Autonomous greenfield build loop gated by an independent third-party LLM critic. Use when the user wants a project (or major feature) built end-to-end with minimal supervision and an objective ship bar — "build this and tell me when it's actually done" — via spec → TDD PR loop → deploy → fresh-context critic scoring a fixed rubric, until every category ≥8 on two consecutive cycles. Not a Workflow wrapper; this is a session-long process skill.
workflow: none
---

# Critic-Gated Build

Run an entire build — intake → spec → TDD implementation → deploy → independent critique — as one autonomous loop whose "done" is decided by a **fresh-context, third-party LLM critic**, not by the builder. Proven end-to-end on schmug/shelflife (idea → live multiplayer game, ship gate met at critic cycle 5 of 12).

## Phase 0 — Intake (user present)

Use AskUserQuestion in 2–3 batched rounds for only the load-bearing decisions; recommend a default in each:

1. Stack/hosting, data layer, identity model.
2. **Critic provider** — prefer a genuinely third-party CLI already authenticated on the machine (probe: `which codex gemini` and `ls ~/.codex/auth.json`; smoke-test `codex exec --skip-git-repo-check --sandbox read-only "Reply CRITIC_ONLINE" < /dev/null`). Fallback: fresh-context subagent of the building model (disclose the reduced independence).
3. **Done bar** — default: every rubric category ≥ 8/10 on **two consecutive cycles**.
4. **Cycle cap** — default 12; on cap, stop and report gaps instead of thrashing.
5. Deploy target, repo name/visibility, check-in points (default: first deploy + completion only).

Then: spec (committed to the repo), implementation plan, explicit user approval of the design, and autonomy begins.

## Phase 1 — Build loop (per increment)

- TDD; feature branch → PR → CI green → squash merge. Never push to main. **Re-verify the current branch after every `gh pr merge` — it checks main back out and orphan commits land on main silently.**
- Parallel PRs: keep file sets disjoint, land risk-ascending, then run one integration gate (full typecheck + tests) on combined main before a single deploy.
- Build the **verification ladder** early; each rung must emit artifacts a text-only critic can read:
  1. Unit/integration tests (runtime-faithful, e.g. workers-pool against real DB).
  2. HTTP smoke: full happy path **plus adversarial checks** (forged requests, dup submissions, auth bypass attempts) against the deployed target, with a residue-cleanup script and a reserved test-data name prefix.
  3. Browser UI smoke (Playwright, mobile viewport): real taps through the core flow, programmatic touch-target/a11y audits, console-error gate, screenshots. **Block service workers in the smoke context** — offline emulation and routing don't reach SW-mediated fetches, so outage drills silently test nothing once a SW claims the page.
  4. Domain E2E for anything the smoke can't prove (e.g. real push-service delivery).
- A broken verification harness reads to the critic as a broken product. Harness failures are P0.

## Phase 2 — Critic gate (per cycle)

Scaffold once into the target repo from the bundled templates, then run after every deploy:

- `scripts/critic-prompt.md` from `${CLAUDE_PLUGIN_ROOT}/skills/critic-gated-build/references/critic-prompt.md.tmpl` — fill the placeholders; 5 categories scored 1–10, JSON verdict contract, "score what EXISTS, not what is promised".
- `scripts/critic.mjs` from `${CLAUDE_PLUGIN_ROOT}/skills/critic-gated-build/references/critic-runner.mjs.tmpl` — edit the CONFIG block. Each run: clean `git clone` of committed main → live-capture bundle → critic CLI in a read-only sandbox → verdict JSON + full transcript committed to `critic-reports/`.

**The capture bundle is the whole game.** The critic's sandbox has no network and no node_modules, so it must contain everything a skeptic needs: live response bodies/headers/timings, asset payloads, every smoke/E2E output, UI screenshots, and `gates.txt` (revision SHA + local typecheck/test output + CI run list). Rebut wrong findings with evidence in the bundle, never with argument — and expect occasional false findings anyway (a critic once reported the CI workflow "missing" while it sat in `.github/`).

Loop discipline:

- Run the critic in the background; keep working only on things that can't race it.
- **Fix every finding each cycle, minors included** — polish minors left on the table become next cycle's 7s, and a pass streak resets on any category < 8 (observed: pass → fail → pass → pass).
- Expect platform-level findings the app can't fix (zone HSTS overrides, injected analytics vs. strict CSP). Capture them, document the boundary in the report, and hand the decision to the user — never change zone/org-wide settings unilaterally.

## Phase 3 — Completion protocol

On two consecutive passes (or the cap):

1. File remaining findings as self-contained GitHub issues (task, `path:line` pointers, constraints, acceptance criteria, out-of-scope); spawn implementation chips for the code-shaped ones.
2. Commit final critic reports; update project memory with the score trajectory and open boundaries.
3. Final report to the user: score table per cycle, what shipped, what's theirs to decide (platform settings), any process slips — reported honestly.

## Templates

- `references/critic-prompt.md.tmpl` — rubric brief (placeholders: `{{PRODUCT}}`, `{{PRODUCT_SUMMARY}}`, `{{LIVE_URL}}`, `{{SPEC_PATH}}`, `{{CATEGORY_*}}`).
- `references/critic-runner.mjs.tmpl` — capture + run harness (edit the CONFIG block; keep the gates.txt and evidence-copy steps).
