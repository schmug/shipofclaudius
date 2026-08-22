---
name: stacked-impl-lanes
description: Implements issue-lanes into review-only PRs (parallel if file-disjoint, sequential + stacked if hub-coupled); security-hardening review on invariant lanes. Use when triage has produced a set of buildable issues and you want them implemented as one reviewable chain rather than one at a time — build this wave, implement these lanes. Not for deciding what to build (use issue-triage-fanout, then issue-research-fanout on its RESEARCH bucket), not for a single issue (use implement-issue, or factory-issue-fix for an unreproduced bug), and not for landing the stack it opens (use stacked-merge-walk).
---

Run the `stacked-impl-lanes` dynamic workflow bundled with this plugin by calling the Workflow tool with its bundled script path:

```
Workflow({ scriptPath: "${CLAUDE_PLUGIN_ROOT}/.claude/workflows/stacked-impl-lanes.js", args: { /* fill from the request */ } })
```

Fill `args` from the user's request. Common args: `lanes` (required), `mode`, `base`, `repo`. Concurrency is bounded twice: `batchSize` caps concurrent **lanes** (default 4) and `agentCap` caps total in-flight **agents** (default 12) — the lane cap alone does not bound agents, because each lane fans one issue relay out per issue. For the full, current argument list, read the header comment / `meta` block in `${CLAUDE_PLUGIN_ROOT}/.claude/workflows/stacked-impl-lanes.js`, or the repo README "Arguments" table. WRITES — opens PRs; needs write scope. Do NOT run under a read-only token; see the workflow header for its safety gates.

### Mixed wave plans

`mode` (`parallel` | `sequential`) is the **global default**. A lane may *optionally* carry its own `mode`, which wins over the global one. So a single run executes a mixed plan: the `sequential` lanes stack (each branching off the prior verified sequential lane), while the `parallel` lanes branch off the original `base` and run in bounded waves. Lanes that declare no `mode` inherit the global one, so an all-global run behaves exactly as before — and that is the case for every lane produced today: `issue-research-fanout`'s `green_lanes` payload is currently `{key, branch, issues, invariant, brief, depends_on}` and carries no `mode`. Treat the per-lane field as forward-compatible support for a wave-planning producer, not as a contract that one exists.

### Verification gates

Each opened lane is critiqued before it is cleared. A lane that any critic gates is sorted into `gated[]` **and** is barred from becoming the branch base that dependent lanes stack onto.

In `sequential` mode that gate goes further, because the lanes are hub-coupled by definition: a lane that does not verify **stops the walk**. Its dependents are *not* implemented against an older base (that would build them on a tree without the predecessor's code, so they re-implement or conflict with it) — they come back in `blocked_on_predecessor[]` with status `BLOCKED_ON_PREDECESSOR`, a `blocked_by` lane key and a reason, having spent no agents. The completed prefix is reported in full, and `stopped_at` names the lane to fix. This mirrors `stacked-merge-walk`, where a PR that cannot land stops the walk and the landed prefix is reported. `parallel` lanes are file-disjoint and have no dependents, so a gated parallel lane holds nothing. Re-running after fixing the held lane resumes the stack — the already-shipped prefix is skipped by the idempotency preflight.

- **`adversarialReview`** — `'opened'` (default: critique every lane that opened a PR) | `'invariant'` (only lanes flagged `invariant`) | `'off'` (or `'none'`). Matched case-insensitively and trimmed; an unrecognized value falls back to `'opened'` **and logs a warning**, since that fallback is the most expensive setting. Mounts **one** read-only adversarial critic per lane that hunts the whole defect taxonomy in a single agent and must report **verbatim command output**, so a critic that merely skimmed the diff is visible. A `FAIL` caps the lane's confidence, forces it to human review, and blocks the base advance.
- **`defectClasses`** — the taxonomy that critic hunts. Accepts plain strings or `{ key, title, focus }` objects (the same convention as `pr-review-fanout`'s `dimensions`). Caller classes **replace** the defaults rather than appending to them. Keys are slugified and de-duplicated (`-2`, `-3`, …) so two classes never collapse onto the one key that `findings[].class` reports. The defaults are generic engineering vocabulary: silent-override/shadowing collisions, key-normalization and dedup, misused CLI/API flags that fail only at runtime, stale tests/fixtures/dead config left after a removal, and claims that no check actually enforces.

Pass a caller-specific taxonomy when the repo has its own recurring defect shapes:

```
Workflow({ scriptPath: "${CLAUDE_PLUGIN_ROOT}/.claude/workflows/stacked-impl-lanes.js", args: {
  mode: "sequential",
  lanes: [{ key: "auth", branch: "feat/auth-scopes", issues: [42], invariant: true, brief: "..." }],
  adversarialReview: "opened",
  defectClasses: [
    "Migrations that are not reversible",
    { key: "tenant", title: "Cross-tenant data leakage", focus: "Any query, cache key, or log line that omits the tenant id, so one tenant can observe another's rows." },
    { key: "clock", title: "Timezone and clock assumptions", focus: "Naive datetimes, DST boundaries, and comparisons that assume the server clock and the database clock agree." }
  ]
} })
```
