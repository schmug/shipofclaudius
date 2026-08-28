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

---

## Running the fan-out

Phases 0 and 1 are **done and committed** — base rebased, matrix built, issues #141–#143 filed with
`awaiting-human` so the issue-filed routine skips them. Only Phase 2 remains. Invoke
`stacked-impl-lanes` **directly**; do not re-run `parallel-build-orchestrator`, which would redo the
planning and could file duplicates of #141–#143.

### Hard prerequisite: run it from a shipofclaudius session

`stacked-impl-lanes` dispatches its implementer with `isolation: 'worktree'`, and an agent worktree
is created from **the session's own repository**. There is no `repoPath` or `cwd` argument.

`args.repo` does exist, but it governs only the workflow's **reads**. It is aliased at line 74
(`const A = ...`), so a `grep 'args\.'` misses it, and it reaches exactly two call sites: the issue
relay's `gh issue view` (line 235) and the idempotency preflight's `gh pr list` (line 273). The
implementer's worktree and its `gh pr create --draft --base ...` (line 410) carry no repo at all.
Passing a `repo` that disagrees with the session therefore **reads issues from one repository and
writes code and PRs to another** — and the read half working is what makes it hard to notice.
Tracked as #146.

> **Correction.** The first version of this section claimed `args.repo` is never read. That was
> wrong — it was based on a `grep 'args\.'` that the `A` alias defeats. The prerequisite below is
> unchanged; the reason is narrower and worse than "the argument is ignored".

Run `wf_f9d3814b-b4a` learned this the expensive way: dispatched from a session whose cwd was an
`agent-notes` worktree, it built its lane worktree at
`/Users/cory/agent-notes/.claude/worktrees/wf_f9d3814b-b4a-3` with origin `schmug/agent-notes`, while
the lanes targeted `schmug/shipofclaudius`. n1 returned `BLOCKED` with a repository mismatch, n2 and
n3 correctly returned `BLOCKED_ON_PREDECESSOR` having spent no agents, and ~130k subagent tokens
bought no code. Nothing was contaminated, but nothing was built either.

**So: the session's working directory must be `/Users/cory/shipofclaudius`.** A session pinned to an
isolated worktree of another repo cannot be moved (`change_directory` refuses), so this needs a
session started in the right place.

### Resolve the plugin path first

The bundled script path is version-pinned and changes on every plugin update. Resolve it rather than
copying the hash below:

```bash
ls -d ~/.claude/plugins/cache/shipofclaudius/shipofclaudius/*/.claude/workflows/stacked-impl-lanes.js
```

### One more trap

The lane briefs must tell the implementer to write the literal template variable
`${CLAUDE_PLUGIN_ROOT}` into `.mcp.json`. Passing that token through a **skill's** `args` expands it
to an absolute path, which yields a `.mcp.json` hardcoded to one machine — working locally, broken
for every other install. Passing it through the **Workflow** tool's JSON `args` is safe. If in doubt,
spell it out in words, as the n1 brief below does.

### The invocation

```
Workflow({
  scriptPath: "<resolved path from above>",
  args: {
    base: "main",
    mode: "sequential",
    adversarialReview: "opened",
    batchSize: 1,
    lanes: [ /* the three lane objects below */ ],
    defectClasses: [ /* the five classes below */ ]
  }
})
```

`mode: "sequential"` and `batchSize: 1` are forced by the overlap matrix above, not chosen.
`invariant: true` on n2 is what triggers the security-hardening review.

### Lane briefs, as dispatched

**n1** — `feat/vent-n1-skeleton`, issues `[141]`, `invariant: false`:

> Node n1 of the agent vent tool. Build a minimal MCP stdio server answering the LEGACY 2025-11-25 initialize handshake, register it via a .mcp.json at the REPO ROOT, and add tests/vent-server.test.mjs to the package.json test &&-chain.
>
> AUTHORITATIVE SOURCE: docs/specs/2026-08-28-vent-tool-plan.md, Task 1. It carries the exact test code and the exact implementation code, verbatim. Follow it rather than improvising. Design rationale is in docs/specs/2026-08-24-vent-tool-design.md.
>
> CRITICAL DETAIL: the .mcp.json args entry must contain the literal template variable CLAUDE_PLUGIN_ROOT wrapped in dollar-brace syntax (dollar sign, open brace, CLAUDE_PLUGIN_ROOT, close brace) followed by /packages/vent-server/index.mjs. Do NOT substitute an expanded absolute path — the host expands it at load time. Three shipped plugins (discord, fakechat, telegram) use this exact pattern; copy their shape.
>
> CONSTRAINTS: Node built-ins only (node:* imports). Zero npm dependencies, no lockfile, CI runs with no install step. Never pin a whole-suite test total into any doc — plugin-integrity fails the build on it; compare against a run on origin/main instead. The tool description string is copied VERBATIM from spec section 4.2 — do not add an eligibility-criteria list to it, that reintroduces the failure mode the tool exists to avoid.
>
> Must end green on BOTH: `node tests/vent-server.test.mjs` and `npm test`.
>
> MANUAL GATE, acceptance criterion 3 of issue #141: run `claude --plugin-dir /Users/cory/shipofclaudius -p "List your available tools whose name contains vent. Do not call anything."` and confirm the response names an mcp__vent__vent tool. This is the entire reason n1 exists — plugin-bundled stdio surfacing a tool has never been verified end to end. If it does NOT appear, STOP and report; do not continue. Diagnose in order: (a) .mcp.json at repo root vs under .claude-plugin/; (b) whether the plugin-root template expands, hardcoding an absolute path temporarily to isolate; (c) whether `node packages/vent-server/index.mjs` answers a hand-fed initialize line. An 'OAuth session expired' result is an auth problem, NOT a wiring failure — say so rather than concluding the wiring is broken.

**n2** — `feat/vent-n2-record`, issues `[142]`, `invariant: true`:

> Node n2 of the agent vent tool, stacked on n1. Make the vent actually record: append a contextful JSON line to ~/.claude/vents.jsonl, rate limited, with a failure contract that never errors into a session.
>
> AUTHORITATIVE SOURCE: docs/specs/2026-08-28-vent-tool-plan.md, Tasks 2, 3, and 4. They carry the exact test and implementation code verbatim. Follow them.
>
> THE INVARIANT THIS LANE PROTECTS: a vent must NEVER error into a session. All four outcomes an agent can cause — recorded, rate-limited, sink-unavailable, invalid-input — return isError:false with a calm {recorded, reason} payload and NO JSON-RPC error. The MCP spec reserves isError:true for tool execution errors a model should self-correct from; a dropped vent is information, not a fault to retry. There must be an explicit test asserting this across all four outcomes.
>
> CONSTRAINTS: Node built-ins only. Rate limit is 1 vent per 90 seconds AND 10 per session; refusals must not consume quota and must not reach the sink. Git lookups are best-effort and time-bounded — a slow or absent git degrades to null, never hangs the tool call. appendVent returns false on failure and NEVER throws; single append-mode write, never read-modify-write. Prefer the CLAUDE_PROJECT_DIR environment variable over process.cwd(). Every context field is string-or-null, never undefined.
>
> Must end green on BOTH: `node tests/vent-server.test.mjs` and `npm test`.

**n3** — `feat/vent-n3-modern`, issues `[143]`, `invariant: false`:

> Node n3 of the agent vent tool, stacked on n2. Add the modern 2026-07-28 MCP era alongside the legacy handshake, plus integration tests that spawn the real server to cover stdio framing.
>
> AUTHORITATIVE SOURCE: docs/specs/2026-08-28-vent-tool-plan.md, Tasks 5 and 6. They carry the exact test and implementation code verbatim.
>
> WHY DUAL-ERA: MCP's current revision 2026-07-28 removed the initialize handshake entirely — modern clients are stateless and carry version, identity and capabilities as per-request _meta, and server/discover is mandatory. Claude Code 2.1.241 is a LEGACY client, verified empirically: it sends initialize with protocolVersion 2025-11-25. A modern-only server would not work today; a legacy-only server dies when Claude Code moves.
>
> HONESTY CONSTRAINT: the modern path CANNOT be verified against a real client, because none exists. Its tests prove that our responses match the published spec shapes and nothing more. Do NOT describe it as verified end-to-end in a commit message, the PR body, or any doc. The PR body must state plainly that it is unverified against a real client.
>
> CONSTRAINTS: Node built-ins only. Legacy results must carry NO modern-only fields — assert resultType and structuredContent are undefined on the legacy path. Unsupported version yields JSON-RPC error -32022 with data.supported and data.requested populated. Modern tools/call mirrors the payload into structuredContent AND keeps the text block. notifications/initialized carries no id and must draw no reply.
>
> Must end green on BOTH: `node tests/vent-server.test.mjs` and `npm test`.

### defectClasses payload

Caller classes **replace** the workflow's generic defaults, so all five must be passed together. The
`focus` text is the load-bearing part — it is the procedure the critic runs instead of eyeballing —
and is reproduced verbatim from the orchestrator's `references/reviewer-charter.md`, with
`css-specificity` generalized to `silent-override` per that charter's own note, since this repo has
no stylesheets.

```json
[
  { "key": "silent-override", "title": "Silent override / last-writer-wins collision",
    "focus": "A new definition silently overriding an existing one, or being silently overridden. For each symbol, config key, object spread, or registration added or changed: find existing definitions that could collide and compare, remembering that at equal precedence source order wins. Empirically: grep every changed name across the whole repo to find competing declarations." },
  { "key": "key-normalization", "title": "Key normalization & dedup",
    "focus": "Two logically identical records treated as distinct — or two genuinely different ones collapsed together. Enumerate every key expression introduced or changed: Map/Set keys, object keys, groupBy/distinct/uniqBy, join conditions, cache keys, idempotency keys. For each, ask what two logically-identical inputs produce different keys, and what two different inputs produce the same key. Work the checklist: case; leading/trailing whitespace; Unicode NFC vs NFD; URLs (trailing slash, scheme, default port, query-param order); number vs string; null vs undefined vs empty string; date precision and timezone; element order in a composite key; locale-dependent toLowerCase. Empirically: feed both variants through the actual code and assert on the count that comes out." },
  { "key": "cli-flags", "title": "Misused CLI/API flags",
    "focus": "Flags that are syntactically fine and fail only at runtime, usually in CI where nobody sees it until it matters. Extract every flag from changed shell scripts, Makefiles, package scripts, and .github/workflows/**. Verify each against --help or the real docs — never from memory. Known traps here: `gh api -R` is not a thing; GitHub Actions run: steps use bash -e without pipefail so a failing command mid-pipeline is masked; an if: condition gating on a value that is empty for the triggering event fails open. Empirically: run each command with --help or --dry-run and confirm the flag is really listed." },
  { "key": "stale-artifacts", "title": "Stale artifacts after removal",
    "focus": "Code removed, its satellites left behind. List every symbol, file, export, config key, env var, and fixture deleted or renamed in the diff. Grep the whole repo for each — tests, fixtures, docs, CI config. Flag tests importing a deleted module but skipped instead of removed, and the sharpest one: a test that would still pass if the entire change were reverted, which means it asserts nothing about the new behavior. Empirically: run the suite and confirm the test count moved in the direction the diff implies." },
  { "key": "unenforced-claims", "title": "Unenforced PR claims",
    "focus": "Extract every factual or behavioral claim in the PR body as a list. For each, name the specific check that would fail if the claim stopped being true — a test name, a lint rule, a CI job, a type. If you cannot name one, the claim is unenforced; report it as such. Recurring shapes: 'backwards compatible' with no compatibility test, 'handles X safely' with no test for X, 'verified' where nothing was actually run. Empirically: for each claim you believe is enforced, run the named check, and ideally confirm it fails when the behavior is inverted." }
]
```

### After the lanes return

1. **Gate A is not delegable.** In a fresh worktree at each PR head, a reviewer that did not write
   the code runs `node tests/vent-server.test.mjs` and `npm test` **itself**. `pr-review-fanout` reads
   diff text and never checks out or executes anything, so skipping Gate A means nothing was ever run
   by a second party. If the reviewer's run disagrees with the PR body, the reviewer's run wins.
2. **Verify all five defect-class keys came back.** A lens that vanished silently looks exactly like a
   lens that found nothing.
3. **Phase 4** is `stacked-merge-walk`, base-first in dependency order. It stages by default and
   merges nothing until `execute: true`, which is Cory's call, not an agent's.
