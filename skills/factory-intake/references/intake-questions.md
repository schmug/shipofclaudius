# Intake question bank

At most THREE `AskUserQuestion` calls, at most FOUR questions each. Every option carries a
recommended default marked "(Recommended)" and listed first. Pick from the bank below; add the
research brief's `open_questions` as free-text-friendly questions with 2–3 options each.

## Round 1 — mandatory

| header | question | options (recommended first) |
|---|---|---|
| Purpose | Who is this for and what is the ONE thing it must do? | 3 readings of the idea, phrased as user + outcome; the sharpest one recommended |
| Direction | Which visual direction should the first candidate take? | Minimal and text-first (Recommended) · Bold and graphic · Playful and animated · Utilitarian dashboard |
| Candidates | How many candidates should be built this run? | 1 (Recommended) · 2 · 3 · 4 — with N > 1 each candidate gets a DIFFERENT direction from the list above |
| Slug | The repo, Worker, and hostname will be `<slug>` — confirm? | the derived slug (Recommended) · `<slug>-2` · Other |

## Round 2 — as needed

| header | question | options |
|---|---|---|
| Must-haves | Which of these are must-have for v1 (pick all)? | multiSelect over the acceptance criteria you drafted from the idea + brief |
| Tone | What tone should copy take? | Plain (Recommended) · Warm · Playful · Formal |
| Reuse | Reuse `<repo/path>` the research found? | Yes (Recommended) · No, build fresh |
| *open question N* | from the research brief | 2–3 concrete options + your recommendation |

## Round 3 — budget, always last

| header | question | options |
|---|---|---|
| Budget | This run will spend: 1 research agent, 1 preflight agent, N build agents, N codex runs, ~3 min certificate wait per candidate, and on Ship one gated merge (2 agents). Go? | Go (Recommended) · Reduce to 1 candidate · Stop |

## Rules

- Never ask what the research brief or the idea already answers.
- Never ask a question whose answer does not change what gets built.
- Record every answer verbatim in the spec's "Decisions" list.
