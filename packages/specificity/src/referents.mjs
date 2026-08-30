// Referent extraction and resolution (spec §3.3 steps 2-3).
//
// No POS tagger, no dependency parse — regex plus word lists, because this runs on the
// critical path with a sub-2s budget and stdlib only. The heuristics are tuned to
// under-report rather than over-report: a missed referent costs a slightly generous
// score, while a false one puts a wrong ⟂ in the status line every turn and trains the
// user to ignore the field.
import { matchAll, looksLikePath, PATH_RE } from './context-index.mjs'

// Words that carry no discriminating power inside a definite description. "the config
// file" is discriminated by `config`, never by `file`.
//
// Fitted 2026-08-30 against 1,915 real user turns (19,753 definite descriptions). The
// measurement: A = how often dropping a generic head is what saves a non-empty candidate
// set (keeping it would produce a false "unresolved"); B = how often keeping the head
// would have narrowed >1 candidates to exactly 1 (a real grounding, forgone). Heads
// already listed scored A:B = 13.6:1; the *untreated* tail scored 25.4:1 across 13x the
// volume — i.e. the mechanism was right and the list was far too short. The second block
// below is that tail.
//
// `test` is retained against the analysis's recommendation to drop it. Its ratio is the
// weakest measured (A=18, B=13), but A still exceeds B, and the two errors are not
// equally bad: an A-error is a false "unresolved", which drives the ⟂ flag — the one
// actionable signal on the status line — while a B-error merely renders "ambiguous"
// instead of "grounded". Under that asymmetry, keeping it is net positive.
//
// Entries with zero observations in the corpus are also retained: DF=0 in one person's
// transcripts is not evidence a word is rare in general, and an unused entry costs a set
// lookup. `gate`, `guard`, `agent` and `lane` are this repo's house vocabulary and may
// not generalize; they are kept because a false "unresolved" is the more expensive error.
export const GENERIC_HEADS = new Set([
  'file', 'files', 'script', 'scripts', 'config', 'configs', 'function', 'functions',
  'method', 'methods', 'class', 'classes', 'module', 'modules', 'test', 'tests', 'code',
  'thing', 'things', 'one', 'ones', 'version', 'output', 'input', 'result', 'results',
  'change', 'changes', 'issue', 'pr', 'branch', 'repo', 'directory', 'folder', 'command',
  'error', 'errors', 'bug', 'bugs', 'endpoint', 'hook', 'stuff', 'part', 'bit', 'piece',
  // measured tail
  'path', 'paths', 'body', 'bodies', 'comment', 'comments', 'commit', 'commits',
  'line', 'lines', 'check', 'checks', 'suite', 'suites', 'block', 'blocks', 'shape',
  'gate', 'gates', 'text', 'agent', 'agents', 'lane', 'lanes', 'loop', 'loops',
  'run', 'runs', 'count', 'fix', 'fixes', 'set', 'sets', 'list', 'lists',
  'value', 'values', 'guard', 'guards', 'spec', 'specs', 'rule', 'rules',
  'case', 'cases', 'state', 'tree', 'doc', 'docs', 'assertion', 'assertions',
])

// Generic heads that specifically denote a file-ish thing, so a description headed by one
// is resolved against the path index rather than against arbitrary entities.
// Additions measured by path-share of matching index entities: path 43.9% (100% of its
// kept-head matches were paths), paths 85.7%, doc 76.2%, docs 69.5%. `plan`, `skill` and
// `spec` score higher still, but only because in THIS repo plans and specs literally are
// .md files — adding them would overfit to one corpus, so they are left out.
export const FILEISH_HEADS = new Set([
  'file', 'files', 'script', 'scripts', 'config', 'configs', 'module', 'modules',
  'test', 'tests', 'directory', 'folder', 'path', 'paths', 'dir', 'dirs', 'doc', 'docs',
])

//
// The second block is a measured extractor fix, not list tuning. DEFINITE_RE captures up
// to three words and trimPhrase only pops trailing FUNCTION words, so verbs, adverbs and
// quantifiers were surviving as head nouns: ten of the twenty most frequent "heads" in a
// 1,915-turn corpus were words like `has`, `never`, `only` and `above`, producing roughly
// 150 false "unresolved" verdicts. Adding them here lets trimPhrase strip them and expose
// the real head underneath.
const STOPWORDS = new Set([
  'a', 'an', 'the', 'of', 'in', 'to', 'for', 'and', 'or', 'with', 'that', 'which', 'is',
  'are', 'was', 'were', 'be', 'so', 'at', 'on', 'by', 'from', 'as', 'it', 'this', 'these',
  'those', 'we', 'you', 'i', 'they', 'my', 'our', 'your', 'their', 'its', 'if', 'then',
  'when', 'but', 'not', 'no', 'do', 'does', 'did', 'can', 'should', 'would', 'will',
  // non-noun artifacts observed stranded in the head slot
  'has', 'have', 'had', 'says', 'said', 'itself', 'never', 'always', 'only', 'above',
  'below', 'still', 'already', 'now', 'first', 'second', 'last', 'same', 'real',
  'existing', 'exactly', 'before', 'after', 'than', 'instead', 'must', 'may', 'might',
  'every', 'two', 'three',
])

// `that` after one of these is a complementizer ("make sure that it works"), not a
// referent. Cheapest fix for the single noisiest false positive in the pronoun class.
const COMPLEMENTIZER_TRIGGERS = new Set([
  'think', 'thinks', 'know', 'knows', 'knew', 'said', 'say', 'says', 'ensure', 'ensures',
  'mean', 'means', 'note', 'assume', 'believe', 'sure', 'verify', 'check', 'confirm',
  'so', 'such', 'given', 'show', 'showed', 'suggest', 'hope', 'guess', 'remember', 'see',
])

export const DEICTIC_PHRASES = [
  'same as last time', 'same as before', 'same as above', 'as we discussed',
  'like last time', 'like before', 'as before', 'as discussed', 'as above',
  'the one you made', 'the one you wrote', 'the one you built', 'the one from before',
  'that one', 'do it again', 'same again', 'last time', 'you mentioned',
  'we talked about', 'previously', 'earlier',
]

const PRONOUN_RE = /\b(it|its|it's|they|them|their|theirs|this|that|these|those)\b/gi
// Word separator is a SINGLE space, not \s+, so a phrase cannot bridge the blank runs
// that extractReferents leaves behind when it masks an already-claimed span (nor a line
// break, which is not a noun phrase either).
const DEMONSTRATIVE_RE = /\b(this|that|these|those) ([a-z][\w-]*(?: [a-z][\w-]*){0,2})\b/gi
const DEFINITE_RE = /\bthe ([a-z][\w.-]*(?: [a-z][\w.-]*){0,2})\b/gi

// Fenced blocks and inline code are explicit *constraints*, not vague references — a
// pasted stack trace should not spray referents. They are stripped before extraction and
// counted separately by the constraint inventory.
export function stripCode(text) {
  return String(text).replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ')
}

// Trims trailing function words off a captured noun phrase: "the timeout in the" -> "timeout".
function trimPhrase(phrase) {
  const words = phrase.toLowerCase().split(/\s+/).filter(Boolean)
  while (words.length && STOPWORDS.has(words[words.length - 1])) words.pop()
  return words
}

export function extractReferents(promptText) {
  const text = stripCode(promptText)
  const found = []
  // Claimed spans are blanked out of a working copy rather than merely recorded, so a
  // later, looser pattern cannot run THROUGH an earlier match. Without this, "fix the
  // timeout in src/app.mjs" loses the timeout entirely: the definite-description regex
  // greedily swallows into the adjacent path token and is then discarded as overlapping.
  // Blanking preserves offsets, so every index still refers to the original string.
  let masked = text
  const claim = (s, e) => { masked = masked.slice(0, s) + ' '.repeat(e - s) + masked.slice(e) }

  // 1. Fixed deictic back-references, longest first so "same as last time" wins over
  //    "last time".
  for (const phrase of [...DEICTIC_PHRASES].sort((a, b) => b.length - a.length)) {
    const lower = masked.toLowerCase()
    let from = 0
    for (;;) {
      const at = lower.indexOf(phrase, from)
      if (at === -1) break
      const end = at + phrase.length
      const before = at === 0 ? ' ' : lower[at - 1]
      const after = end >= lower.length ? ' ' : lower[end]
      if (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after)) {
        found.push({ text: text.slice(at, end), kind: 'deictic', words: [], at })
        claim(at, end)
      }
      from = end
    }
  }

  // 2. Path-like tokens.
  for (const m of [...masked.matchAll(PATH_RE)]) {
    found.push({ text: m[0], kind: 'file', words: [], at: m.index })
    claim(m.index, m.index + m[0].length)
  }

  // 3. Demonstrative + noun ("that file") and definite descriptions ("the config file").
  //    Both resolve the same way, so they share a kind; the surface form is kept for the
  //    ambiguity report.
  for (const re of [DEMONSTRATIVE_RE, DEFINITE_RE]) {
    for (const m of [...masked.matchAll(re)]) {
      const phrase = re === DEMONSTRATIVE_RE ? m[2] : m[1]
      const words = trimPhrase(phrase)
      if (!words.length) continue
      // Report the TRIMMED phrase ("the timeout"), not the raw match ("the timeout in") —
      // this string is what the user reads in the ⟂ report, so a dangling preposition in
      // it reads as a bug in the tool. The full match is still claimed, so the trailing
      // function word cannot be re-picked by a later pattern.
      const determiner = re === DEMONSTRATIVE_RE ? m[1].toLowerCase() : 'the'
      found.push({ text: `${determiner} ${words.join(' ')}`, kind: 'definite', words, at: m.index })
      claim(m.index, m.index + m[0].length)
    }
  }

  // 4. Whatever bare pronouns are left over.
  for (const m of [...masked.matchAll(PRONOUN_RE)]) {
    const word = m[0].toLowerCase()
    if (word === 'that') {
      const lower = masked.toLowerCase()
      const prev = lower.slice(0, m.index).trim().split(/\s+/).pop() || ''
      const next = lower.slice(m.index + m[0].length).trim().split(/\s+/)[0] || ''
      if (COMPLEMENTIZER_TRIGGERS.has(prev)) continue
      if (['we', 'you', 'i', 'it', 'they', 'he', 'she'].includes(next)) continue
    }
    found.push({ text: m[0], kind: 'pronoun', words: [], at: m.index })
    claim(m.index, m.index + m[0].length)
  }

  return found.sort((a, b) => a.at - b.at).map(({ at, ...ref }) => ref)
}

// A bare pronoun gets NO determinate status when the window is non-empty, and this is a
// measured decision, not caution.
//
// Fitted against 1,918 real turns: the pronoun branch returned "ambiguous" for ~97% of
// pronouns at EVERY window size, because two or more entities sit in the last few blocks
// almost always. Capping `recent` to the K most salient entities does not fix it — the
// split is unchanged for every K >= 2, and K = 1 manufactures groundedness by fiat: a
// hand-check of 30 sampled turns found the most-recent entity was the actual antecedent
// only ~5% of the time.
//
// The reason is structural. Pronouns in real prompts refer to claims, changes, runs,
// commits and concepts; the index holds paths and inline-code spans. The candidate TYPE is
// wrong, not the candidate COUNT, so no window and no cap can repair it.
//
// What the index CAN establish is the empty case: if nothing at all is in the window,
// there is nothing to point at, and that is a true "unresolved" (1.2-1.3% of turns) —
// which is exactly the "fix the timeout" against empty context that motivated the tool.
// Everything else is recorded as `indeterminate`, kept in the record for M4 to learn from,
// and excluded from the score and from the ⟂ report.
function statusFor(candidates, kind) {
  if (candidates === 0) return 'unresolved'
  if (kind === 'pronoun') return 'indeterminate'
  if (candidates === 1) return 'grounded'
  return 'ambiguous'
}

// Counts candidate antecedents for one referent against the index (spec §3.3 step 3).
export function countCandidates(ref, index) {
  if (ref.kind === 'file') {
    const token = ref.text
    if (index.entities.has(token)) return 1  // exact path: unambiguous by construction
    const base = token.split('/').pop()
    let n = 0
    for (const e of index.entities) if (e === token || e.split('/').pop() === base) n++
    return n
  }

  if (ref.kind === 'pronoun') {
    // A pronoun's antecedent has to be NEARBY; the whole window is not a candidate set.
    return index.recent.size
  }

  if (ref.kind === 'deictic') {
    // "like before" points at a prior turn. None to point at means unresolved; more than
    // one means the user has to say which.
    return index.priorUserTurns
  }

  // definite / demonstrative
  //
  // Genericity is a property of the HEAD SLOT, not of the word. `config` carries no
  // discriminating power as the head of "the config" but is the only thing that
  // discriminates "the config file" — so the head is dropped when generic and every
  // remaining word is kept as a modifier regardless of which list it appears on.
  const head = ref.words[ref.words.length - 1]
  const rest = ref.words.slice(0, -1).filter((w) => !STOPWORDS.has(w))
  const modifiers = GENERIC_HEADS.has(head) ? rest : [...rest, head]
  if (!modifiers.length) {
    // Nothing discriminating at all ("the file", "the tests"): the only honest candidate
    // set is what was recently in play.
    return FILEISH_HEADS.has(head) ? index.recentPaths.size : index.recent.size
  }
  const hits = matchAll(index, modifiers)
  if (FILEISH_HEADS.has(head)) {
    let n = 0
    for (const e of hits) if (looksLikePath(e)) n++
    return n
  }
  return hits.size
}

export function resolveReferents(referents, index) {
  return referents.map((ref) => {
    const candidates = countCandidates(ref, index)
    return { text: ref.text, kind: ref.kind, candidates, status: statusFor(candidates, ref.kind) }
  })
}

export function tally(resolved) {
  const count = (status) => resolved.filter((r) => r.status === status).length
  return {
    unresolved: count('unresolved'),
    ambiguous: count('ambiguous'),
    grounded: count('grounded'),
    // Recorded but deliberately excluded from the score: see statusFor().
    indeterminate: count('indeterminate'),
  }
}
