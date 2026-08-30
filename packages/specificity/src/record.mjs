// Assembles the §6 cache record from the fast-path pieces.
//
// `phase` is "skipped", not "fast", when no sampler is wired up. That distinction is the
// difference between a status line that shows fast-path fields and one that shows a
// "sampling" placeholder forever — M1 ships without a sampler, so claiming a sample is
// in flight would be a lie the renderer then displays every turn.
import { inventory, estimateTokens, logLengthBaseline } from './constraints.mjs'
import { resolveReferents, tally } from './referents.mjs'

export function buildFastBlock(promptText, referents, index) {
  const resolved = resolveReferents(referents, index)
  const counts = tally(resolved)
  const prompt_tokens = estimateTokens(promptText)
  return {
    referents: resolved,
    unresolved: counts.unresolved,
    ambiguous: counts.ambiguous,
    grounded: counts.grounded,
    indeterminate: counts.indeterminate,
    constraints: inventory(promptText),
    prompt_tokens,
    log_length_baseline: logLengthBaseline(prompt_tokens),
  }
}

export function buildRecord({ session_id, prompt_id, fast, phase, nowMs = Date.now() }) {
  return {
    session_id,
    prompt_id: prompt_id || null,
    written_at: Number((nowMs / 1000).toFixed(3)),
    phase,
    fast: fast || null,
  }
}

// Human-readable one-liner for `systemMessage` — shown to the USER and not to Claude,
// which is the right channel for a number the model should not be optimizing against.
export function summarize(fast) {
  if (!fast) return 'specificity: unavailable'
  // Scored referents only — indeterminate pronouns are not part of the denominator.
  const scored = (fast.grounded || 0) + fast.unresolved + fast.ambiguous
  const c = fast.constraints
  const grounding = scored === 0 ? 'no scorable referents' : `${fast.grounded}/${scored} referents grounded`
  const constraints = `constraints: ${c.acceptance} acceptance, ${c.io_spec} i/o, ${c.named_files} files, ${c.format} format`
  return `specificity (fast): ${grounding}; ${fast.unresolved} unresolved, ${fast.ambiguous} ambiguous; ${constraints}`
}

// The optional `additionalContext` payload (spec §3.4). Written as FACTUAL STATEMENTS,
// never imperatives: text framed as an out-of-band system command can trip Claude's
// prompt-injection defenses and get surfaced to the user instead of used as context.
export const MAX_HOOK_OUTPUT = 10000
// Measured: flagged referents per turn are p50=1, p75=11, p90=62, and a third of turns
// flag four or more. Three items covers the entire readable band and truncates the noisy
// tail; unresolved outranks ambiguous because it is the actionable class.
export const MAX_LISTED_REFERENTS = 3

export function ambiguityContext(fast) {
  if (!fast) return ''
  const flagged = fast.referents
    .filter((r) => r.status === 'unresolved' || r.status === 'ambiguous')
    .sort((a, b) => (a.status === b.status ? 0 : a.status === 'unresolved' ? -1 : 1))
  if (!flagged.length) return ''
  const shown = flagged.slice(0, MAX_LISTED_REFERENTS)
  const withheld = flagged.length - shown.length
  const lines = shown.map((r) => {
    if (r.status === 'unresolved') {
      return `The referent "${r.text}" has no matching antecedent in the current context.`
    }
    return `The referent "${r.text}" matches ${r.candidates} candidates in the current context.`
  })
  if (withheld > 0) lines.push(`${withheld} further unresolved or ambiguous referents are not listed.`)
  const body = ['Prompt-specificity fast path, for this turn:', ...lines].join('\n')
  return body.length > MAX_HOOK_OUTPUT ? `${body.slice(0, MAX_HOOK_OUTPUT - 1)}…` : body
}
