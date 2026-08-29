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
| The **host** spawning the server | trusted | argv, environment (`CLAUDE_PROJECT_DIR`, `CLAUDE_CODE_SESSION_ID`, `VENT_SINK`), and the JSON-RPC envelope — the method, and `params._meta` (the protocol era, §6) |
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
(unknown tool `-32602`, unknown method `-32601`, unsupported protocol version `-32022`).

None of those three is agent-reachable. `-32602` and `-32601` name a method or tool the
agent does not choose, and `-32022` answers `params._meta`, which the **client** writes
into the envelope — the agent supplies `arguments.text` and nothing else. So a protocol
error means the host and this server disagree, never that a vent was rejected.

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
- The two limits bound **different things**, and advance at different points:
  - The **window** bounds *invocations*. Its stamp is taken before the sink is touched,
    so a sink that cannot be written still refuses the next 90 s of calls. This matters
    because a `sink-unavailable` result is the one refusal decided *after* the record is
    built — it costs a `deps.context()` call, i.e. two `git` subprocesses. Stamping only
    on a successful write would leave an unwritable sink (full disk, read-only home, bad
    `VENT_SINK`, CI with no `~/.claude`) completely unbounded; 43 back-to-back vents then
    cost ~710 ms of real git work and zero refusals. Pinned by `an unwritable sink does
    not remove the 1-per-window bound on invocations`.
  - The **per-session quota** bounds *records written*, not calls attempted, so a broken
    disk still cannot burn the session's ten vents.
- An `invalid-input` or `rate-limited` refusal is decided before the record is built and
  before the sink is touched, so it costs one clock read. A limiter that still writes is
  not a limiter.
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
  `text` in the file, and the context spread is applied *first* so no context field can
  shadow `ts` or `text`. Tested by `agent-supplied fields other than text never reach the
  sink record` (the input half) and `a context field can never shadow the clock or the
  agent text` (the ordering half — it feeds a context that actually collides, and goes red
  if the spread order is reverted).

**Scope of that claim — read this before trusting a record.** What is closed is the
tool's *input surface*: nothing an agent passes to `vent` can set `ts`, `session`, `repo`
or `branch`. **No field in the record is authenticated** beyond that. An agent with Bash
can run `git remote set-url origin …` or `git checkout -b …` before venting, and `repo`
and `branch` are read straight from that working tree (`context.mjs`); an agent with file
write can append a fully forged line to `vents.jsonl` without going through this server at
all. Triage (spec §6) should treat records as *self-reported*, not as attested provenance.

`text` itself is agent-authored and stays untrusted **downstream**: whatever reads
`vents.jsonl` must treat every `text` as data, never as instructions. That is a
requirement on the triage task (spec §6), not something this server can enforce.

### 4. Context capture cannot be turned into execution

`context.mjs` shells out to `git`. It is safe because none of it is agent-reachable:

- `execFileSync` runs `git` directly with **no shell**, so arguments are arguments.
- The argv is two fixed literal arrays; nothing from `args` is interpolated.
- `cwd` comes from `CLAUDE_PROJECT_DIR`, set by the trusted host before any agent runs.
- `timeout: 1000` bounds a hanging git, `stdio: ['ignore','pipe','ignore']` keeps its
  stderr out of the JSON-RPC stream on stdout, and any failure degrades to `null`. Note
  the two calls are **sequential**, so the worst-case added latency for a recorded vent
  is ~2 s, not 1 s.
- **Forward-looking:** the working tree `git` runs in may itself be untrusted (a
  tarball-shipped `.git/config` is attacker-authored). Safe today because `config --get`
  and `rev-parse` do not refresh the index, so `core.fsmonitor` never fires and no hook
  runs. A future context field must not use an index-refreshing subcommand (`status`,
  `diff`, `add`) — that would hand execution to the tree being inspected.

Do not let a future field derive its command, arguments, or cwd from tool input.

### 5. The sink path is host-controlled, not agent-controlled

`VENT_SINK` overrides the sink. It is read from the **server's own environment**, which
the host fixes at spawn time; the tool's input schema has exactly one property and the
path never derives from it. Anyone able to set that variable already controls the
process, so it grants no escalation. It exists so the suite can drive the real entry
point end-to-end without appending to the operator's `~/.claude/vents.jsonl`, and so CI
— which has no `~/.claude` — exercises the real wiring rather than a permanent
`sink-unavailable`.

### 6. Serving two eras widens the shape, not the surface

`handle` speaks both the legacy `2025-11-25` handshake and the modern `2026-07-28`
stateless era (design spec §4.1). The selector is `params._meta`
(`io.modelcontextprotocol/protocolVersion`): present and supported means modern, absent
means legacy, present and unsupported means `-32022` with `data.supported`.

- The selector lives in the **envelope**, which the client writes. It is not the tool's
  input schema — that still has exactly one property, `text` — so nothing an agent
  passes to `vent` can pick an era, forge a version, or provoke a rejection.
- The version gate runs **in front of method dispatch**, so a request naming a version
  we do not speak never reaches `callVent`, never spends a `deps.context()`, and never
  touches the sink. Pinned by `an unsupported version is refused BEFORE the tool runs`.
- A rejection is answered only when the request bears an `id`. A notification carrying a
  bad version draws nothing — replying to one is a protocol violation, and the gate is
  the one place that could reintroduce it. Pinned by `a version rejection never replies
  to a notification`.
- The era changes the result **shape** only: modern adds `resultType: 'complete'` and
  mirrors the same payload into `structuredContent`, exposing no field the text block
  did not already carry. Legacy results must stay free of both — Claude Code 2.1.241 is
  a legacy client, so that is the era carrying real traffic. Pinned by `legacy results
  carry NO modern-only fields`.

**Written to spec, never observed.** No modern client exists to test against. Everything
above proves our replies match the published shapes; none of it is evidence that a
client accepted one. Do not restate it as verified end-to-end.

## Not in scope here

The weekly triage task and its watermark (spec §6, gated on Cory's approval since it
lives under `~/.claude/`).
