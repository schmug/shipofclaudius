# M4 — running the validation

The prompt-specificity score is only worth screen space if it predicts something. M4 is
the experiment that decides that, and per the design doc's build order it runs **before**
the sampler (M2) is built, so that the sampler is not built and then deleted.

Authoritative design: [`docs/specs/2026-08-30-prompt-specificity.md`](../../docs/specs/2026-08-30-prompt-specificity.md)
§9.1 (the three decisions), §7 (config), §8 (the invariant every path here obeys).

## What M4 can and cannot answer yet

§9's M4 text compares `delta_normalized` against `log_length_baseline`. `delta_normalized`
does not exist until M2 ships, so the question this code actually answers is the weaker
one from §9.1:

> does the **fast-path grounding ratio** — `grounded / (grounded + unresolved + ambiguous)`
> — beat `log_length_baseline` at predicting whether a turn needed a follow-up correction?

If even that fails, the fast path is not earning its place on the status line and the
sampler is moot. If it succeeds, M2 still has to clear the same bar on its own.

## 1. Switch the log on

```bash
printf 'outcome_log = true\n' >> ~/.claude/specificity/config.toml
```

Default is `false`, and with it off **no log file is created at all**. Nothing accumulates
until you do this.

The hook then appends one line per turn to `~/.claude/specificity/outcomes.jsonl`
(`SPECIFICITY_DIR` moves both the config and the log). One line looks like:

```json
{"prompt_id":"550e8400-…","ts":1756500000.123,"grounded":3,"unresolved":1,"ambiguous":0,"indeterminate":5,"acceptance":2,"io_spec":1,"named_files":4,"format":0,"prompt_tokens":180,"log_length_baseline":5.193}
```

Counts only. **No referent phrases, no file paths, no prompt text** — every value is a
number except `prompt_id`, which is passed through the same id filter the cache uses for
`session_id`, so there is nowhere in the record for text to sit. That is asserted, not
assumed: see the privacy tests in [`tests/specificity-outcome-log.test.mjs`](../../tests/specificity-outcome-log.test.mjs).

Two turns are deliberately **not** logged: one whose scoring threw, and one whose
transcript was unparseable. Both would contribute a row that reads as a maximally vague
prompt when in fact the context index was empty.

Collect a few hundred turns before reading anything into the result.

## 2. Does the score beat word count?

```bash
node packages/specificity/bin/analyze.mjs report
```

It joins the log to the transcripts Claude Code already writes under `~/.claude/projects`
(on `prompt_id`), derives the outcome label from the following turn, and prints the two
AUCs plus a verdict. Both predictors are oriented so higher means "more likely to need a
correction", which is what makes them comparable; grounding is therefore negated.

Useful flags: `--log <file>`, `--projects <dir>`.

AUC rather than a correlation because neither predictor has a threshold anyone has picked
yet, and the question is only whether the *ordering* carries information. No p-value is
printed: one dataset, no pre-registration, and a label whose own error rate is still
unknown do not add up to a significance claim.

## 3. Measure the label's own error rate — this step is not optional

The label is a heuristic: a turn counts as having needed a correction if the **next** turn
is short (≤ `SHORT_TURN_WORDS`, currently 25 words, fenced code excluded) **and** carries a
correction marker (`no…`, `actually`, `I meant`, `that's not`, `still failing`, `undo`, …).
Both halves are required — markers alone label any long turn containing "actually" as a
repair, and length alone labels "run the tests".

Without knowing how often that heuristic is wrong, a weak correlation in step 2 is
indistinguishable from a weak *label*, and only one of those is a reason to cut the
sampler. §10 Q7 is the cautionary case in this very project: the pronoun branch looked
like a working measurement until it was checked against what the answer should have been,
and turned out to be about 5% correct.

**a. Print a worksheet.** It goes to stdout, never to a file — judging the label needs the
prompt text, and §9.1 keeps prompt text off disk.

```bash
node packages/specificity/bin/analyze.mjs sample --n 30 --seed 7
```

The sample is stratified (half from each predicted class) because corrections are a small
minority; a uniform 30 would contain one or two and measure the miss rate not at all.
It is seeded so the rows you judge are exactly the rows that get scored.

**b. Judge each row** — is the next turn the user correcting the previous turn, as opposed
to a new instruction, an approval, or an ordinary follow-up? Write one line per row into a
verdicts file. Ids and booleans only; do not paste the text in.

```
{"prompt_id":"550e8400-…","correction":true}
{"prompt_id":"6ba7b810-…","correction":false}
```

**c. Score the heuristic against your verdicts**, with the same `--n` and `--seed`:

```bash
node packages/specificity/bin/analyze.mjs check --verdicts verdicts.jsonl --n 30 --seed 7
```

Out comes the label error rate with a 95% Wilson interval (Wilson, not the normal
approximation — at n=30 the latter is wrong in the flattering direction), plus the
confusion counts. Precision and recall are computed on the re-balanced sample and are not
the rates you would see on the raw stream; the error rate is the number M4 needs.

If the error rate is high, fix the label before drawing any conclusion about the score.
`SHORT_TURN_WORDS` and `CORRECTION_MARKERS` in [`src/analysis.mjs`](src/analysis.mjs) are
exported so the check can be re-run at a different setting.

## 4. Report both numbers together

The M4 finding is a pair — "grounding AUC *x* vs baseline AUC *y*, at a label error rate
of *z*% (95% CI …)". Reporting the first without the third is the failure mode §9.1 was
written to prevent.

## Turning it off

Set `outcome_log = false` (or delete the key) and delete
`~/.claude/specificity/outcomes.jsonl`. Nothing else in the tool reads it.

## Notes for whoever touches this next

- **Concurrency.** Several sessions append to the one file. Each append is a single
  `appendFileSync` of one complete line under `MAX_LINE_BYTES` (4 KiB), which is what makes
  concurrent appends interleave between lines rather than inside one. Do not switch to a
  read-modify-write, and do not let a field become unbounded.
- **`ensureDir`, never `mkdirSync(..., { recursive: true })`.** The recursive call never
  returns when an ancestor is procfs, and a `UserPromptSubmit` hook that hangs stalls the
  user's turn until the host timeout — the one failure no try/catch can rescue.
- **Every logging failure is swallowed.** §8's invariant is that no configuration of this
  tool may break a session, and a validation log is the least load-bearing thing in the
  program.
- **`analyze.mjs` must never write a file.** A `--out` flag on `sample` would put prompt
  text on disk permanently. A test asserts the CLI contains no write call at all.
