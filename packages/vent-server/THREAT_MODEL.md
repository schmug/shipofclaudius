# Threat model — `packages/vent-server`

Written for the next agent editing this server. It records *why* the code is shaped the
way it is, so a later "simplification" does not quietly remove a control. Authoritative
design is `docs/specs/2026-08-24-vent-tool-design.md` §4.4–§4.6 and §5.

## What this thing is

An MCP stdio server the host spawns once per session, exposing one tool, `vent`, whose
entire input is `{text}`. It appends one JSON line per vent to `~/.claude/vents.jsonl`.
A weekly triage task (out of scope here, spec §6) later reads that file and files issues.

## Trust boundaries

| Party | Trust | Reaches |
|---|---|---|
| The **agent** calling `vent` | **untrusted** — it is a model, and its text may itself be attacker-influenced | `params.arguments.text`, and the *timing and count* of calls |
| The **host** spawning the server | trusted | argv, environment (`CLAUDE_PROJECT_DIR`, `CLAUDE_CODE_SESSION_ID`, `VENT_SINK`) |
| The **local filesystem** | trusted | `~/.claude/vents.jsonl` |
| The **downstream triage reader** | consumer of everything above | every line of the sink |

The agent is the only untrusted party with a live channel. Everything it can influence
is one string and a call rate. That framing is what the controls below are sized to.

## Invariants and the controls that hold them

### 1. A vent never errors into a session

All four outcomes an agent can cause — `recorded`, `rate-limited`, `sink-unavailable`,
`invalid-input` — return `isError: false` and no JSON-RPC `error`. MCP reserves
`isError: true` for tool-execution errors a model should self-correct from; a dropped
vent is information, not a fault to retry, and flagging it invites the retry storm the
rate limiter exists to stop. JSON-RPC errors stay reserved for genuine protocol faults
(unknown tool `-32602`, unknown method `-32601`).

Availability, not confidentiality, is the property at risk here: a vent that fails loudly
trains agents to stop calling it, and the tool's whole value is that it gets called.

- Held by: `callVent` in `server.mjs`; `appendVent` never throwing (`sink.mjs`);
  `captureContext` degrading to `null` (`context.mjs`); `index.mjs` answering a thrown
  handler on an id-bearing request with `-32603` rather than dropping the request.
- Tested by: `EVERY outcome an agent can cause sets isError:false` (asserts all four
  outcomes are distinct, so a fifth cannot be added without updating it), plus
  `a malformed tools/call always draws a reply, never a silent drop`.

### 2. Resource exhaustion is bounded — and refusing is cheap

MCP's Security Considerations make rate limiting a **MUST** for tool invocations. The
concrete failure is on record: an agent fired 43 vents from one project during an
apology spiral.

- 1 vent per 90 s (`RATE_WINDOW_MS`) and 10 per session (`MAX_PER_SESSION`).
- The refusal is decided **before** the record is built and before the sink is touched,
  so a refused vent costs one clock read. A limiter that still writes is not a limiter.
- Quota tracks records *written*, not calls *attempted*: a `sink-unavailable` result
  consumes nothing, so a broken disk cannot also burn the session's ten vents.
- Per-session state is process-lifetime state because the host spawns one server per
  session. A pooled or reused process would silently widen the cap — check this
  assumption before changing how the server is launched.

Residual: `text` length is uncapped, so the worst case is 10 large writes per session.
Bounded by the per-session cap and deliberately not capped further here — the design spec
specifies no limit, and truncating a vent silently is its own kind of dishonesty. If the
sink ever grows unreasonably, cap it in the spec first.

### 3. An agent cannot forge a sink record

The sink is machine-read line-by-line by triage. Two ways a vent could lie to that reader,
both closed:

- **Line injection.** A newline inside `text` would let one call plant a second, fully
  formed "vent". `JSON.stringify` escapes it, so one record is always exactly one line.
  Tested by `a vent text carrying newlines cannot forge a second JSONL record`.
- **Field forgery.** The record is assembled field by field from the clock and
  `deps.context()` — never spread from `args` — so `{text, ts, session, repo}` puts only
  `text` in the file. A vent cannot backdate itself or blame another session or repo.
  Tested by `agent-supplied fields other than text never reach the sink record`.

`text` itself is agent-authored and stays untrusted **downstream**: whatever reads
`vents.jsonl` must treat every `text` as data, never as instructions. That is a
requirement on the triage task (spec §6), not something this server can enforce.

### 4. Context capture cannot be turned into execution

`context.mjs` shells out to `git`. It is safe because none of it is agent-reachable:

- `execFileSync` runs `git` directly with **no shell**, so arguments are arguments.
- The argv is two fixed literal arrays; nothing from `args` is interpolated.
- `cwd` comes from `CLAUDE_PROJECT_DIR`, set by the trusted host before any agent runs.
- `timeout: 1000` bounds a hanging git, `stdio: ['ignore','pipe','ignore']` keeps its
  stderr out of the JSON-RPC stream on stdout, and any failure degrades to `null`.

Do not let a future field derive its command, arguments, or cwd from tool input.

### 5. The sink path is host-controlled, not agent-controlled

`VENT_SINK` overrides the sink. It is read from the **server's own environment**, which
the host fixes at spawn time; the tool's input schema has exactly one property and the
path never derives from it. Anyone able to set that variable already controls the
process, so it grants no escalation. It exists so the suite can drive the real entry
point end-to-end without appending to the operator's `~/.claude/vents.jsonl`, and so CI
— which has no `~/.claude` — exercises the real wiring rather than a permanent
`sink-unavailable`.

## Not in scope here

The weekly triage task and its watermark (spec §6, gated on Cory's approval since it
lives under `~/.claude/`), and the modern `2026-07-28` protocol era (n3, #143).
