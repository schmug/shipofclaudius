# Agent Vent Tool — Design Spec

**Date:** 2026-08-24
**Repo:** `schmug/shipofclaudius` (canonical source; `~/.claude/` is versioned separately in
`schmug/dotclaude` as of 2026-08-30)
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
        ONE issue per cluster in            ONE issue per cluster in
        schmug/shipofclaudius               schmug/dotclaude
                                            (guardrail edits still need
                                             Cory's approval to land)
```

Three units, each independently testable: the server (pure I/O contract), the sink (a file
format), the triage task (a prompt). The server must not know anything about triage.

---

## 4. Contract — the vent tool

### 4.1 Server — dual-era, and this is not optional

MCP's **current** revision is **2026-07-28**, which **removed the `initialize` handshake
entirely**. The spec's own terminology:

- **Modern** (`2026-07-28` and later): stateless. There is no handshake. Every request
  carries its version in `_meta` (`io.modelcontextprotocol/protocolVersion`,
  `io.modelcontextprotocol/clientInfo`, `io.modelcontextprotocol/clientCapabilities`).
  `server/discover` is a **mandatory** RPC. A version the server does not support **MUST**
  be rejected with `UnsupportedProtocolVersionError` (code `-32022`) whose `data.supported`
  lists what it does speak.
- **Legacy** (`2025-11-25` and earlier): the session-establishing `initialize` handshake.

**Claude Code 2.1.241 is a legacy client.** Verified empirically 2026-08-28: it sends
`initialize` with `protocolVersion: "2025-11-25"`, then `notifications/initialized`, then
`tools/list`.

The spec's compatibility matrix therefore decides the design:

| Server we build | Works with Claude Code today | Survives Claude Code going modern |
|---|---|---|
| Legacy-only | yes | **no** |
| Modern-only | **no** — legacy clients have no fall-forward mechanism | yes |
| **Dual-era** | **yes** | **yes** |

**Build dual-era.** The spec blesses it: a dual-era server MAY serve both eras concurrently
in the same process. The selection rule is the client's opening move — a request carrying
modern `_meta` is served statelessly per 2026-07-28; an `initialize` request selects legacy
semantics for that stdio process.

**Node built-ins only.** This repo has zero npm dependencies, intentionally no lockfile, and
CI runs `npm test` with no install step (see `CLAUDE.md`). `@modelcontextprotocol/sdk` is
therefore **not available** — the JSON-RPC framing is hand-rolled. This is protocol plumbing,
not a security primitive, so hand-rolling does not conflict with the global rule about using
vetted libraries for crypto/JWT.

### 4.1.1 Wire contract, verified

Newline-delimited JSON-RPC 2.0 over stdio, both eras.

**Legacy path** (exercised end-to-end against Claude Code 2.1.241 on 2026-08-28):

| in | out |
|---|---|
| `initialize` `{protocolVersion:"2025-11-25", capabilities:{roots,elicitation}, clientInfo:{name:"claude-code"}}` | `{protocolVersion:<echo>, capabilities:{tools:{}}, serverInfo:{name,version}}` — echoing the client's version back was **accepted** |
| `notifications/initialized` — **no `id`** | **do not reply** |
| `tools/list` | `{tools:[{name, description, inputSchema}]}` |
| `tools/call` `{name, arguments}` | `{content:[{type:"text", text}]}` |

**Modern path** (per spec; not yet exercisable — no modern client to test against):

- `server/discover` — mandatory; returns supported versions, capabilities, identity.
- Results additionally carry `resultType: "complete"`; `tools/call` results carry `isError`.
- Unsupported version → `-32022` with `data.supported`.

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
| `cwd` | **`CLAUDE_PROJECT_DIR`** env var — set by the host and unambiguous. `process.cwd()` was verified to match it, but prefer the env var. |
| `repo` | `git config --get remote.origin.url` resolved to `owner/name`, **normalized** (below), or `null` |
| `branch` | `git rev-parse --abbrev-ref HEAD`, or `null` |
| `session` | **`CLAUDE_CODE_SESSION_ID`** — verified present and per-session (a child session carried its own id, distinct from the parent's), not inherited |

Git lookups must be best-effort and time-bounded: a slow or absent git must degrade to `null`,
never hang the tool call.

Every context field is **string-or-null and never absent** — including when capture itself
throws. A record missing `repo` entirely is not the same statement as one saying `repo: null`,
and only the second is legible to the triage reader as "unknown" (#159).

**Normalizing `repo` — decided in #160.** `repo` is a **grouping key**: the weekly triage
buckets records by it, so it is normalized rather than stored as typed. A trailing slash is
stripped, and `owner/name` is **case-folded on every host, unconditionally**.

Host-dependent case sensitivity is the deciding factor, and it cuts both ways. GitHub — where
every real remote here points — treats `owner/name` case-insensitively, so `schmug/x`,
`schmug/x/` and `Schmug/X.git` are one repo and must not become three buckets. A
case-sensitive host (a self-hosted forge, or a bare remote on a case-sensitive filesystem)
can genuinely serve `Foo/bar` and `foo/bar` as two repositories, and folding merges them.

Unconditional folding accepts that second error to eliminate the first. The trade is
deliberate: this key groups a personal digest and carries no security weight, so one
mis-grouped row is the entire downside — whereas per-host folding would need a
known-case-insensitive hostname allowlist that rots silently every time a forge is added.
Pinned by `parseRepo folds case on EVERY host` in `tests/vent-server.test.mjs`.

### 4.5 Rate limiting (build this on day one)

Two independent reasons, so this is not negotiable. The MCP spec's Security Considerations
state that servers **MUST** "rate limit tool invocations" — it is a normative requirement, not
a nicety. And Lovable shipped theirs only after an agent fired 43 vents from one project while
spiralling into apologies.

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

Carried in a text content block (plus `structuredContent` on the modern path, where it is the
spec-blessed way to return a JSON value; mirror it in a text block for compatibility).

**All four outcomes set `isError: false`.** The spec reserves `isError: true` for *tool
execution errors* — actionable feedback a model should self-correct from. A vent that was not
recorded is none of those; it is information, and flagging it as an error would invite exactly
the retry behaviour §4.6 exists to prevent. `recorded: false` is a calm outcome. Nothing in the
response should suggest the agent ought to try again, escalate, or tell the user.

Reserve JSON-RPC errors (`-32602` etc.) for genuine protocol faults — unknown tool, malformed
request envelope — per the spec's two-mechanism error taxonomy.

---

## 5. Sink format

`~/.claude/vents.jsonl` — append-only, one JSON object per line, schema per §4.4. Runtime
state lives in `~/.claude` (alongside `scripts/board-audit.py`), never in this repo.

Append with a single small `O_APPEND` write so concurrent sessions interleave cleanly rather
than corrupting lines. Never read-modify-write the file from the server.

Two consequences of "the reader is line-by-line", both settled in #159:

- **A write that ends short must not corrupt its successor.** `write(2)` may accept fewer
  bytes than offered and still report success, leaving a fragment with no terminator that
  the next append runs onto — one unparseable line, *two* records lost. Compare the returned
  byte count against the buffer length and, when short, write a lone `\n` through the same
  fd to close the damaged line before reporting failure. Never truncate back to the
  pre-write size: under `O_APPEND` those trailing bytes may belong to another session.
- **The default sink must be absolute or absent.** `os.homedir()` returns `''` where there
  is no `HOME` and no passwd entry, and `join('', '.claude', 'vents.jsonl')` is a *relative*
  path that resolves inside any working tree with a `.claude/` directory. With no absolute
  home there is no default sink: refuse, and let it surface as `sink-unavailable`.

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
     `hooks/git-push-guard.py`) → **one** GitHub issue per cluster in `schmug/dotclaude`,
     same prompt-shaped body. Filing an issue is a *proposal*, not an edit: a guardrail
     change — `settings.json` permissions/hooks, rulesets, global `CLAUDE.md` — still needs
     Cory's explicit approval before it lands, and `main` there carries a ruleset requiring a
     PR plus the `checks` status check.
4. Advance the watermark only after step 3 completes.

> **Revised 2026-09-02.** Step 3 originally routed `~/.claude` clusters to the run report and
> never filed them, justified by "`~/.claude` is not a git repo". That stopped being true on
> 2026-08-30, when `schmug/dotclaude` versioned the directory in place (`d74ae0c`, allowlist
> `.gitignore`; `has_issues: true` and `gh issue list` verified 2026-09-02). The approval
> requirement on guardrail edits is unchanged — it never depended on versioning.

One issue **per cluster**, never per vent. At a tolerated ~50% false-positive rate, per-vent
filing would move the noise into a tracker that `issue-triage-fanout` actually reads.

---

## 7. Testing

`tests/vent-server.test.mjs`, Node built-ins only, appended to the `&&`-chain in
`package.json`'s `test` script (a suite not listed there never runs in CI). Model it on
`tests/ask-board-hook.test.mjs`.

Required cases:

- **Legacy era:** `initialize` → `notifications/initialized` (asserting **no reply** is
  emitted) → `tools/list` → `tools/call`, over the real stdio framing.
- **Modern era:** `server/discover` returns supported versions; a request bearing modern
  `_meta` is served without any handshake; an unsupported version yields `-32022` with a
  populated `data.supported`.
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

## 10. Verified 2026-08-28, and what is still open

A throwaway built-ins-only server was run under `--mcp-config --strict-mcp-config` against a
real session, plus a hand-driven JSON-RPC client. The probe artifacts were deleted; the
findings are folded into §4.

**Confirmed:**

1. **A `.mcp.json` server is spawned, initialized, and its tools enumerated** into a real
   session. `MCP_CONNECTION_NONBLOCKING=true` is set by the host, so a slow server does not
   stall session start — which is what makes §4.6's "never slow a session" guarantee hold.
2. **`plugin-integrity.test.mjs` has no `.mcp.json` handling**, so adding one breaks nothing.
   The plugin manifest has no `mcpServers` key; the mechanism is a root-level `.mcp.json`,
   `{"mcpServers": {...}}`, with `${CLAUDE_PLUGIN_ROOT}` templating (shipped and working in
   the discord, fakechat, and telegram plugins).
3. **`CLAUDE_CODE_SESSION_ID` and `CLAUDE_PROJECT_DIR` are both present** in the server's
   environment. Session id is genuinely per-session, not inherited from a parent.
4. **The legacy wire contract in §4.1.1 was exercised end-to-end**, including the detail that
   echoing the client's `protocolVersion` back is accepted, and that
   `notifications/initialized` carries no `id` and must not be answered.

**Still open — check before relying on these:**

1. **Plugin-bundled stdio, end to end.** The probe used `--mcp-config`, not a plugin-bundled
   `.mcp.json`. Plugin-bundled is proven only indirectly: `plugin:stripe:stripe` is live in a
   real session (but is `type: http`), and three shipped plugins use stdio +
   `${CLAUDE_PLUGIN_ROOT}`. Confirm with a scratch install as the first implementation step —
   it is now a one-minute check, not an open risk.
2. **The modern (2026-07-28) path cannot be exercised yet.** No modern client is available to
   test against; Claude Code 2.1.241 is legacy. The modern half of the dual-era server is
   therefore written to spec, not to observation, and must be labelled as such until a modern
   client exists. Do not claim it is verified.
3. **`server/discover`'s exact result shape** was not read in full during the spike. Read
   `/specification/2026-07-28/server/discover` before implementing it; it is a MUST for the
   modern path.

**A note on drift.** This spec pins behaviour against MCP `2026-07-28` (current as of
2026-08-28) and Claude Code `2.1.241`. The legacy era is on a deprecation path by
construction. If Claude Code starts sending modern `_meta`, the legacy branch becomes dead
code — that is the signal to delete it, not to keep both forever.
