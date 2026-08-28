# Agent Vent Tool — Design Spec

**Date:** 2026-08-24
**Repo:** `schmug/shipofclaudius` (canonical source; `~/.claude/` holds runtime state only)
**Status:** Design approved in chat 2026-08-24. This doc is the handoff source of truth for a fresh agent.

---

## 0. Why this exists / how to read it

Build a low-bar channel through which an agent can report friction with Cory's *own agent
tooling*, so that friction becomes fixable instead of evaporating at the end of a session.

Read §1 before touching anything — this design is a deliberate inversion of an existing
system that failed, and the reason it inverts matters more than any implementation detail.

Everything in §4 is a contract. Everything in §10 is explicitly **unverified** and must be
checked against reality during implementation, not assumed.

---

## 1. Background — the failure this is responding to

`schmug/agent-notes` is a cross-session question board (Q&A discussions). Agents post durable
unknowns; a SessionStart hook injects open questions into every session. Audited 2026-08-22
and again 2026-08-24:

| metric | result |
|---|---|
| real questions posted since launch 2026-08-08 | **0** |
| `Skill(ask-board)` invocations across 965 transcripts | **0** |
| SessionStart hook coverage (since both fixes landed) | 61/61 sessions (100%) |

Two root causes were found and fixed (see `~/.claude/scripts/board-audit.py` and the memory
files `question-board-underuse-root-causes`, `claude-md-improver-drops-policy-sections`).
Coverage is now perfect and posts are still zero.

The remaining hypothesis is **bar height**. The board's write path is a three-part gate the
agent must recall and self-assess against. Lovable published a result on the opposite design
(<https://lovable.dev/blog/we-gave-our-agent-a-vent-tool>): a "vent" tool where the author
"pulled most of the explicit eligibility criteria back out of the prompt and trusted the
model's judgment", producing ~10 merged fixes/day at a tolerated ~50% false-positive rate,
and one instance of 43 vents from a single project during an apology spiral.

**The design principle this yields:** move the gate from write-time to triage-time. The agent
should never have to decide whether something qualifies. Something downstream decides.

**This does not change the question board.** The board keeps its gate. Vent is a second,
separate channel with a different bar and a different sink. Do not merge them.

---

## 2. Scope decisions (settled — do not relitigate)

| Fork | Decision | Rejected, and why |
|---|---|---|
| What a vent is about | Friction with **Cory's agent tooling** (`~/.claude` + this plugin) | The working repo (fix target varies per repo, no single triage owner); both unfiltered (needs stronger triage than we're building) |
| How it fires | **MCP tool** bundled in this plugin | A skill or a documented bash script — both reproduce the board's exact failure mode: a procedure the agent must remember and choose. A Stop-hook harvest was rejected because it captures what a phrase filter detects (measured 10–18% precision), not what the agent actually found frustrating. |
| Sink + triage | **Local JSONL → scheduled weekly triage → clustered issues** | Slack (network call in the hot path, external persistence of tooling complaints); GitHub-issue-per-vent (relocates the noise into a tracker that is actually read) |

The structural analogy: Lovable's agent vents about the platform it runs on, and a debug agent
fixes that platform. Cory's platform is `~/.claude` + `shipofclaudius`.

---

## 3. Architecture

```
agent hits friction
      │
      ▼
  vent tool  ──────────────▶  ~/.claude/vents.jsonl   (append-only, local, instant)
  (MCP, this plugin)                  │
                                      ▼
                        weekly scheduled triage task
                                      │
                      ┌───────────────┴────────────────┐
                      ▼                                ▼
        cluster is about the plugin        cluster is about ~/.claude
                      │                                │
                      ▼                                ▼
        ONE issue per cluster in            summarized in the run report
        schmug/shipofclaudius               (NOT filed — guardrail edits
                                             need Cory's approval, and
                                             ~/.claude is not a git repo)
```

Three units, each independently testable: the server (pure I/O contract), the sink (a file
format), the triage task (a prompt). The server must not know anything about triage.

---

## 4. Contract — the vent tool

### 4.1 Server

One MCP server, bundled in this plugin, speaking JSON-RPC 2.0 over stdio. It must handle
`initialize`, `tools/list`, and `tools/call`.

**Node built-ins only.** This repo has zero npm dependencies, intentionally no lockfile, and
CI runs `npm test` with no install step (see `CLAUDE.md`). `@modelcontextprotocol/sdk` is
therefore **not available** — the JSON-RPC framing is hand-rolled. This is protocol plumbing,
not a security primitive, so hand-rolling does not conflict with the global rule about using
vetted libraries for crypto/JWT.

### 4.2 Tool description (verbatim — this text IS the bar)

> Record friction with Cory's agent tooling: a hook that blocked legitimate work, a skill that
> misfired, a permission denial that cost you a retry, a guardrail whose rule was ambiguous, a
> command that failed confusingly. Free text — say what happened and what you wanted to happen.
> There is no bar to clear and no format to follow; if something about this environment made
> your work harder, that is enough. Fire and continue — this never blocks and never needs
> follow-up.

Anchored on examples, with no eligibility criteria, deliberately. If a future change adds a
criteria list to this description, it has reintroduced the board's failure mode — do not.

### 4.3 Input schema

```json
{ "text": { "type": "string" } }
```

`text` is required and is the **only** field. No severity, no category, no subject. Every
field is friction at the moment of use, and an LLM triage agent clusters free text fine.
Adding a field to this schema requires a reason that survives §9.

### 4.4 Auto-captured context

The agent supplies none of this; the server gathers it:

| field | source |
|---|---|
| `ts` | ISO 8601 UTC at write time |
| `text` | the tool argument |
| `cwd` | working directory (see §10 — may not be the project dir) |
| `repo` | `git config --get remote.origin.url` resolved to `owner/name`, or `null` |
| `branch` | `git rev-parse --abbrev-ref HEAD`, or `null` |
| `session` | session id if the runtime exposes one (see §10) — **omit rather than fabricate** |

Git lookups must be best-effort and time-bounded: a slow or absent git must degrade to `null`,
never hang the tool call.

### 4.5 Rate limiting (build this on day one)

Lovable shipped this only after an agent fired 43 vents from one project while spiralling into
apologies. It is a known failure mode; do not wait to rediscover it.

- At most **1 vent per 90 seconds** per session.
- At most **10 vents per session**, total.

### 4.6 Return shapes — never error into a session

The tool returns success in every case an agent can cause. A vent is a side channel; it must
never fail a turn, block, slow work, or prompt a retry.

| condition | return |
|---|---|
| written | `{"recorded": true}` |
| over rate limit | `{"recorded": false, "reason": "rate-limited"}` |
| sink unwritable | `{"recorded": false, "reason": "sink-unavailable"}` |
| malformed input | `{"recorded": false, "reason": "invalid-input"}` |

`recorded: false` is a calm outcome, not an error. Nothing in the response should suggest the
agent ought to try again, escalate, or tell the user.

---

## 5. Sink format

`~/.claude/vents.jsonl` — append-only, one JSON object per line, schema per §4.4. Runtime
state lives in `~/.claude` (alongside `scripts/board-audit.py`), never in this repo.

Append with a single small `O_APPEND` write so concurrent sessions interleave cleanly rather
than corrupting lines. Never read-modify-write the file from the server.

---

## 6. Triage

A scheduled task (`~/.claude/scheduled-tasks/`), weekly. The pattern is proven — see
`board-utilization-audit`, created 2026-08-24.

1. Read vents newer than the watermark in `~/.claude/vents.triaged`.
2. Cluster by underlying cause, not by wording.
3. Split output two ways:
   - **Plugin clusters** (skills, workflows, this plugin's hooks) → **one** GitHub issue per
     cluster in `schmug/shipofclaudius`, bodied as a Claude Code prompt per the `/issue` skill.
   - **`~/.claude` clusters** (global `CLAUDE.md`, `settings.json` hooks,
     `hooks/git-push-guard.py`) → summarized in the run report only. **Do not file these.**
     `~/.claude` is not a git repo, and those are guardrail edits requiring Cory's explicit
     approval.
4. Advance the watermark only after step 3 completes.

One issue **per cluster**, never per vent. At a tolerated ~50% false-positive rate, per-vent
filing would move the noise into a tracker that `issue-triage-fanout` actually reads.

---

## 7. Testing

`tests/vent-server.test.mjs`, Node built-ins only, appended to the `&&`-chain in
`package.json`'s `test` script (a suite not listed there never runs in CI). Model it on
`tests/ask-board-hook.test.mjs`.

Required cases:

- `initialize` → `tools/list` → `tools/call` round-trip over the real stdio framing.
- A successful vent appends exactly one parseable JSONL line with the §4.4 fields.
- Rate limit returns `{"recorded": false, "reason": "rate-limited"}` and writes nothing.
- Malformed / missing `text` returns cleanly and does not crash the server.
- An unwritable sink returns `sink-unavailable` and does not throw.
- Absent or failing `git` yields `null` fields rather than hanging.

Per repo convention the suite count only ever goes **up**; do not pin a total anywhere —
`tests/plugin-integrity.test.mjs` fails the build if a count is written into README or
`CLAUDE.md`.

---

## 8. Explicitly out of scope

No severity or category fields. No auto-PR (Lovable has one; at this volume an issue suffices
and a PR needs review anyway). No Slack mirror. No dashboard. **No changes to the question
board or its hook.** No changes to `~/.claude/CLAUDE.md` as part of this work.

---

## 9. Risk and kill criterion

This can fail exactly the way the board did. A tool in the tool list is materially better than
a documented procedure, but it still requires the model to notice friction and choose to fire.
Lovable's volume came from thousands of user projects; this is one developer. Realistic
estimate: **2–5 vents per week**, so a weekly triage may see five vents and two real ones.

**Kill criterion, agreed up front:** if three weeks after install produce **fewer than five
vents total**, the tool is not being reached for. Delete it rather than let it become a second
dead channel. Utilization is self-measuring — the triage run reports counts.

Sanity check on the estimate: the 2026-08-24 session that produced this spec would itself have
generated about two vents — `git-push-guard` blocking a bare force-push it could not resolve a
target for, and the `gh discussion` preview CLI returning `{"discussions":[...]}` where a bare
`.[]` jq path is the obvious and wrong guess.

---

## 10. UNVERIFIED — check these before relying on them

Stated plainly rather than assumed, per the global rule that claims about gates you have not
run are assertions, not observations:

1. **Plugin-bundled MCP server wiring.** That a plugin `.mcp.json` reliably surfaces a tool
   into every session's tool list is assumed, not tested. Verify with a scratch install before
   building the server out.
2. **`plugin-integrity.test.mjs` interaction.** Whether it enforces anything about `.mcp.json`
   or a new top-level key is unknown. Read it; extend it if the new artifact should be covered.
3. **Session id availability.** Whether a plugin-spawned MCP server can see a session
   identifier (env var or otherwise) is unknown. If it cannot, omit the field — do not
   fabricate or approximate one.
4. **Server `cwd`.** A server spawned by the host may not inherit the project directory, which
   would make `cwd`, `repo`, and `branch` wrong rather than merely absent. Confirm before
   trusting those fields; if the cwd is not the project dir, find another source or drop them.
5. **MCP protocol details.** The exact handshake, protocol-version negotiation, and content
   shape for `tools/call` results must be read from the current MCP specification, not from
   recollection.
