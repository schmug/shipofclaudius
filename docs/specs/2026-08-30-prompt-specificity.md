# Prompt Specificity Scorer — Spec

**Status:** draft v0.1 — **M1 implemented** (see "Implementation status" below)
**Repo:** `schmug/shipofclaudius`

Scores each user turn in Claude Code for how much it narrows the space of acceptable
outputs, **conditioned on the context already in the window**, and surfaces the result
in the status line.

---

## Implementation status

| Milestone | State | Where |
|---|---|---|
| M1 — fast path + status line | **shipped** | `packages/specificity/` |
| M2 — second measure (no-sampling info gain; sampler deferred) | not started | separate opt-in package |
| M3 — prompt hook (H2) | not started | — |
| M4 — validation | not started | — |
| M5 — packaging | not started | would add a `UserPromptSubmit` entry to `hooks/hooks.json` |

Two deliberate deviations from the text below, both taken because a per-repo constraint
outranks a spec suggestion:

1. **Node, not `python3`.** §3.1's registration example invokes `python3`. This repo has
   zero dependencies, no lockfile, and a CI job with no install step, and its existing
   non-workflow code (`packages/factory-gate`, `packages/vent-server`) is Node built-ins
   only. Node is also the one runtime guaranteed present wherever Claude Code runs, which
   `python3` is not — notably on Windows. The hook is therefore
   `packages/specificity/bin/fast.mjs`.
2. **The status line is registered by hand, not shipped enabled.** A plugin auto-discovers
   `hooks/hooks.json`, but `statusLine` is a user/project setting a plugin cannot claim —
   **confirmed**: a plugin's bundled settings support only the `agent` and
   `subagentStatusLine` keys, and the main `statusLine` is not among them.
   M1 therefore ships the scripts and documents the two settings snippets; nothing is
   turned on by installing the plugin. Enabling a `UserPromptSubmit` hook for every
   session in every project is M5's decision to make explicitly, not a side effect of
   landing M1.

`render.sh` + `render.jq` implement §5 as specified (POSIX sh and `jq`, no computation).

---

## 1. Purpose

A prompt string has no specificity on its own. "Fix the timeout" is fully specific when
the failing file is already in context and vacuous when it isn't. The quantity worth
measuring is how much a turn reduces uncertainty over what the model will do *given the
current window*.

This tool computes that per turn and shows it without interrupting the session.

### Goals

- Per-turn conditional score, computed against the live context.
- Distinguish four states: turn did the work / turn was redundant / task underspecified
  overall / turn conflicted with context.
- Zero added latency on the critical path in the default configuration.
- Actionable output (which referents didn't resolve), not just a scalar.

### Non-goals

- Rewriting or expanding the user's prompt. Diagnosis only.
- Blocking prompts by default. Gate mode exists but ships off.
- Cross-session or cross-model score comparison. Scores are relative to one model and
  one context ordering and do not transfer.

---

## 2. Architecture

Three processes, coupled only through a per-session JSON file on disk.

```
                     ┌─────────────────────────────────────────┐
  user submits turn  │  UserPromptSubmit (fires once per turn) │
        │            └─────────────────────────────────────────┘
        │                    │                      │
        │        ┌───────────┴──────────┐  ┌────────┴──────────┐
        │        │ H1: command hook     │  │ H2: prompt hook   │
        │        │ sync, <2s            │  │ sync, fast model  │
        │        │ heuristics + spawn   │  │ referent/ambiguity│
        │        └───────────┬──────────┘  └────────┬──────────┘
        │                    │                      │
        │                    │  writes              │ additionalContext
        │                    ▼                      ▼  (optional)
        │            ~/.claude/specificity/<session_id>.json
        │                    ▲
        │                    │ writes (seconds later)
        │        ┌───────────┴──────────┐
        │        │ H1b: async sampler   │
        │        │ async:true, no budget│
        │        │ delta-entropy        │
        │        └──────────────────────┘
        ▼
   ┌─────────────────┐  reads (≤ every 300ms)
   │  status line    │◄──────────── same file
   └─────────────────┘
```

Rationale for the split: `UserPromptSubmit` lowers the default `command` / `http` /
`mcp_tool` timeout to 30 seconds, and a 10-sample entropy estimate will not reliably
fit. Anything requiring model samples runs detached; anything on the critical path is
local string work or a single fast-model call.

The status line **never computes**. It runs on every render, so it is a pure read of the
cache file.

---

## 3. Component H1 — synchronous command hook

### 3.1 Registration

`~/.claude/settings.json` (user scope) or the repo's `.claude/settings.json` for
project scope. `UserPromptSubmit` has no matcher support; it always fires.

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node",
            "args": ["${CLAUDE_PROJECT_DIR}/packages/specificity/bin/fast.mjs"],
            "timeout": 10,
            "statusMessage": "scoring prompt"
          }
        ]
      }
    ]
  }
}
```

Exec form (`args` present) is required here because the command references a path
placeholder — each element is passed as one argument with no shell quoting.

**Path expansion (confirmed 2026-08-30 against the published hook/statusline docs, not by
a local test):** `${CLAUDE_PROJECT_DIR}` *does* expand in a `statusLine.command`, so the
project-scoped form below is correct when this repo is the project. For a **plugin
install** the checkout is not the project directory, so use an absolute path there —
`${CLAUDE_PLUGIN_ROOT}` is meaningful inside the plugin's own `hooks/hooks.json`, not
inside a user's `settings.json`.

Also confirmed: the `UserPromptSubmit` payload carries `permission_mode` and
`hook_event_name` beyond the fields consumed in §3.2, and exit 2 does erase the typed
prompt exactly as §3.4 assumes.

### 3.2 Input contract

Read JSON from stdin. Fields consumed:

| Field | Use |
|---|---|
| `session_id` | cache file key |
| `prompt_id` | ties the score to one turn; matches the OTel `prompt.id` attribute |
| `prompt` | the submitted text (event-specific field) |
| `transcript_path` | the conditioning set |
| `cwd` | resolving file referents |

**Known hazard:** the transcript file is written asynchronously and may lag the
in-memory conversation, so it may not include the current turn's most recent messages
when the hook fires. Treat the transcript as *context as of the previous turn* and
splice the current `prompt` in yourself rather than expecting to find it.

### 3.3 Fast-path computation (target < 2s, stdlib only)

1. **Parse transcript** into ordered blocks: system prompt, CLAUDE.md loads, prior
   turns, tool results, file reads.
2. **Referent extraction.** Regex + POS-free heuristics for: bare pronouns (`it`,
   `that`, `this`, `them`), definite descriptions (`the <noun>`), deictic back-references
   (`like before`, `same as last time`, `the one you made`), and bare file-ish tokens.
3. **Resolution.** For each referent, count candidate antecedents in the window.
   - `0 candidates` → **unresolved**
   - `>1 candidate` → **ambiguous**
   - `1 candidate` → **grounded**
   - *any* non-zero count, for a **bare pronoun** → **indeterminate** (recorded, but
     excluded from the score and the report — see §10 Q7 for the measurement that forced
     this). Only the empty-window case yields a pronoun verdict.
4. **Constraint inventory.** Count explicit acceptance criteria, I/O specifications,
   named files, and format directives in the turn. These are the drivers that actually
   move outcomes, so they are counted separately rather than folded into a length proxy.
5. **Length baseline.** Record `log(token_count)` alongside everything else. Any
   composite score must be checked against this baseline; if it doesn't beat word count,
   the machinery isn't earning its keep.
6. **Write** `phase: "fast"` record to the cache file.
7. **Spawn** the async sampler (§4) and exit 0.

> **M1 note.** Steps 1–5 ship as specified. Step 6 writes `phase: "skipped"` rather than
> `"fast"`, because there is no sampler yet: a record claiming the fast phase is complete
> and a sample is pending would render the §5.3 "sampling" placeholder in the status line
> forever. Step 7 is M2.

### 3.4 Output contract

Default mode is advisory:

- **`systemMessage`** carries the human-readable score. It is shown to the user and not
  to Claude, which is the correct channel for a number the model shouldn't optimize
  against.
- **`hookSpecificOutput.additionalContext`** is used *only* to pass the unresolved
  referent list, and only when `emit_ambiguities: true`. It is wrapped in a system
  reminder and inserted alongside the submitted prompt. Write it as factual statements
  ("The referent 'the config file' matches three files in this repo"), not as imperative
  instructions — text framed as out-of-band system commands can trip Claude's
  prompt-injection defenses and get surfaced to the user instead of used as context.
- Cap: hook output strings are truncated at 10,000 characters.

Gate mode (`mode: "gate"`, default off): exit 2 when
`unresolved_referents >= threshold`. On `UserPromptSubmit`, exit 2 **blocks prompt
processing and erases the prompt** — destructive, so the threshold ships high and the
mode ships disabled.

**Exit-code discipline.** Exit 2 is the only code that blocks through the code alone.
Exit 1 is a non-blocking error: the turn proceeds and the transcript shows a
`<hook name> hook error` notice. Never signal failure with 1 and expect a gate. On the
first run, watch for `Failed with non-blocking status code:` in the transcript — a
mistyped path leaves the hook silently disabled.

---

## 4. Component H1b — asynchronous sampler

> **Decided 2026-08-30 — the sampler is no longer M2's first move.** §4.6(4) found that an
> information-gain measure built from a log-determinant covariance update in embedding
> space yields the `carried` vs `redundant` axis with **no autoregressive inference at
> evaluation time**, along with monotonicity, an additive per-turn decomposition and
> provable diminishing returns for redundant turns. It needs embeddings, so it lands in the
> same opt-in package §4.4 already calls for.
>
> M2 therefore ships **that** first. Sampling is deferred until there is evidence it earns
> its cost, because what 2N samples uniquely buy is the `underspecified` /
> `conflicting` split — and `conflicting` is the quadrant §4.6 flags as least likely to be
> detectable at realistic N. The rest of §4 stays as the specification of the sampler *if
> and when* it is built; it is not the near-term plan.

Spawned by H1, or registered directly with `"async": true`, which runs it in the
background without blocking. Claude Code does not enforce `timeout` on an async command
hook, so it can take as long as it needs. It will miss the turn it scores and land
before the next one.

### 4.1 Delta-entropy procedure

```
C   = context as of this turn (from transcript_path)
P   = the submitted prompt
N   = sample_count (default 8)

A = N samples from (C + null_j) for each null_j in NULL_PANEL
B = N samples from (C + P)

H_before = median_j semantic_entropy(A_j)
H_after  = semantic_entropy(B)
delta    = H_before - H_after
```

`semantic_entropy` = embed each sample, cluster, take entropy of the cluster
distribution.

**The null is a panel, not a string (resolved — see §10 Q1).** A single filler turn is
measurably the worst available choice, so `NULL_PANEL` holds 4–5 members and `H_before` is
the median across them. The best single member is a **masked variant of `P` itself** —
same length and turn structure, content words stripped — because it controls for
turn-presence and length and isolates content. `"continue"` stays in the panel for
comparability, not as the definition. Always record the **between-null spread** next to
`delta`: if the spread is comparable to the delta being claimed, the measurement is not
resolving anything and the number should not be rendered.

### 4.2 Classification

| H_before | H_after | State | Meaning |
|---|---|---|---|
| high | low | `carried` | The turn did the work. Genuinely specific. |
| low | low | `redundant` | Context already pinned it. Token cost, not a specificity problem. |
| high | high | `underspecified` | Neither context nor turn constrains the task. |
| low | high | `conflicting` | The turn broadened or contradicted settled context. |

`conflicting` is the interesting one and the reason both numbers are stored rather than
just the delta. A turn can look highly specific in isolation while fighting a constraint
already in the system prompt.

**It should not be detected from the entropy pair, though.** `conflicting` needs a
reliably low `H_before` — the half most contaminated by the null choice — and asks a
small-N estimator biased toward *under*-reporting entropy to detect an entropy *increase*.
Expect poor sensitivity. Detect it instead as a **cluster-structure property**: run the
NLI `contradiction` label between cluster representatives of the after-set (the same model
the clustering already needs), or test disjointness of the resolved targets. That is what
"the turn broadened or contradicted settled context" actually means, and it does not
require a second granularity.

### 4.3 Cost controls

Sampling 2N completions over a full context window on every turn is the expensive part
of this design.

- **N ≥ 10, and prefer a bias-corrected estimator.** The published work uses N=10
  (beyond which Kuhn et al. report no significant gain). The default of 8 was too low for
  a second reason: the plug-in entropy estimator has an established *negative* bias that
  grows with the true number of semantic classes, so it shrinks `H_before` more than
  `H_after` and systematically deflates the delta. Use the Chao–Shen coverage-adjusted
  estimator, and record the raw cluster counts `(k_before, k_after)` next to the
  entropies — at this N the entropy is close to a re-encoding of `k` anyway. Note also
  that `H_before` is hard-capped at log₂N, so a "high" threshold must not sit at that
  ceiling.
- **Truncate samples.** Cap each sample at ~200 tokens. For an agentic session the
  dispersion of *openings* — which file it reaches for, which tool it calls first — is
  nearly as discriminative as the full response and an order of magnitude cheaper.
- **Use a small model** for sampling. The score measures the prompt, not the model's
  ceiling.
- **Gate on cheap signals.** Skip sampling entirely when the fast path finds zero
  unresolved referents and the turn is over `skip_threshold` tokens. Most turns don't
  need it.
- **Debounce.** One sampler run per `prompt_id`, never more.

Two confirmed mechanics for this component: `"async": true` is a real command-hook field
on any event and Claude Code does **not** enforce `timeout` on it, so §4's "no budget"
assumption holds. There is also `"asyncRewake": true`, which runs in the background and
re-wakes Claude on exit 2, surfacing output as a system reminder — a way for a landed
sample to reach the session rather than only the status line, if that is ever wanted.

### 4.4 Embedding backend

Anthropic does not serve an embedding endpoint, so this is a real dependency decision:

- **Local (default).** `sentence-transformers` on the M4 Max. Keeps the entire context
  window — which by definition includes whatever is in the repo — off third-party
  infrastructure. Latency is irrelevant on the async path.
- **Hosted.** Any embedding API. Faster to stand up, but every scored turn ships the
  full window to a third party.
- **LLM-as-clusterer.** Skip embeddings; ask a fast model to group the samples into
  equivalence classes and return counts. Fewer moving parts, noisier boundaries.

Default to local. Make it a config key.

> **Resolved 2026-08-30 — separate opt-in package.** The `local` default conflicts with
> this repo's zero-dependency rule: `sentence-transformers` cannot be vendored under
> `tests/lib/`, and CI runs with no install step. Rather than compromise the default down
> to `llm` clustering, the Python + embeddings path moves to its **own package outside
> this plugin**. `shipofclaudius` stays zero-dependency and ships the fast path only.
>
> That makes `embedding_backend = "local"` mean *delegate to the external sampler if it is
> installed*. When it is absent — the normal case for anyone who installs only the plugin —
> the hook writes `phase: "skipped"` and the status line renders the fast row. **Absence is
> not an error state and must never be rendered as one**, which is the same fail-open rule
> as §8 and is already how M1 behaves.

---

### 4.5 The equivalence relation (resolved — see §10 Q2)

Cluster on the pair **(stated goal, first tool call's resolved target)**. Two samples are
equivalent iff *both* match.

- **Stated goal** — bidirectional-entailment judge, with the context `C` included in the
  judgment (both source papers require this; key meaning often lives in the context). Use
  an LLM judge rather than an off-the-shelf NLI model, which was not trained on agentic
  plan prose.
- **Tool call** — canonicalize to `(tool name, resolved-target class)`:
  - file-path arguments → the resolved repo path. `Read(src/a.mjs)` and `Read(src/b.mjs)`
    are **different** clusters.
  - search arguments → normalized symbol or pattern (case, quoting, anchors).
  - presentation arguments that do not change what the agent sees (limit, offset, format,
    independent flag order) → ignored.

The rule in one line: *two calls are the same iff they put the same information in front
of the agent.*

**This deliberately inverts §10 Q2's original hunch.** If tool identity alone defined the
cluster, `H_before` would collapse to nearly zero in any coding context — the opening move
is almost always a read or a search — so every turn would read `redundant` and nothing
could ever score `carried`. That is the same understating-`H_before` failure the null-turn
choice risks, arriving through the clustering step instead.

Cluster assignment must not be greedy-against-a-representative, which makes membership
depend on comparison order; compute the full pairwise matrix and take connected
components.

### 4.6 Known fragilities

The sampler is the part of this design most likely not to survive contact with data. These
are recorded so M4 can test them rather than rediscover them.

1. **Three independent biases all push `H_before` down**, and therefore all deflate
   `delta` in the same direction: the null-turn's own instruction bias, the plug-in
   estimator's small-N negative bias, and multinomial sampling's under-coverage of the
   semantic space (worse here than in QA, because agentic openings are highly constrained
   and the first tokens are near-deterministic). They are additive.
2. **Delta is not comparable across sessions of different length or maturity.** Entropy
   falls as context accumulates and approaches a floor, so a mature session drifts toward
   low→low `redundant` regardless of prompt quality. Either report a fractional narrowing
   (`delta / H_before`) or restrict comparison to within-session. This is already implied
   by §1's non-goal about cross-session comparison; it is stronger than that non-goal
   admits.
3. **Consistency is not correctness.** These methods measure whether the model's response
   distribution narrowed, not whether it narrowed onto the right thing. A prompt that
   makes the agent confidently do the wrong thing scores `carried`. The score must never
   be presented as a prompt-*quality* measure, and this is a second reason §3.4 keeps the
   number out of Claude's context: it is not a target worth optimizing against.
4. **A no-sampling method covers most of the value.** An information-gain measure built
   from a log-determinant covariance update in embedding space yields monotonicity, an
   additive per-turn decomposition, and provable diminishing returns for redundant
   turns — the `carried` vs `redundant` axis — with no autoregressive inference at
   evaluation time. What 2N samples actually buy over that is the
   `underspecified`/`conflicting` distinction. Given that `conflicting` is separately
   flagged as the fragile quadrant, M2 should justify the sampling cost against this
   cheaper route before paying it. It fits the same opt-in-package decision, since it also
   needs embeddings and no Python-free constraint applies there.

### 4.7 Where §4.1–4.6 come from

These sections are a literature review, not measurements taken here. Recorded so a later
reader can check them rather than trust them.

| Claim | Source |
|---|---|
| Semantic entropy: bidirectional-entailment clustering, context included in the judgment, N=10 | Kuhn, Gal, Farquhar, *Semantic Uncertainty*, ICLR 2023 ([2302.09664](https://arxiv.org/abs/2302.09664)); Farquhar et al., Nature 630, 2024 |
| A null input must be *fitted*, not just substituted | Ethayarajh, Choi, Swayamdipta, *V-Usable Information*, ICML 2022 |
| A single content-free token carries its own bias; average over many | Zhao et al., *Calibrate Before Use*, ICML 2021 ([2102.09690](https://arxiv.org/abs/2102.09690)); Fei et al., ACL 2023 ([2023.acl-long.783](https://aclanthology.org/2023.acl-long.783/)) |
| Entropy decreases monotonically with prompt informativeness; masking ladder as a control | Zhang, Verma, Doshi-Velez, Low ([2407.14845](https://arxiv.org/abs/2407.14845)) |
| Information gain with no appended turn; N=20 | Kobalczyk et al., *Active Task Disambiguation* ([2502.04485](https://arxiv.org/abs/2502.04485)) |
| Plug-in entropy has a negative small-N bias; use Chao–Shen | McCabe et al., ICLR 2026 ([2509.14478](https://arxiv.org/abs/2509.14478)) |
| Clustering granularity is the dominant free parameter | Chen, Da, Liu, Wei ([2605.19220](https://arxiv.org/pdf/2605.19220)); Nikitin et al., KLE, NeurIPS 2024 |
| Uncertainty methods fail on **code**, with semantic clustering identified as the cause | Sharma & David ([2502.11620](https://arxiv.org/abs/2502.11620)) |
| No published equivalence relation exists for tool calls — the gap is explicitly named | Lymperopoulos & Sarathy, *Tools in the Loop* ([2505.16113](https://arxiv.org/abs/2505.16113)) |
| Compared equivalence relations for agent trajectories | Bouchard & Chauhan ([2608.11552](https://arxiv.org/abs/2608.11552)) |
| Multinomial sampling under-covers the semantic space | Aichberger et al., SDLG, ICLR 2025 ([2406.04306](https://arxiv.org/abs/2406.04306)) |
| Information gain with **no sampling** (log-det covariance in embedding space) — §4.6(4) | He, Kasiviswanathan, Janzing ([2606.12332](https://arxiv.org/pdf/2606.12332)) |

Explicitly **not** settled by any of it: whether a `"continue"`-style filler biases
*agentic* sampling specifically; whether an empty user turn is off-distribution enough to
inflate entropy; and whether long repo context dominates the delta. Those three are
M4's to measure.

## 5. Component 2 — status line

### 5.1 Registration

```json
{
  "statusLine": {
    "type": "command",
    "command": "${CLAUDE_PROJECT_DIR}/packages/specificity/bin/render.sh",
    "padding": 0
  }
}
```

### 5.2 Behavior

The status line updates when conversation messages update, at most every 300ms, and the
first line of stdout becomes the text. ANSI color codes are supported. Contextual session
information arrives as JSON on stdin, including `session_id`, `transcript_path`, `cwd`,
`model`, and `workspace`.

Because it renders on every update, `render.sh` does exactly two things: read
`session_id` from stdin, and read the matching cache file. It never calls the network,
never shells out to git, never computes. A `jq` one-liner is the target implementation.
Print the raw stdin to a file once during setup and confirm which fields exist in your
installed version before depending on any of them.

### 5.3 Render format

One field. The status line is not a dashboard and every character competes.

```
spec ▓▓▓▓▓▓░░ .74 carried
spec ▓▓░░░░░░ .21 underspec ⟂2
spec ░░░░░░░░  ·  sampling
spec ▓▓▓▓▓░░░ .61 carried (stale)
spec ▓▓▓▓░░░░ .50 fast ⟂1
spec ░░░░░░░░  ·  no refs
```

| Element | Meaning |
|---|---|
| 8-char bar | `delta` normalized 0–1 (rounded to the nearest cell) |
| decimal | same value, numeric |
| state word | `carried` / `redundant` / `underspec` / `conflict` |
| `fast` | no sampled state present; the bar shows the fast-path grounding ratio |
| `⟂n` | n unresolved referents from the fast path |
| `·  no refs` | nothing **scorable** in the turn — no referents, or only indeterminate ones |
| `·  sampling` | fast phase done, async phase in flight |
| `(stale)` | cache `prompt_id` predates the current turn |

Color: green `carried`, dim `redundant`, yellow `underspec`, red `conflict`. Conflict
is the one state worth making loud.

The `fast` row is what M1 renders, and it is also §8's required degradation when the
sampler crashes. Its bar is the grounding ratio (`grounded / total referents`), which is
deliberately *not* the delta — it is labelled differently so a fast-path number is never
mistaken for a sampled one.

### 5.4 Staleness

**Corrected 2026-08-30.** The original text assumed the status line has no `prompt_id` of
its own. It does — the status-line stdin payload carries `prompt_id` alongside
`session_id`, `transcript_path`, `cwd`, `model` and `workspace`. Staleness is therefore an
**exact comparison** against the `prompt_id` in the cache record, not a heuristic.

The mtime comparison the section originally specified is kept only as a **fallback**, for
a host that does not send the field — the section's own advice is to dump the raw stdin
once and confirm before depending on any of it, and that advice applies to this finding
too, which comes from the docs rather than from a local test. Fallback rule: if
`transcript_path` mtime is newer than `written_at` by more than
`SPECIFICITY_STALE_GRACE` seconds (default 60), render `(stale)`. An mtime that cannot be
read counts as fresh — crying wolf on every render is worse than missing a stale number.

The exact comparison deliberately wins over the heuristic where both are available: a
long-running turn legitimately leaves `written_at` far behind the transcript while still
being the current turn, and the heuristic alone calls that stale.

---

## 6. Cache file schema

Path: `~/.claude/specificity/<session_id>.json` (override with `SPECIFICITY_DIR`).
Written atomically (temp + rename) — the status line may read at any moment.

```json
{
  "session_id": "abc123",
  "prompt_id": "550e8400-e29b-41d4-a716-446655440000",
  "written_at": 1756500000.123,
  "phase": "complete",
  "fast": {
    "referents": [
      {"text": "the config file", "kind": "definite", "candidates": 3, "status": "ambiguous"},
      {"text": "it", "kind": "pronoun", "candidates": 1, "status": "grounded"}
    ],
    "unresolved": 0,
    "ambiguous": 1,
    "grounded": 1,
    "indeterminate": 0,
    "constraints": {"acceptance": 0, "io_spec": 1, "named_files": 2, "format": 0},
    "prompt_tokens": 34,
    "log_length_baseline": 3.53
  },
  "sampled": {
    "h_before": 2.81,
    "h_after": 0.94,
    "delta": 1.87,
    "delta_normalized": 0.74,
    "state": "carried",
    "n": 8,
    "model": "…",
    "elapsed_ms": 4120
  }
}
```

`phase` ∈ `fast` | `sampling` | `complete` | `skipped` | `error`. The status line
renders from whatever is present; a missing `sampled` block renders the sampling
placeholder rather than an error.

`status` ∈ `grounded` | `unresolved` | `ambiguous` | `indeterminate`. The scored
denominator is `grounded + unresolved + ambiguous`; `indeterminate` is carried for M4 and
excluded from the bar, because it marks a count the index cannot turn into a verdict. A
turn whose only referents are indeterminate therefore renders `· no refs`, not a score.

`session_id` is untrusted input that becomes a filesystem path. Both the writer
(`isSafeSessionId` in `src/cache.mjs`) and the reader (the `case` guard in `render.sh`)
reject anything outside `[A-Za-z0-9_-]{1,128}` outright rather than sanitizing it, and
the two must stay in step.

---

## 7. Configuration

`~/.claude/specificity/config.toml`:

| Key | Default | Effect |
|---|---|---|
| `mode` | `advisory` | `advisory` \| `gate` |
| `gate_threshold` | `3` | unresolved referents that trigger exit 2 in gate mode |
| `emit_ambiguities` | `false` | send unresolved referents to Claude via `additionalContext` |
| `sample_count` | `10` | N per side of the delta (was 8; see §4.3) |
| `sample_max_tokens` | `200` | truncation per sample |
| `skip_threshold` | `120` | prompt tokens above which sampling is skipped if fully grounded |
| `embedding_backend` | `local` | `local` \| `hosted` \| `llm` |
| `sampling_model` | small | model used for the 2N samples |

The parser is a flat key/value reader, not a TOML implementation: every key here is a
top-level scalar. Section headers are tolerated and ignored; arrays are ignored. Any
value of the wrong type or outside its enum falls back to the default rather than
raising, per §8.

---

## 8. Failure modes

| Failure | Required behavior |
|---|---|
| Transcript unparseable | write `phase: "error"`, exit 0, session unaffected |
| Sampler crashes | cache keeps the `fast` block; status line shows the fast-path fields only |
| Cache file missing | status line prints nothing for this field, not an error string |
| Hook script not executable | shows as `Failed with non-blocking status code:` — check on first run |
| Two sessions, same project | keyed by `session_id`, so no collision |
| Session resumed | on `--continue` / `--resume`, Claude Code replays saved hook text rather than re-running the hook for past turns; old scores in the transcript are stale by construction. Do not backfill. |

The invariant: **no configuration of this tool may break a session.** Everything except
explicit gate mode exits 0 on every path.

---

## 9. Milestones

**Build order (decided 2026-08-30): M1 → M4 → M2 → M3 → M5.** The milestone numbers below
are names, not a sequence. M4 moves ahead of M2 because §9's own M4 text says the sampler
gets cut if `delta_normalized` cannot beat `log_length_baseline` — so building the sampler
first risks building the thing the validation then deletes. Running M4 first is cheap (no
model calls), accumulates the dataset that decides whether M2 is worth building at all, and
calibrates §10's normalization ceiling as a side effect.

1. **M1 — fast path + status line.** Referent resolution, constraint counts, cache file,
   `jq` renderer. No model calls anywhere. Useful on its own and validates the plumbing.
2. **M2 — the second measure.** No-sampling information gain (log-det covariance in
   embedding space) in the opt-in package, giving `carried` vs `redundant`. Delta-entropy
   sampling and the full four-state classification are deferred behind evidence — see the
   note at the head of §4.
3. **M3 — prompt hook (H2).** `type: "prompt"` handler for judged ambiguity, running in
   parallel with H1. Both handlers may return `additionalContext`; Claude receives all
   values.
4. **M4 — validation.** The only score that means anything is one that predicts
   something. Log score alongside turn outcome (did the turn need a follow-up
   correction?) and check whether `delta_normalized` beats `log_length_baseline` at
   predicting it. If it doesn't, cut the sampler.
5. **M5 — packaging.** Move to a plugin `hooks/hooks.json` so it installs as a unit.
   Note that under `allowManagedHooksOnly`, an admin narrows both hooks and `statusLine`
   to managed settings — relevant only if this ever ships to a fleet.

---

## 10. Open questions

1. ~~**Null-turn choice.**~~ **Resolved 2026-08-30 — a panel, not a string.** The concern
   was well founded: a single hand-picked content-free token measurably carries its own
   bias, and the standard fix in the calibration literature is to average over many
   content-free inputs rather than trust one. The semantic-entropy papers themselves have
   no null condition at all — they threshold an absolute entropy — so the before/after
   structure here has no direct precedent and the null had to be borrowed. See §4.1 for
   the panel, and §4.6(1) for why the residual bias matters. The empty-turn variant is not
   ruled out but must be gated on an off-distribution check (compare mean per-token
   logprob and malformed-opening rate against the filler nulls); nothing in the literature
   settles it.
2. ~~**Clustering granularity.**~~ **Resolved 2026-08-30 — one relation, and the hunch was
   backwards.** Same-tool-different-arguments must be **different** clusters, not the same;
   see §4.5 for the relation and for why the coarse reading collapses `H_before`. Two
   granularities for two states is not defensible: `H_before − H_after` is only a
   conditional-entropy reduction if both sides are entropies over the *same* partition,
   and differing alphabets make the sign uninterpretable. `conflicting` is recovered as a
   contradiction test instead (§4.2). Worth knowing: this is the weakest-supported area —
   uncertainty methods are documented to fail on code specifically, with the semantic
   clustering step identified as the cause, so the relation in §4.5 is the single riskiest
   assumption in M2 and should be swept rather than fixed at one setting.
3. ~~**`PreCompact` variant.**~~ **Resolved 2026-08-30 — re-resolve the stored referents.**
   Both `PreCompact` and `PostCompact` exist and support a `manual|auto` matcher, but
   neither payload carries the pending prompt; they carry `session_id`, `transcript_path`,
   `cwd` and `hook_event_name`, and `prompt_id` correlates across events. So the re-score
   has to work from something already persisted.

   It does not need the prompt text. The cache already holds `fast.referents`, and
   resolution is a pure function of `(referent, index)` — so the hook pair rebuilds the
   index from the post-compaction transcript and **re-resolves the stored referent list**,
   yielding a before/after grounding delta across the compact. That is the context-rot
   measurement, and it keeps raw prompt text off disk, which the tool otherwise never
   writes.

   One implementation detail for whoever builds it: `resolveReferents` currently drops the
   `words` array when it writes a record, keeping only `{text, kind, candidates, status}`.
   Re-resolution needs `words` for definite descriptions — re-derive it by running
   `trimPhrase` over the stored `text`, which is safe because `text` is already the
   normalized, trimmed phrase ("the config file"), not the raw match. Alternatively persist
   `words`; either is fine, but the current record is not self-sufficient as written.
4. ~~**HTTP hook path.**~~ **Resolved 2026-08-30 — dropped.** The status line is the
   destination, not a stopgap. One glanceable field costs nothing when ignored; an HTTP
   seam means a service to build, run and secure, and ships every scored turn's metadata
   off the machine. The `type: "http"` option is not pursued.
5. ~~**Normalization.**~~ **Resolved 2026-08-30 — calibrated constant, rolling bootstrap.**
   The M4-first build order settles this. A rolling per-session max is unstable exactly
   when it matters (the first few turns of a session, where one large delta permanently
   flattens the rest of the bar), and a fixed constant picked today would be a guess. So:
   derive the ceiling from the observed delta distribution in the M4 dataset (p95, not max
   — the tail is noise), pin it as a constant, and until that dataset exists use a rolling
   per-session max purely as a bootstrap. The bar is ordinal either way; the constant only
   has to be stable, not true.

### Raised by the M1 implementation

6. ~~**Generic-head word lists.**~~ **Resolved 2026-08-30 — fitted, and the mechanism was
   right but starved.** Measured over 1,918 real turns / 19,803 definite descriptions:
   listed heads scored A:B = 13.6:1 (A = a false "unresolved" averted by dropping a
   generic head; B = a real grounding forgone), while the *untreated tail* scored 25.5:1
   across 13× the volume. Adding the measured tail cut false "unresolved" verdicts by 483
   (3,259 → 2,776, −15%) for 38 groundings forgone, ≈13:1.

   Two corrections worth keeping. **`test` stays** despite scoring worst (A=18, B=13): A
   still exceeds B, and the errors are asymmetric — an A-error is a false ⟂, the only
   actionable signal, while a B-error merely downgrades `grounded` to `ambiguous`. On a
   distinct-phrase basis it is 13 vs 5, since one repeated phrase supplied 8 of the 13
   B-events. And the **stopword fix does not remove the false "unresolved" verdicts** it
   was first credited with: only 37 of 235 disappear, the rest relocate onto the true head.
   What it actually buys is noise removal — 180 nonsense referents (`the has`, `the
   itself`) leave the ⟂ list entirely and 1,095 more collapse to bare form. Worth having,
   different reason.

   The lists remain a maintenance surface; they are now fitted to one corpus rather than
   invented, which is better but not general.
7. ~~**Pronoun recency window.**~~ **Resolved 2026-08-30 — the window was the wrong
   question.** Fitting it gave a clear answer (antecedent distance p50=1, p90=2, p99=3, so
   `RECENT_BLOCKS = 3`), but the constant barely matters: the branch returned "ambiguous"
   for ~97% of pronouns at *every* window and at every salience cap K ≥ 2, because two or
   more entities sit in the last few blocks almost always. K = 1 manufactures groundedness
   by fiat — a hand-check of 30 sampled turns found the most-recent entity was the real
   antecedent only ~5% of the time.

   The cause is structural: pronouns in real prompts point at **claims, changes, runs,
   commits and concepts**, while the index holds paths and inline-code spans. The candidate
   *type* is wrong, not the count, so no window and no cap repairs it. Bare pronouns are
   therefore `indeterminate` unless the window is empty (§3.3). Excluding backtick spans
   from `recent` was measured and rejected: it moves the split by 0.2pp once a cap is in
   place.

### Raised by the measurement

8. **The deictic branch has the same defect and was left alone.** "like before" resolves
   against a count of prior user turns, which is no more a measurement than the pronoun
   count was. It survived only because deictics are 0.4% of referents (159 of ~37,600), so
   there was no evidence to act on. If it is ever made to matter, it needs the same
   treatment.
9. **A third of turns flag four or more referents** (p90 = 62), which is why the ⟂ list is
   capped at 3. The cap hides real signal on pasted-prompt turns; whether that band is
   worth a second surface, or is simply out of scope for a one-field status line, is
   unanswered.
