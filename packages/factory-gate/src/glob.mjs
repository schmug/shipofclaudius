// Dependency-free glob matcher for the factory gate.
//
// The repo has ZERO npm dependencies and no lockfile by design (see CLAUDE.md), so the
// gate cannot use `minimatch` the way dmarcheck's `scripts/routine-gate` does. This is a
// deliberately small subset — enough for path denylists and scope blocks, and nothing more:
//
//   **/     any number of leading path segments (including none)
//   **      any characters, crossing `/`
//   *       any characters within ONE path segment
//   ?       exactly one character within one path segment
//   {a,b}   alternation (single level, no nesting)
//
// Everything else is matched literally. Anchored at both ends — a pattern must match the
// WHOLE path, so `src/auth` never accidentally matches `src/authz/x.ts`.

const REGEX_SPECIALS = /[.+^$()|[\]\\]/g

/**
 * Compile a glob to an anchored RegExp.
 * @param {string} glob
 * @returns {RegExp}
 */
export function globToRegExp(glob) {
  const chars = [...String(glob == null ? '' : glob)]
  let re = '^'
  let braceDepth = 0

  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]

    if (c === '*') {
      if (chars[i + 1] === '*') {
        i++ // consume the second '*'
        if (chars[i + 1] === '/') {
          i++ // consume the '/' too: `**/` is an OPTIONAL any-depth prefix
          re += '(?:.*/)?'
        } else {
          re += '.*'
        }
      } else {
        re += '[^/]*'
      }
      continue
    }

    if (c === '?') { re += '[^/]'; continue }
    if (c === '{') { braceDepth++; re += '(?:'; continue }
    if (c === '}') { if (braceDepth > 0) { braceDepth--; re += ')' } else { re += '\\}' } continue }
    // A comma is alternation ONLY inside braces; a literal comma in a filename stays literal.
    if (c === ',' && braceDepth > 0) { re += '|'; continue }

    re += c.replace(REGEX_SPECIALS, '\\$&')
  }

  // An unbalanced `{` would produce an invalid RegExp and throw. Fail closed by treating the
  // whole pattern as unmatchable rather than crashing the gate.
  if (braceDepth !== 0) return /$unmatchable^/

  return new RegExp(re + '$')
}

/**
 * Does `path` match `glob`?
 * @param {string} path
 * @param {string} glob
 */
export function matches(path, glob) {
  return globToRegExp(glob).test(String(path == null ? '' : path))
}

/**
 * Does `path` match ANY of `globs`? Empty/absent list = no match (fail-closed callers rely on this).
 * @param {string} path
 * @param {string[]} globs
 * @returns {string|null} the first matching glob, or null
 */
export function firstMatch(path, globs) {
  if (!Array.isArray(globs)) return null
  for (const g of globs) {
    if (typeof g !== 'string' || !g.trim()) continue
    if (matches(path, g)) return g
  }
  return null
}
