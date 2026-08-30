// Constraint inventory and the length baseline (spec §3.3 steps 4-5).
//
// These are counted separately from referents, and from each other, because they are the
// drivers that actually move outcomes — an acceptance criterion changes what gets built,
// a synonym does not. Folding them into one scalar would hide exactly the signal §9's M4
// validation needs to check the composite against.
import { PATH_RE } from './context-index.mjs'

const FENCE_RE = /```[\s\S]*?```/g

// Deliberately literal markers rather than fuzzy scoring: an inventory that can be read
// off the prompt by hand is one whose number a user can trust.
const ACCEPTANCE_RE = [
  /\bacceptance criteri(?:on|a)\b/gi,
  /\bmust\b/gi, /\bshould\b/gi, /\bhas to\b/gi, /\bneeds? to\b/gi,
  /\bso that\b/gi, /\bexpect(?:s|ed)?\b/gi, /\bverif(?:y|ies|ied)\b/gi,
  /\bassert(?:s|ion)?\b/gi, /\bdone when\b/gi,
  /^\s*[-*]\s*\[[ xX]\]/gm,
]

const IO_RE = [
  /\breturns?\b/gi, /\btakes?\b/gi, /\baccepts?\b/gi, /\bgiven\b/gi,
  /\binput\b/gi, /\boutput\b/gi, /\bstdin\b/gi, /\bstdout\b/gi,
  /\bexit code\b/gi, /\bschema\b/gi, /\bsignature\b/gi, /\bparameters?\b/gi,
  /\bargument\b/gi, /=>/g, /->/g,
]

const FORMAT_RE = [
  /\bmarkdown\b/gi, /\bjson\b/gi, /\byaml\b/gi, /\bcsv\b/gi, /\btoml\b/gi,
  /\btable\b/gi, /\bbullet(?:s|ed)?\b/gi, /\bone[- ]liner?\b/gi, /\bno prose\b/gi,
  /\bformat(?:ted|ting)?\b/gi, /\bplain text\b/gi, /\bdiff\b/gi,
]

const countAll = (text, patterns) =>
  patterns.reduce((n, re) => { re.lastIndex = 0; return n + [...text.matchAll(re)].length }, 0)

export function inventory(promptText) {
  const text = String(promptText)
  // Fenced blocks are stripped for the prose-marker classes (a pasted log is not the
  // user specifying acceptance criteria) but their presence is itself a format signal.
  const prose = text.replace(FENCE_RE, ' ')
  FENCE_RE.lastIndex = 0
  const fences = [...text.matchAll(FENCE_RE)].length

  PATH_RE.lastIndex = 0
  const named = new Set([...text.matchAll(PATH_RE)].map((m) => m[0]))

  return {
    acceptance: countAll(prose, ACCEPTANCE_RE),
    io_spec: countAll(prose, IO_RE),
    named_files: named.size,
    format: countAll(prose, FORMAT_RE) + fences,
  }
}

// No tokenizer is available under the stdlib-only rule, so this is an ESTIMATE, and it is
// used only as a baseline to beat — never as a score. ~4 chars/token is the usual English
// rule of thumb; the word-count floor keeps whitespace-heavy pastes from reading as huge.
export function estimateTokens(text) {
  const s = String(text)
  if (!s.trim()) return 0
  const words = s.trim().split(/\s+/).length
  return Math.max(1, Math.round((Math.ceil(s.length / 4) + words) / 2))
}

// Spec §3.3 step 5: log(token_count), recorded alongside everything else so any composite
// score can be checked against it. If the machinery cannot beat word count, it is not
// earning its keep.
export function logLengthBaseline(tokens) {
  return Number(Math.log(Math.max(1, tokens)).toFixed(4))
}
