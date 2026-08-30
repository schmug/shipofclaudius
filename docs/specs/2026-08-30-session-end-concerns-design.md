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
| Vent tool (**shipped** — #151, #152, #153) | None; triage-time gate | `~/.claude/vents.jsonl` → weekly triage | **No** — scoped to tooling friction |

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
| Trigger | **`type: "prompt"` hook on `Stop`**, every stop | Command hook + daily batch pass (reads transcripts cold, without the reasoning that produced the concern); a `CLAUDE.md` rule alone (this is exactly the 0/965 design); **`type: "agent"` hook** (see below) |

**Why not the `agent` hook type.** It was the strongest alternative and was tested, not dismissed
(§10). An agent hook runs a real agent *with tools*, so it could file the issue itself instead of
blocking and delegating to the main agent — attractive, because it does not depend on the main
agent complying. It loses on measured cost and failure profile:

| | `prompt` | `agent` |
|---|---|---|
| Per-evaluation latency (observed) | ~2–4s | ~13–16s |
| Tools | none | yes, but **denied by default in `-p`/"don't ask" mode** |
| Unsatisfiable condition | loops to the block cap | loops to the block cap, at 4× the cost |
| Determinism on a one-step task | n/a | took **3** evaluations to do one `echo` |

The tool-permission dependency is the decisive one: unattended runs (cron routines, `/loop`) are
exactly where this capture matters most, and that is precisely where the hook agent's tools are
denied unless an allow-rule is pre-granted. Since the main agent needs the same
`Bash(gh issue create:*)` allow-rule anyway, the agent type buys nothing there and costs 4× per
stop. Revisit only if main-agent non-compliance shows up in practice.
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
                  tooling friction → the vent tool
                  real defect      → issue in the working repo
                  else             → close
```

The loop closes when the condition goes true — the transcript is the state, so there is no
sentinel file and no counter. It is **not** unconditionally self-closing: if the filing never
happens the hook blocks again, up to the block cap (§4.4).

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
It closes on its own **only if the filing actually happens** — and that is a weaker guarantee
than it first appears. If `gh` is unauthenticated, or the agent simply does not comply, the
condition stays false and the hook blocks again.

Measured: an unsatisfiable condition ran **9 evaluations** before the cap released it, taking
about two minutes and producing **no session output at all**. That is the real runaway profile,
and it applies to `prompt` and `agent` alike. `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` is the only hard
backstop.

Two mitigations, both required:

1. The condition's escape hatch (§4.1) counts a *spooled* concern as satisfying it, so a failed
   `gh` call still terminates the loop on the next evaluation.
2. The condition must be satisfiable by an agent that has decided there is nothing to file. The
   `Default to satisfied` clause is what makes "I looked and found nothing" a valid exit.

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

A scheduled task, weekly, following the `board-utilization-audit` pattern. Written to
`~/.claude/scheduled-tasks/concern-triage/SKILL.md` (runtime state — `~/.claude` is not a git
repo, so it lives outside this repo by necessity).

**Writing the file does not schedule it.** Registration is a separate step via
`mcp__scheduled-tasks__create_scheduled_task`; an unregistered directory is inert and several
already exist in this environment. As of 2026-08-30 this one is **written but unregistered**,
pending approval — a recurring task is persistent configuration.

1. Read open `concern`-labelled issues in `schmug/agent-notes`, plus any spool backlog.
2. Route each item onward: durable unknown → Q&A board post; tooling friction → the vent
   tool; real defect → issue in the working repo, bodied per `/issue`; nothing
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

Three failure modes:

- **A block derails the session's closing message.** Observed in *both* probes: with a command
  hook the final message became *"Understood. I'll reply with BANANA if I'm about to stop"*, and
  with an agent hook it became *"3. Adjust hook conditions… Which approach would you prefer?"* —
  in each case the user's actual answer was replaced by hook-loop chatter. This is the cost every
  time the hook fires, so a hook that blocks often is not merely slow, it is destructive to the
  session's output. It is the strongest argument for `Default to satisfied`.

The other two point in opposite directions:

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
6. **`type: "agent"` also runs on `Stop`, and has real tools.** With
   `permissions.allow: ["Bash(echo:*)","Write"]` the hook agent created a file on disk and the
   condition then reported met. Without allow-rules it reported *"both Bash and Write tools are
   blocked in 'don't ask' mode"*.
7. **The bundled hook documentation is wrong about both LLM types.** It states that `prompt` and
   `agent` are *"Only available for tool events: PreToolUse, PostToolUse, PermissionRequest."*
   Both were observed running on `Stop`, and `prompt` has a `Stop`-specific wrapper (§4.1) that a
   tool-events-only feature would not have.
8. **The default block cap is NOT a fixed number.** Two unsatisfiable-condition runs on the
   default produced **9** and **14** evaluations. Do not encode either as a constant.
9. **The cap CAN be lowered.** `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP=2` produced 3 evaluations
   against the same unsatisfiable condition that ran to 14 unset. The binary documents the
   variable as raising the limit; it lowers it too. **This is the runaway mitigation** — it
   bounds §4.4 far more tightly than the condition wording alone.
10. **Prompt hooks load from a plugin-bundled `hooks/hooks.json`.** Probed with a throwaway
    plugin under `--plugin-dir`: 14 evaluations fired. This was the one genuinely unproven
    mechanism and it holds.
11. **`Bash(gh issue create:*)` is a valid allow-rule matcher.** Verified by running
    `gh issue create --help` under it in `-p` with no prompt.
12. **The `concern` label does not exist on `schmug/agent-notes`.** The repo carries only the
    nine GitHub defaults, so `gh issue create --label concern` **fails until the label is
    created**. Creating it is a prerequisite step, not an assumption.

**Still open — check before relying on these:**

1. **Whether the prompt hook sees the full transcript or a window of it.** The wrapper says
   "the conversation transcript above" and the probe's transcript was two messages long. A
   long session may present the evaluator with a truncated view, which would bias it toward
   `ok: true` — silence, the §9 failure mode. Measure on a real session before trusting the
   block rate.
2. **Interaction with the `Stop` hook already running in this environment.** Debug output
   showed a second `Hook Stop (Stop) success` emitting a metrics payload
   (`skip_reason`, `diff_strategy_v2`) from something already installed. Multiple Stop hooks
   evidently coexist, but ordering and whether one can suppress another was not established.
3. **Where the allow-rule must live** — user settings vs the plugin. The matcher is verified;
   its required scope for an unattended run is not.
4. **Cloud / remote-served sessions almost certainly do NOT run this hook.** The binary
   contains `Prompt stop hooks are not yet supported outside REPL` and the matching
   `Agent stop hooks…`, both returned from `executeHooksOutsideREPL` with a
   `hook_type_unsupported` metric, alongside `hook skipped for a call served to a cloud
   session`. **Local headless `claude -p` is NOT affected** — prompt Stop hooks were
   observed firing under `-p` three times, with the configured condition text in the debug
   log, so `-p` evidently runs the REPL path. What is unverified is any session served
   remotely (cloud routines, `CLAUDE_CODE_REMOTE`), which cannot be tested from here.
   Local `~/.claude/scheduled-tasks/` runs are local and unaffected; `/schedule` cloud
   routines may silently capture nothing. **Do not claim coverage for cloud sessions.**

**A note on drift.** This spec pins behaviour against Claude Code `2.1.251`. The prompt-hook
wrapper text in §4.1 is an internal implementation detail observed through `--debug-file`, not
a published contract; if the wrapper changes, the condition wording in §4.1 is what needs
re-testing first.
