# Session-End Concern Capture — Design Spec

**Date:** 2026-08-30
**Repo:** `schmug/shipofclaudius` (canonical source; `~/.claude/` holds runtime state only)
**Status:** Design approved in chat 2026-08-30. Mechanism verified end-to-end the same day (§10).
This doc is the handoff source of truth for a fresh agent.

---

## 0. Why this exists / how to read it

When a session ends with something unresolved — a claim made without running the check, a
scope cut never stated plainly, a doubt about whether the change is right — that concern
currently dies in one local transcript. This builds a capture that fires at wrap-up and puts
it somewhere durable and off-box.

Read §1 before touching anything. This is the third channel in a family of two existing ones,
and the reason it is *separate* from both matters more than any implementation detail.

Everything in §4 is a contract. §10 splits what is **verified by observation** from what is
still assumed — do not promote anything across that line without running the check.

---

## 1. Background — two channels exist, and neither takes this

| Channel | Bar | Sink | Takes a session-end concern? |
|---|---|---|---|
| Question board (`ask-board`) | Three-part gate, self-assessed at write time | Q&A discussions in `schmug/agent-notes` | **No** — fails gate test 3 |
| Vent tool (specced `2026-08-24`, unbuilt) | None; triage-time gate | `~/.claude/vents.jsonl` → weekly triage | **No** — scoped to tooling friction |

The board's gate test 3 is "a future session in different context plausibly could answer it."
A session-end concern fails it by construction: nobody is better positioned than the agent
that just did the work. So the board's design **actively rejects** the category most likely to
matter, and the vent tool is scoped to friction with `~/.claude` and this plugin, not to
doubts about the work product.

The board's measured history is the reason the bar here is zero:

| metric | result |
|---|---|
| `Skill(ask-board)` invocations across 965 transcripts (to 2026-08-24) | **0** |
| SessionStart hook coverage since both fixes landed | 61/61 sessions (100%) |
| Real questions posted 2026-08-08 → 2026-08-28 | **0** |
| Real questions posted 2026-08-29 (single session, #3–#7) | **5** |

Perfect coverage with zero output for three weeks, then five in one day from one session that
happened to hit five unknowns. That is not a bar that works; it is a bar that occasionally
gets walked past. The vent spec drew the correct conclusion — **move the gate from write-time
to triage-time** — and this design applies it to a second category.

**This changes neither existing channel.** The board keeps its gate. Vent keeps its scope and
its local sink. Do not merge any of the three.

---

## 2. Scope decisions (settled in chat 2026-08-30 — do not relitigate)

| Fork | Decision | Rejected, and why |
|---|---|---|
| The bar | **None at write time**; triage decides later | Board-style gate (measured 0/965); narrow "unverified claims only" (leaves non-verification concerns homeless) |
| Locality | **GitHub at session end**, local file only as failure spool | Local JSONL + weekly triage (cluster triage files one issue *per cluster*, and a session-end concern is almost always a singleton — it would be discarded by construction) |
| Sink | **Issues in `schmug/agent-notes`** | The Q&A board itself (the SessionStart hook injects *open* Q&A into every session; a concern is never "answered", so it would accumulate in every future session's context forever); `shipofclaudius` issues (`issue-triage-fanout` reads that tracker — unfiltered volume poisons it); a new repo (splits agent-side records across two places) |
| Trigger | **`type: "prompt"` hook on `Stop`**, every stop | Command hook + daily batch pass (reads transcripts cold, without the reasoning that produced the concern); a `CLAUDE.md` rule alone (this is exactly the 0/965 design) |
| Classification at write time | **None** — one sink, routing happens at triage | Agent picks board-vs-issue-vs-vent at wrap-up (re-introduces the self-assessed gate that failed) |

---

## 3. Architecture

```
                    agent finishes its turn
                              │
                              ▼
              Stop hook (type: "prompt") evaluates
              a stopping CONDITION against the transcript
                              │
              ┌───────────────┴────────────────┐
        ok: true                          ok: false
      (nothing open, or                 (something open and
       already filed)                    not yet filed)
              │                                │
              ▼                                ▼
        session stops              reason is fed back to the agent
                                               │
                                               ▼
                                   agent files ONE issue in
                                   schmug/agent-notes  ── on gh failure ──▶
                                               │                  ~/.claude/concerns-spool.jsonl
                                               ▼                  (drained on next success)
                                    next Stop check passes
                                               │
                                               ▼
                                         session stops
                              │
                              ▼
                  weekly scheduled triage routes onward:
                  durable unknown → Q&A board post
                  tooling friction → vent log (once built)
                  real defect      → issue in the working repo
                  else             → close
```

The loop is **self-closing**: the condition becomes true once the filing has happened, and the
transcript is the state. No sentinel file, no counter.

Three units, independently testable: the hook (a condition string), the sink (an issue
format + a spool fallback), the triage task (a prompt). The hook must not know anything about
triage.

---

## 4. Contract

### 4.1 The trigger — and its semantics are not what the docs say

A `type: "prompt"` hook on `Stop` is **not** a free-form evaluator. Verified 2026-08-30: the
harness wraps the configured prompt as

> "Based on the conversation transcript above, has the following stopping condition been
> satisfied? Answer based on transcript evidence only.
>
> Condition: `<your prompt>`"

and the evaluating model returns `{"ok": boolean, "reason": string}`. On `ok: false` the stop
is blocked and `reason` is fed back to the main agent as `Stop hook feedback:`.

**Consequence for authoring:** the prompt MUST be phrased as a *condition on the transcript*,
never as an instruction. An imperative gets evaluated as though it were a condition and
produces nonsense — in the command-hook probe an imperative block reason ("reply with exactly
the word BANANA") produced the reply *"Understood. I'll reply with BANANA if I'm about to
stop"*, i.e. the agent logged the rule instead of acting on it.

The condition, verbatim:

> Either this session surfaced nothing unresolved, or every unresolved item has already been
> filed this session — via `gh issue create` against `schmug/agent-notes`, or appended to
> `~/.claude/concerns-spool.jsonl` after a failed `gh` call. Unresolved means: a completion
> claim resting on a check that was never actually run, a scope reduction not stated plainly
> to the user, a question raised and never answered, or a doubt about whether the change is
> correct. Default to satisfied — if nothing clearly unresolved stands out, the condition is
> met.

`Default to satisfied` is load-bearing. The failure mode of a per-stop model check is nagging,
not silence; a hook that blocks routine sessions will be disabled within a week.

### 4.2 The block-feedback path

The agent, on receiving the reason, files **one issue per session** — not one per concern.
Five issues out of one session is what the board produced on 2026-08-29 and it is the wrong
shape for review.

```
Title:  concerns: <repo-or-cwd> <YYYY-MM-DD>
Labels: concern
Body:   - [ ] <concern one>
        - [ ] <concern two>

        Session: <session_id>
        Transcript: <transcript_path>
```

`session_id` and `transcript_path` both arrive in the hook input (§4.3) but the agent has them
from its own context; nothing needs to be threaded through the hook.

### 4.3 Stop hook input — observed, not assumed

Captured from a real run (§10). The keys present:

```
background_tasks   cwd                hook_event_name    last_assistant_message
permission_mode    prompt_id          session_crons      session_id
stop_hook_active   transcript_path
```

**There is no `reason` field.** `plugin-dev/skills/hook-development/SKILL.md` states that
Stop/SubagentStop hooks receive `reason`; that is wrong as of 2.1.251. It also documents only
two hook types where the binary's own triage text lists three — `"command"`, `"prompt"`, or
`"agent"`. Treat that SKILL as a starting point, not a reference.

### 4.4 Loop guard

`stop_hook_active` is the guard, and it behaves exactly as named — observed `False` on the
first Stop evaluation and `True` on the one following a block. The binary's guidance string:

> For Stop/SubagentStop hooks, check `stop_hook_active` in the input and return success while
> it's true. Set `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` to raise this limit.

A prompt hook does not read the input directly, so it cannot check `stop_hook_active` itself.
It does not need to: the condition goes true once the filing lands, so the loop closes on its
own. `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` remains the backstop if it does not — which is the
failure mode to watch for in the first week.

### 4.5 Never fail the turn

The `gh` call can fail: offline, expired auth, rate limit, repo unreachable. On any failure the
agent appends the concern to `~/.claude/concerns-spool.jsonl` and continues. It must not retry
in-session, must not escalate, and must not surface the failure as an error. A silent loss
window is the one outcome this design may not have; a delayed write is fine.

Spool line schema — one JSON object per line, single `O_APPEND` write so concurrent sessions
interleave cleanly:

```json
{"ts":"<ISO8601>","session":"<id>","cwd":"<path>","repo":"<owner/name|null>","concerns":["…"]}
```

Drained by the next session-end write that succeeds, and by the weekly triage as a backstop.

---

## 5. Sink

`schmug/agent-notes`, issues. Verified 2026-08-30: `has_issues` is **true** (it did not need
enabling — an earlier GraphQL read reported `false` and was contradicted by REST on the same
repo minutes later; REST and GraphQL now agree on `true`. The discrepancy is unexplained and
noted here rather than rationalised). `gh issue list -R schmug/agent-notes` returns cleanly.

Issues, not discussions, for three reasons: they close (a concern has a lifecycle), nothing
automated reads that repo's issues (so unfiltered volume is inert), and it keeps the Q&A
category — and therefore every future session's injected context — untouched.

---

## 6. Triage

A scheduled task, weekly, following the `board-utilization-audit` pattern.

1. Read open `concern`-labelled issues in `schmug/agent-notes`, plus any spool backlog.
2. Route each item onward: durable unknown → Q&A board post; tooling friction → vent log
   (once that exists); real defect → issue in the working repo, bodied per `/issue`; nothing
   actionable → close with a one-line reason.
3. Close the session issue when every box is routed or dismissed.

Routing is the triage's whole job. The agent never classifies at write time (§2).

---

## 7. Testing

`tests/session-end-concerns.test.mjs`, Node built-ins only, appended to the `&&`-chain in
`package.json`'s `test` script — a suite not listed there never runs in CI. Model it on
`tests/ask-board-hook.test.mjs`.

Required cases:

- The condition string is present in `hooks/hooks.json`, is `type: "prompt"`, is bound to
  `Stop`, and contains the `Default to satisfied` clause (a content contract — removing that
  clause is the regression that turns this into a nag).
- The issue body renders as a checklist with one box per concern.
- A simulated `gh` failure appends exactly one parseable spool line with the §4.5 fields and
  does not throw.
- The spool drains on the next successful write and is left untouched on a failed one.
- Concurrent appends from two writers produce two intact lines.

Per repo convention the suite count only ever goes **up**; do not pin a total anywhere —
`tests/plugin-integrity.test.mjs` fails the build if a count is written into README or
`CLAUDE.md`.

---

## 8. Explicitly out of scope

No severity or category fields. No per-concern issues. No changes to the question board, its
gate, or its hook. No changes to the vent spec or its sink. No changes to
`~/.claude/CLAUDE.md` as part of this work. No auto-PR. No dashboard.

---

## 9. Risk and kill criterion

Two failure modes, opposite directions:

- **Nagging.** A per-stop model check that blocks routine sessions gets disabled. The
  `Default to satisfied` clause and the first-week block-rate measurement exist for this.
- **Silence.** The condition is evaluated by a model, so it can simply decide nothing was
  unresolved, every time — the board's failure mode wearing a hook.

Cost is real and recurring: **one model call per stop, on every session.** Observed latency in
the probe was roughly 2–4s added to wrap-up.

**Kill criterion, agreed up front:** if three weeks produce **fewer than five filed concerns**,
the check is not finding anything and should be deleted rather than left as a third dead
channel. If the block rate exceeds roughly one session in three, the condition is too eager —
tighten the wording before disabling the hook.

---

## 10. Verified 2026-08-30, and what is still open

Verified against Claude Code **2.1.251** (note the drift: the vent spec pins 2.1.241) using a
scratch harness under `--settings`, plus string extraction from the shipped binary. The
harness lives in this session's scratchpad and is disposable.

**Confirmed by observation:**

1. **A `Stop` hook's `{"decision":"block","reason":"…"}` re-invokes the main agent and the
   reason reaches the model.** A command hook that blocked once fired exactly twice and the
   model's next message responded to the reason's content.
2. **`stop_hook_active` is the loop guard.** Observed `False` on the first Stop evaluation and
   `True` on the post-block one, in the captured hook stdin.
3. **`type: "prompt"` runs on `Stop`**, wrapped as a stopping-condition check returning
   `{"ok", "reason"}`; `ok: false` blocks and feeds `reason` back. Both branches observed in a
   single run via `--debug-file`.
4. **Stop hook input keys** are as listed in §4.3, with no `reason` field.
5. **`schmug/agent-notes` accepts issues** — `has_issues: true`, `gh issue list` clean.

**Still open — check before relying on these:**

1. **`type: "prompt"` loaded from a plugin `hooks/hooks.json`.** Verified only via
   `--settings`. Plugin load is a different path; confirm with a scratch install as the first
   implementation step. Every shipped example of a prompt hook in this repo's ecosystem is
   `type: "command"`, so this is the one genuinely unproven mechanism.
2. **Whether the prompt hook sees the full transcript or a window of it.** The wrapper says
   "the conversation transcript above" and the probe's transcript was two messages long. A
   long session may present the evaluator with a truncated view, which would bias it toward
   `ok: true` — silence, the §9 failure mode. Measure on a real session before trusting the
   block rate.
3. **Interaction with the `Stop` hook already running in this environment.** Debug output
   showed a second `Hook Stop (Stop) success` emitting a metrics payload
   (`skip_reason`, `diff_strategy_v2`) from something already installed. Multiple Stop hooks
   evidently coexist, but ordering and whether one can suppress another was not established.
4. **The `"agent"` hook type.** The binary lists it alongside `command` and `prompt`; it is
   undocumented locally and unexamined. It may be a better fit than `prompt` for this job —
   worth ten minutes before building.

**A note on drift.** This spec pins behaviour against Claude Code `2.1.251`. The prompt-hook
wrapper text in §4.1 is an internal implementation detail observed through `--debug-file`, not
a published contract; if the wrapper changes, the condition wording in §4.1 is what needs
re-testing first.
