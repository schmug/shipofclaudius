// The M4 validation log (spec §9.1) — the append-only record that outlives a turn.
//
// The §6 cache cannot supply M4's dataset: it is one file per session, rewritten every
// turn, so by the time an outcome is observable the input is gone. This module writes the
// other half — one JSONL line per turn, appended to `<SPECIFICITY_DIR>/outcomes.jsonl`.
//
// Three constraints from §9.1 shape everything here.
//
// 1. OPT-IN. Nothing is written unless `outcome_log = true`. The caller enforces that;
//    this module never reads config, so "the log exists" is always a deliberate act.
//
// 2. COUNTS ONLY. A cache file holds one turn and is overwritten; a log accumulates
//    permanently. So the record carries no prompt-derived text at all — not the referent
//    phrases, not the paths they matched. That is not a convention, it is enforced: every
//    field below is a NUMBER except `prompt_id`, and `prompt_id` is passed through the
//    same id filter the cache uses for `session_id`, so a host that put prose there would
//    get `null` rather than a leak. There is no object anywhere in the record for a
//    referent list to be quietly added to later.
//
//    The cost is real: the GENERIC_HEADS fix came from reading *which* phrases misfired,
//    which counts cannot show. Diagnosis of that kind stays a separate exercise against a
//    corpus, not a standing collection.
//
// 3. THE LABEL IS NOT IN HERE. "Did this turn need a follow-up correction?" is a property
//    of the NEXT turn, and inferring it needs prompt text. So the label is derived offline
//    by `src/analysis.mjs` from the transcripts Claude Code already writes, joined to
//    these records on `prompt_id`. Nothing this module writes brings that text to disk.
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { ensureDir, isSafeSessionId } from './cache.mjs'

export const LOG_NAME = 'outcomes.jsonl'

// Concurrency: several Claude Code sessions run at once and append to this one file.
// A single `write(2)` to a file opened O_APPEND is atomic with respect to the offset, so
// concurrent appends interleave BETWEEN lines rather than inside one — provided each
// append is one complete line and stays small. Both halves of that are enforced rather
// than assumed: `serialize()` emits exactly one `\n` at the end (JSON.stringify cannot
// produce a bare newline, and every value is a number or a `[A-Za-z0-9_-]` id), and a
// line over this cap is dropped instead of written. 4 KiB is PIPE_BUF-conservative and
// two orders of magnitude above the ~200-byte record this actually produces.
export const MAX_LINE_BYTES = 4096

// Exactly the §9.1 fields, in write order. Anything not on this list is not in the log;
// the test suite asserts the two agree, so widening the record means widening this.
export const FIELDS = Object.freeze([
  'prompt_id',
  'ts',
  'grounded',
  'unresolved',
  'ambiguous',
  'indeterminate',
  'acceptance',
  'io_spec',
  'named_files',
  'format',
  'prompt_tokens',
  'log_length_baseline',
])

export function outcomeLogPath(dir) {
  return join(dir, LOG_NAME)
}

const int = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : 0)
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

// Builds the record from the fast block that `buildFastBlock` already produced. Returns
// null when there is no fast block — a turn whose scoring errored has no counts, and a
// row of zeroes would be indistinguishable from a genuinely empty prompt in the dataset.
export function buildOutcomeRecord({ prompt_id, fast, nowMs = Date.now() }) {
  if (!fast) return null
  const c = fast.constraints || {}
  return {
    // An id, never text. Anything that is not a plain id is refused outright rather than
    // truncated or escaped — same rule, and same regex, as `session_id` in the cache.
    prompt_id: isSafeSessionId(prompt_id) ? prompt_id : null,
    ts: Number((num(nowMs) / 1000).toFixed(3)),
    grounded: int(fast.grounded),
    unresolved: int(fast.unresolved),
    ambiguous: int(fast.ambiguous),
    indeterminate: int(fast.indeterminate),
    acceptance: int(c.acceptance),
    io_spec: int(c.io_spec),
    named_files: int(c.named_files),
    format: int(c.format),
    prompt_tokens: int(fast.prompt_tokens),
    log_length_baseline: num(fast.log_length_baseline),
  }
}

// One line, no embedded newline, nothing outside FIELDS. Written as an explicit key walk
// rather than `JSON.stringify(record)` so that an extra property on the object cannot
// reach the file by accident — the allowlist is the writer, not a later assertion.
export function serialize(record) {
  const out = {}
  for (const k of FIELDS) if (k in record) out[k] = record[k]
  return `${JSON.stringify(out)}\n`
}

// Appends one record. Throws on I/O failure; the hook swallows that, because §8's
// invariant is that no configuration of this tool may break a session and a validation
// log is the least load-bearing thing in the program.
export function appendOutcome(dir, record) {
  if (!record) return null
  const line = serialize(record)
  if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) return null  // see MAX_LINE_BYTES
  ensureDir(dir)
  const path = outcomeLogPath(dir)
  appendFileSync(path, line, { mode: 0o600 })  // one write, one whole line
  return path
}

// Reads the log back for analysis. Tolerant in the same way `parseTranscript` is: one
// torn or malformed line — the exact thing a crash mid-append would leave — must not cost
// the rest of the dataset.
export function parseOutcomeLog(text) {
  const records = []
  let malformed = 0
  for (const line of String(text).split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let rec
    try { rec = JSON.parse(trimmed) } catch { malformed++; continue }
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) { malformed++; continue }
    records.push(rec)
  }
  return { records, malformed }
}

// The fast-path predictor M4 tests against `log_length_baseline` (§9.1): the share of
// SCORED referents that resolved. `indeterminate` is excluded from the denominator for
// the same reason §6 excludes it from the bar — it marks a count the index cannot turn
// into a verdict. Null, not 0 or 1, when there is nothing to score: a turn with no
// referents is missing data for this predictor, and scoring it as either extreme would
// manufacture signal.
export function groundingRatio(record) {
  const scored = int(record.grounded) + int(record.unresolved) + int(record.ambiguous)
  if (scored <= 0) return null
  return int(record.grounded) / scored
}
