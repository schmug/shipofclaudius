---
name: stacked-impl-lanes
description: Implements issue-lanes into review-only PRs (parallel if file-disjoint, sequential + stacked if hub-coupled); security-hardening review on invariant lanes.
---

Run the `stacked-impl-lanes` dynamic workflow bundled with this plugin by calling the Workflow tool with its bundled script path:

```
Workflow({ scriptPath: "${CLAUDE_PLUGIN_ROOT}/.claude/workflows/stacked-impl-lanes.js", args: { /* fill from the request */ } })
```

Fill `args` from the user's request. Common args: `lanes` (required), `mode`, `base`, `repo`. For the full, current argument list, read the header comment / `meta` block in `${CLAUDE_PLUGIN_ROOT}/.claude/workflows/stacked-impl-lanes.js`, or the repo README "Arguments" table. WRITES — opens PRs; needs write scope. Do NOT run under a read-only token; see the workflow header for its safety gates.

### Verification gates

Each opened lane is critiqued before it is cleared. A lane that any critic gates is sorted into `gated[]` **and** is barred from becoming the branch base that dependent lanes stack onto — in `sequential` mode the base only advances past a lane that actually verified, so an unreviewed lane never becomes the foundation the rest of the stack is built and reviewed against. A `BLOCKED` lane still does not break the chain: the base simply stays where it was and the next lane falls back to the last verified base.

- **`adversarialReview`** — `'opened'` (default: critique every lane that opened a PR) | `'invariant'` (only lanes flagged `invariant`) | `'off'`. Mounts **one** read-only adversarial critic per lane that hunts the whole defect taxonomy in a single agent and must report **verbatim command output**, so a critic that merely skimmed the diff is visible. A `FAIL` caps the lane's confidence, forces it to human review, and blocks the base advance.
- **`defectClasses`** — the taxonomy that critic hunts. Accepts plain strings or `{ key, title, focus }` objects (the same convention as `pr-review-fanout`'s `dimensions`). Caller classes **replace** the defaults rather than appending to them. The defaults are generic engineering vocabulary: silent-override/shadowing collisions, key-normalization and dedup, misused CLI/API flags that fail only at runtime, stale tests/fixtures/dead config left after a removal, and claims that no check actually enforces.

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
