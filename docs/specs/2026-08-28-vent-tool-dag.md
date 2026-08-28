# Build plan: agent vent tool

**Base:** `main` @ `c1945da` · **Repo:** `schmug/shipofclaudius` · **Full suite:** `npm test`
**Spec:** `docs/specs/2026-08-24-vent-tool-design.md` · **TDD steps:** `docs/specs/2026-08-28-vent-tool-plan.md`

## Preflight record

- Worktree `feat/vent-tool`, was **3 behind** `origin/main`; rebased onto `c1945da` before any
  pointer was read. Now `0 3`.
- The three missing commits touched `tests/plugin-integrity.test.mjs`. Re-verified against the
  current base: it still has **no `.mcp.json` handling**, so spec §10 item 2 holds.
- Full-suite total moved **22 → 24** while this was planned. The implementation plan had "23"
  hardcoded and has been corrected to compare against a base run instead. This is the stale-base
  defect the orchestrator's Phase 0 exists to catch, and it had already landed.
- No open issue overlaps this work (7 open, all unrelated).

## Nodes

**Granularity note.** The implementation plan's seven tasks are TDD *steps*. These three nodes are
*review units* — the smallest slice worth a fresh reviewer's independent gate. Gating "the sink
module" separately from "context capture" would have a reviewer re-run an identical command against
an identical suite, which is not a second opinion.

| id | issue | scope | files touched | verify (RED now) | deps | invariant |
|----|-------|-------|---------------|------------------|------|-----------|
| n1 | #141 | Minimal server answering the legacy handshake, registered via `.mcp.json`, suite in the test chain. Proves plugin-bundled stdio surfaces the tool in a real session. | `packages/vent-server/server.mjs`, `packages/vent-server/index.mjs`, `.mcp.json`, `tests/vent-server.test.mjs`, `package.json` | `node tests/vent-server.test.mjs` | — | false |
| n2 | #142 | The vent actually works: contextful record appended to `~/.claude/vents.jsonl`, rate limited 1/90s + 10/session, all four outcomes `isError:false`. | `packages/vent-server/sink.mjs`, `packages/vent-server/context.mjs`, `packages/vent-server/server.mjs`, `packages/vent-server/index.mjs`, `tests/vent-server.test.mjs` | `node tests/vent-server.test.mjs` | n1 | **true** |
| n3 | #143 | Modern 2026-07-28 era (`server/discover`, `_meta` dispatch, `-32022`, `resultType`/`structuredContent`) plus real stdio framing tests. | `packages/vent-server/server.mjs`, `packages/vent-server/index.mjs`, `tests/vent-server.test.mjs` | `node tests/vent-server.test.mjs` | n2 | false |

n1 carries impl-plan Task 1; n2 carries Tasks 2–4; n3 carries Tasks 5–6.

`invariant: true` on n2 because it validates untrusted tool input (`text`) and writes to a path
derived from environment — that flag is what triggers the security-hardening review.

### Red-state evidence

Every node is greenfield, so no `verify` command can be red — the suite does not exist. What proves
the work is real is the absence of the capability itself:

```
$ node tests/vent-server.test.mjs
node:internal/modules/cjs/loader:1433
  throw err;              # MODULE_NOT_FOUND — the suite does not exist

$ ls packages/
factory-gate              # no vent-server

$ ls .mcp.json
ls: .mcp.json: No such file or directory

$ grep -n "vent" package.json
(no vent suite registered)
```

The underlying defect — that an agent has no way to report tooling friction — was measured
independently: 0 vents are possible because no vent tool exists, and the question board it
supplements took 0 posts in 16 days across 965 transcripts (`~/.claude/scripts/board-audit.py`).

## Overlap matrix

|    | n1 | n2 | n3 |
|----|----|----|----|
| n1 | —  | ✕  | ✕  |
| n2 | ✕  | —  | ✕  |
| n3 | ✕  | ✕  | —  |

All three share `packages/vent-server/server.mjs` **and** `tests/vent-server.test.mjs`. The graph is
complete: **no pair can run concurrently.**

**Latent overlap:** none. There is no shared helper two nodes would each invent — `sink.mjs` and
`context.mjs` are both created inside n2, so the duplication risk that the matrix cannot see does
not arise here.

## Schedule

Derived from the matrix, not chosen:

- **Parallel batch:** none. There is no disjoint pair.
- **Sequential chain:** `n1 → n2 → n3`, `mode: "sequential"`, each lane branching off the prior
  lane's branch (stacked PRs).

```json
[
  { "key": "n1", "branch": "feat/vent-n1-skeleton", "issues": [141], "invariant": false,
    "brief": "Minimal MCP server answering the legacy 2025-11-25 handshake, .mcp.json at plugin root, suite registered in the package.json test chain. Must end green on: node tests/vent-server.test.mjs" },
  { "key": "n2", "branch": "feat/vent-n2-record", "issues": [142], "invariant": true,
    "brief": "Sink, context capture, rate limiting, and the four-outcome calm-failure contract. Must end green on: node tests/vent-server.test.mjs" },
  { "key": "n3", "branch": "feat/vent-n3-modern", "issues": [143], "invariant": false,
    "brief": "Modern 2026-07-28 era and real stdio framing tests. Must end green on: node tests/vent-server.test.mjs" }
]
```

`defectClasses` for the lane critic — the charter's five, with `css-specificity` generalized to
`silent-override` per the charter's own note, since this repo has no stylesheets:
`silent-override`, `key-normalization`, `cli-flags`, `stale-artifacts`, `unenforced-claims`.

## Why this yields no parallelism

Stated plainly because it changes what the orchestrator is worth here. Every node evolves the same
protocol dispatcher and appends to the same suite, so the matrix is a complete graph and the
"parallel build" premise does not apply. What survives is the review gate: an independent Gate A
re-verification, which is the part that catches a node that fixed nothing.

A decomposition that *would* parallelize exists — split the suite into `vent-server` /
`vent-sink` / `vent-context` files and have n1 pre-register all three in `package.json`, making
sink and context disjoint. It is not recommended: it buys one 2-wide batch of ~30-line nodes,
deviates from approved spec §7 (which names a single suite), and requires n1 to create two
near-empty suites — a green command that does not test its node, which this skill flags as a plan
bug in its own right.

## Integration order

Base-first, dependency-respecting: `n1`, `n2`, `n3`. Full `npm test` against the merged base after
**each** merge — per-node green says nothing about cross-node interaction, and all three nodes
mutate the same dispatcher.

## Descoped

- **Triage scheduled task** (impl-plan Task 7). Outside the repo (`~/.claude/scheduled-tasks/`), so
  no lane can build it; it is a guardrail edit needing Cory's explicit approval, and it is gated on
  spec §9 — fewer than five vents in three weeks means delete the tool rather than build triage for
  it. File a follow-up issue only once the tool has shipped and cleared that bar.
