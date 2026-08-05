// Text extraction for the factory gate.
//
// Everything here parses ATTACKER-INFLUENCED text (issue bodies are public on an open-source
// repo). None of it is handed to a model — it is deterministic parsing whose output is a number,
// a list of globs, or null. That is the point: the parts of the gate that decide whether a change
// may merge must not be a judgement call an injected instruction can move.
//
// Fail-closed is the rule throughout: ambiguity returns null / empty, and callers treat that as
// a FAILED condition, never as "no constraint".

/**
 * Remove the parts of a markdown body that must NOT contribute a `Closes #N` link:
 * fenced code blocks, inline code spans, HTML comments, and blockquotes.
 *
 * This mirrors dmarcheck's routine-gate: a `Closes #12` shown as an EXAMPLE inside a code fence
 * or quoted from another comment is not a declaration of intent by this issue's author.
 * @param {string} body
 * @returns {string}
 */
export function stripNonSemantic(body) {
  let s = String(body == null ? '' : body)
  s = s.replace(/<!--[\s\S]*?-->/g, ' ')          // HTML comments
  s = s.replace(/^[ \t]*(?:```|~~~)[^\n]*\n[\s\S]*?^[ \t]*(?:```|~~~)[ \t]*$/gm, ' ') // fenced blocks
  s = s.replace(/^[ \t]*(?:```|~~~)[\s\S]*$/m, ' ')  // an UNCLOSED fence swallows the rest
  s = s.replace(/`[^`\n]*`/g, ' ')                // inline code spans
  s = s.replace(/^[ \t]*>.*$/gm, ' ')             // blockquoted lines
  return s
}

// GitHub's closing keywords. Kept explicit rather than clever: this set decides what counts as
// "this PR resolves that issue", so it should be readable at a glance.
const CLOSING_KEYWORDS = 'close[sd]?|fix(?:e[sd])?|resolve[sd]?'
const CLOSES_RE = new RegExp(String.raw`\b(?:${CLOSING_KEYWORDS})\s*:?\s+#(\d+)\b`, 'gi')

/**
 * Extract THE single issue this text closes.
 *
 * Fail-closed on both edges: zero references and ambiguous (>1 DISTINCT) references both return
 * null. A gate that guesses which issue a PR belongs to cannot enforce scope.
 * @param {string} body
 * @returns {{ number: number|null, found: number[] }}
 */
export function extractCloses(body) {
  const clean = stripNonSemantic(body)
  const found = []
  for (const m of clean.matchAll(CLOSES_RE)) {
    const n = Number.parseInt(m[1], 10)
    if (Number.isInteger(n) && n > 0 && !found.includes(n)) found.push(n)
  }
  return { number: found.length === 1 ? found[0] : null, found }
}

/**
 * Extract the declared scope globs from a ```scope fenced block in an issue body.
 *
 * The scope block is the issue author's declaration of which files a fix is allowed to touch.
 * An issue with NO scope block yields an empty list — and an empty list means EVERY changed file
 * is drift (see checkScopeDrift). No declared scope is not "anything goes"; it is "not safe yet".
 * @param {string} body
 * @returns {string[]}
 */
export function extractScopeGlobs(body) {
  const s = String(body == null ? '' : body)
  const block = s.match(/^[ \t]*(?:```|~~~)[ \t]*scope[ \t]*\n([\s\S]*?)^[ \t]*(?:```|~~~)[ \t]*$/mi)
  if (!block) return []
  return block[1]
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    // tolerate list markers so a human writing `- src/**` in the block still works
    .map((l) => l.replace(/^[-*+]\s+/, '').trim())
    .filter(Boolean)
}
