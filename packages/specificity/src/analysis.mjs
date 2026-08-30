// M4 analysis (spec §9.1) — the half that runs OFFLINE, never on the critical path.
//
// The outcome log holds counts and a `prompt_id`. The label — "did this turn need a
// follow-up correction?" — is a property of the NEXT turn, and reading it needs the
// prompt text that §9.1 deliberately keeps out of the log. So the text is read from the
// transcripts Claude Code already writes, at analysis time, and joined to the log on
// `prompt_id`. Nothing here puts prompt text on disk; the sampling command prints to
// stdout for a human to read, and the verdict file it asks for carries ids and booleans.
//
// Everything in this module is a pure function of its inputs. The CLI is `bin/analyze.mjs`.
import { groundingRatio } from './outcome-log.mjs'

// ---------------------------------------------------------------------------
// Human turns out of a transcript
// ---------------------------------------------------------------------------

// Records Claude Code writes as `type: "user"` that are not a person typing: tool
// results, slash-command envelopes, the resume caveat, injected reminders. Each is
// excluded on a structural signal where one exists (`origin.kind`, array content,
// `isMeta`) and on a prefix only where it does not.
const SYNTHETIC_PREFIX_RE = /^\s*(?:<(?:command-name|command-message|command-args|local-command-stdout|local-command-stderr|bash-input|bash-stdout|bash-stderr|user-memory-input|system-reminder)>|Caveat: The messages below|\[Request interrupted)/

// Pulls the ordered human turns out of one transcript's JSONL text.
//
// A single turn spans many `type: "user"` records — the prompt plus every tool result
// that follows — and they all share one `promptId`. Only the first, whose content is
// plain text, is the person. Deduping on `promptId` is what makes the "next turn" in
// `pairTurns` mean the next *turn* rather than the next tool result.
export function humanTurns(text) {
  const turns = []
  const seen = new Set()
  for (const line of String(text).split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let rec
    try { rec = JSON.parse(trimmed) } catch { continue }
    if (!rec || typeof rec !== 'object') continue
    if (rec.type !== 'user' || rec.isSidechain === true || rec.isMeta === true) continue
    // `origin` is present on recent versions and is the authoritative signal; when it is
    // absent the content shape below carries the decision on its own.
    if (rec.origin && rec.origin.kind && rec.origin.kind !== 'human') continue
    const content = rec.message?.content
    let body = null
    if (typeof content === 'string') body = content
    else if (Array.isArray(content) && content.length && content.every((b) => b && b.type === 'text')) {
      body = content.map((b) => b.text).join('\n')
    }
    if (typeof body !== 'string' || !body.trim()) continue
    if (SYNTHETIC_PREFIX_RE.test(body)) continue
    const promptId = typeof rec.promptId === 'string' ? rec.promptId : null
    const key = promptId || rec.uuid
    if (key && seen.has(key)) continue
    if (key) seen.add(key)
    turns.push({
      prompt_id: promptId,
      session_id: typeof rec.sessionId === 'string' ? rec.sessionId : null,
      timestamp: typeof rec.timestamp === 'string' ? rec.timestamp : null,
      text: body,
    })
  }
  return turns
}

// ---------------------------------------------------------------------------
// The correction heuristic (§9.1 decision 3)
// ---------------------------------------------------------------------------

// A correction is short AND marked. Length alone is not enough — "run the tests" is short
// and is not a correction — and markers alone are not enough either: a long turn that
// happens to contain "actually" is a fresh instruction with an aside in it, not a repair
// of the previous one. Requiring both is the conjunction that gave the fewest obvious
// errors by eye, and it is exactly the kind of guess §9.1 says must be hand-checked
// rather than trusted, so `bin/analyze.mjs sample` exists to measure what it costs.
//
// Exported because the hand-check has to be repeatable at a different setting: if the
// measured error rate is driven by length, this is the knob to sweep.
export const SHORT_TURN_WORDS = 25

// Grouped so the sample report can say WHICH family fired, which is what makes a hand
// check actionable rather than a single number.
export const CORRECTION_MARKERS = Object.freeze([
  ['negation', /^\s*(?:no|nope|nah|wrong|wait)\b/i],
  ['negation', /\bthat'?s not\b|\bthat is not\b|\bnot what i\b/i],
  ['restatement', /\bi meant\b|\bi said\b|\bi asked (?:for|you)\b|\bwhat i wanted\b/i],
  ['correction', /\bactually\b|\binstead\b|\brather than that\b/i],
  ['defect', /\bstill (?:failing|broken|wrong|not)\b|\byou (?:missed|broke|forgot|removed)\b/i],
  ['undo', /\bundo\b|\brevert (?:that|it|this)\b|\bback (?:it|that) out\b|\btry again\b/i],
])

const FENCE_RE = /```[\s\S]*?```/g

export function wordCount(text) {
  const s = String(text).replace(FENCE_RE, ' ').trim()
  return s ? s.split(/\s+/).length : 0
}

// Returns the verdict AND its reasons, so the sample worksheet can show a human why the
// heuristic said what it said instead of asking them to re-derive it.
export function detectCorrection(text) {
  const words = wordCount(text)
  const body = String(text).replace(FENCE_RE, ' ')
  const markers = []
  for (const [family, re] of CORRECTION_MARKERS) {
    if (re.test(body) && !markers.includes(family)) markers.push(family)
  }
  const short = words > 0 && words <= SHORT_TURN_WORDS
  return { correction: short && markers.length > 0, short, words, markers }
}

// ---------------------------------------------------------------------------
// Joining log records to labels
// ---------------------------------------------------------------------------

// Labels each turn from the one that FOLLOWS it in the same session. The last turn of a
// session has no successor and is therefore unlabelled, not labelled negative — an
// unfinished session is missing data, and calling it "no correction needed" would bias
// the positive rate downward by exactly one row per session.
export function pairTurns(turns) {
  const pairs = []
  for (let i = 0; i < turns.length - 1; i++) {
    const cur = turns[i]
    const next = turns[i + 1]
    if (cur.session_id && next.session_id && cur.session_id !== next.session_id) continue
    if (!cur.prompt_id) continue
    const detail = detectCorrection(next.text)
    pairs.push({ prompt_id: cur.prompt_id, label: detail.correction, detail, next_text: next.text })
  }
  return pairs
}

// Joins outcome-log records to labels on `prompt_id`. A record with no matching turn is
// dropped and counted: the transcript may have been deleted, or the turn may be the last
// one in a live session and not yet followed by anything.
export function joinLabels(records, pairs) {
  const byId = new Map()
  for (const p of pairs) if (p.prompt_id) byId.set(p.prompt_id, p)
  const rows = []
  let unmatched = 0
  for (const rec of records) {
    const p = rec && typeof rec.prompt_id === 'string' ? byId.get(rec.prompt_id) : null
    if (!p) { unmatched++; continue }
    rows.push({
      prompt_id: rec.prompt_id,
      label: p.label,
      detail: p.detail,
      grounding_ratio: groundingRatio(rec),
      log_length_baseline: typeof rec.log_length_baseline === 'number' ? rec.log_length_baseline : null,
    })
  }
  return { rows, unmatched }
}

// ---------------------------------------------------------------------------
// Does the score predict anything?
// ---------------------------------------------------------------------------

// AUC via the Mann–Whitney U identity, with midranks so ties score 0.5 rather than
// silently favouring whichever way the sort happened to fall. Returns null when either
// class is empty — an AUC over one class is not a weak result, it is not a result.
//
// AUC is the right statistic here because both candidate predictors are continuous and
// neither has a threshold anyone has picked yet; it asks only whether the ordering
// carries information, which is precisely M4's question.
export function auc(scores, labels) {
  const pts = []
  for (let i = 0; i < scores.length; i++) {
    const s = scores[i]
    if (typeof s !== 'number' || !Number.isFinite(s)) continue  // missing predictor: excluded
    pts.push({ s, y: labels[i] ? 1 : 0 })
  }
  const pos = pts.filter((p) => p.y === 1).length
  const neg = pts.length - pos
  if (!pos || !neg) return null
  pts.sort((a, b) => a.s - b.s)
  const ranks = new Array(pts.length)
  for (let i = 0; i < pts.length;) {
    let j = i
    while (j + 1 < pts.length && pts[j + 1].s === pts[i].s) j++
    const mid = (i + j) / 2 + 1  // 1-based midrank
    for (let k = i; k <= j; k++) ranks[k] = mid
    i = j + 1
  }
  let sumPos = 0
  for (let i = 0; i < pts.length; i++) if (pts[i].y === 1) sumPos += ranks[i]
  return (sumPos - (pos * (pos + 1)) / 2) / (pos * neg)
}

// Wilson score interval — the small-sample-honest one. A hand-check is 30 rows, where the
// normal approximation is wrong in the direction that flatters the result.
export function wilson(successes, n, z = 1.96) {
  if (!n) return { low: 0, high: 1 }
  const p = successes / n
  const d = 1 + (z * z) / n
  const centre = p + (z * z) / (2 * n)
  const half = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))
  return { low: Math.max(0, (centre - half) / d), high: Math.min(1, (centre + half) / d) }
}

// Both predictors are oriented so that HIGHER means "more likely to need a correction":
// grounding is negated (a well-grounded turn should need fewer corrections), length is
// not (a longer prompt is the naive proxy for a harder turn). Reporting them on the same
// orientation is what makes the two AUCs comparable at all; an AUC below 0.5 on either
// means the predictor is anti-correlated, which is a finding, not a bug.
export function compare(rows) {
  const labels = rows.map((r) => r.label)
  const grounding = rows.map((r) => (typeof r.grounding_ratio === 'number' ? -r.grounding_ratio : null))
  const baseline = rows.map((r) => r.log_length_baseline)
  const scored = rows.filter((r) => typeof r.grounding_ratio === 'number').length
  const positives = labels.filter(Boolean).length
  const a = auc(grounding, labels)
  const b = auc(baseline, labels)
  return {
    n: rows.length,
    positives,
    positive_rate: rows.length ? positives / rows.length : 0,
    scorable: scored,
    grounding_auc: a,
    baseline_auc: b,
    // Deliberately not a p-value: with one dataset, no pre-registration and a label whose
    // own error rate is being measured separately, a significance claim would be the
    // kind of overreach §9.1 exists to prevent. The margin is reported raw.
    margin: a !== null && b !== null ? a - b : null,
    beats_baseline: a !== null && b !== null ? a > b : null,
  }
}

// ---------------------------------------------------------------------------
// Sampling for the hand-check
// ---------------------------------------------------------------------------

// mulberry32 — a seeded PRNG, because the sample has to be reproducible: a hand-check is
// only worth anything if the rows a person judged are the rows the error rate is computed
// over, and `Math.random()` cannot promise that across two invocations.
export function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Stratified: half the sample from rows the heuristic called a correction, half from the
// rest. Corrections are the minority class by a wide margin, so a uniform sample of 30
// would contain one or two of them and measure the false-NEGATIVE rate not at all.
export function sampleRows(rows, n, seed = 1) {
  const rand = rng(seed)
  const shuffle = (xs) => {
    const a = xs.slice()
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1))
      ;[a[i], a[j]] = [a[j], a[i]]
    }
    return a
  }
  const pos = shuffle(rows.filter((r) => r.label))
  const neg = shuffle(rows.filter((r) => !r.label))
  const want = Math.min(n, rows.length)
  const takePos = Math.min(pos.length, Math.ceil(want / 2))
  const takeNeg = Math.min(neg.length, want - takePos)
  const out = [...pos.slice(0, takePos), ...neg.slice(0, takeNeg)]
  // Top up from whichever side has slack, so `--n 30` yields 30 rows when 30 exist.
  if (out.length < want) out.push(...pos.slice(takePos, takePos + (want - out.length)))
  if (out.length < want) out.push(...neg.slice(takeNeg, takeNeg + (want - out.length)))
  return out
}

// Scores the heuristic against hand verdicts. This is the number §9.1 refuses to do
// without: it is what separates "the score does not predict corrections" from "the label
// was never measuring corrections", and only one of those is a reason to cut the sampler.
export function scoreVerdicts(rows, verdicts) {
  const truth = new Map()
  for (const v of verdicts) {
    if (v && typeof v.prompt_id === 'string' && typeof v.correction === 'boolean') {
      truth.set(v.prompt_id, v.correction)
    }
  }
  let tp = 0, fp = 0, tn = 0, fn = 0, missing = 0
  for (const r of rows) {
    if (!truth.has(r.prompt_id)) { missing++; continue }
    const actual = truth.get(r.prompt_id)
    if (r.label && actual) tp++
    else if (r.label && !actual) fp++
    else if (!r.label && actual) fn++
    else tn++
  }
  const n = tp + fp + tn + fn
  const wrong = fp + fn
  return {
    n,
    checked_missing: missing,
    true_positive: tp,
    false_positive: fp,
    true_negative: tn,
    false_negative: fn,
    error_rate: n ? wrong / n : null,
    error_rate_ci: n ? wilson(wrong, n) : null,
    precision: tp + fp ? tp / (tp + fp) : null,
    recall: tp + fn ? tp / (tp + fn) : null,
  }
}
