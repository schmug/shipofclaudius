# plan.md template

Fill this from reading the codebase, not from the issue titles. The file sets drive the schedule, so a guessed file set produces a wrong schedule that only shows up as a merge conflict three nodes later.

---

# Build plan: <epic / target>

**Base:** `main` · **Repo:** `<owner/repo>` · **Full suite:** `<command>`

## Nodes

| id | issue | scope | files touched | verify (must be RED now) | deps |
|----|-------|-------|---------------|--------------------------|------|
| n1 | #12 | one-sentence coherent change | `src/a.ts`, `tests/a.test.ts` | `npm test -- a.test` | — |
| n2 | #13 | … | `src/b.ts` | `npm test -- b.test` | — |
| n3 | #14 | … | `src/a.ts`, `src/c.ts` | `npm run typecheck` | n1 |

Rules the table has to satisfy:

- **One command per node.** Needing two commands to prove a node means it is two nodes.
- **`verify` is proven red.** An existing command must be run and shown failing. A command that is a not-yet-written test cannot be red, so record a **reproduction** instead (below).
- **`files` came from reading.** Note anything uncertain — an uncertain file set is an overlap risk, and overlap risk is merge risk.
- **Pointers verified.** Confirm each issue's cited `path:line` and any "already fixed in #N" claim actually exists before making it a node.

### Red-state evidence

For a node whose command exists:

```
$ <verify for n1>
<failing output>
```

For a bug node whose test does not exist yet, paste the **reproduction** that proves the defect is real — this is what the implementer converts into the failing test:

```
$ node /tmp/repro-n1.mjs
keys: [ 'error-handling', 'error-handling' ] => distinct: 1 of 2   # expected 2
```

Every node needs one or the other. A node with neither is unproven, and building it risks fixing nothing.

## Overlap matrix

Mark every pair whose file sets intersect.

|    | n1 | n2 | n3 |
|----|----|----|----|
| n1 | —  |    | ✕  |
| n2 |    | —  |    |
| n3 | ✕  |    | —  |

`✕` = shared file → **cannot run concurrently**, regardless of how unrelated the scopes look.

## Schedule

Derived directly from the matrix — not chosen independently of it.

- **Parallel batch** (mutually disjoint, each off `main`): `n2`, … → `mode: "parallel"`, max 4 lanes at a time.
- **Sequential chain** (overlapping cluster, dependency order, each off the prior branch): `n1 → n3` → `mode: "sequential"`.

Lane objects handed to fan-out:

```json
[
  { "key": "n1", "branch": "feat/n1-<slug>", "issues": [12], "invariant": false,
    "brief": "<scope>. Must end green on: npm test -- a.test" }
]
```

`invariant: true` for any lane touching auth, crypto, input validation, HTML/template rendering, or CI permissions — that flag is what triggers the security-hardening review.

## Integration order

Base-first, dependency-respecting: `n2`, `n1`, `n3`. Full suite runs against the merged base after **each** merge; per-node green says nothing about cross-node interaction.

## Descoped

Anything deliberately not built, with the issue number filed for it. Empty is a valid answer only if it is true.
