// The candidate index: everything in the window (plus the repo on disk) that a referent
// in the submitted turn could be pointing AT.
//
// This is the object that makes the score conditional. A prompt string has no
// specificity on its own — "fix the timeout" is fully grounded when exactly one timeout
// is in the window and vacuous when none is. Resolution is therefore a lookup against
// this index, never a property of the prompt text.
// Fitted 2026-08-30 against 1,915 real turns: the distance from a pronoun to its nearest
// plausible antecedent is p50=1, p90=2, p99=3 blocks. W=3 covers 95.7% of pronoun turns,
// within 0.4pp of the W=infinity ceiling of 96.4%, while carrying 25% fewer candidate
// entities than the original 6.
export const RECENT_BLOCKS = 3

// Anything with a slash, or a bare filename with a known-ish extension.
export const PATH_RE = /\b[\w.@~-]*(?:\/[\w.@-]+)+\b|\b[\w-]+\.(?:m?[jt]sx?|py|rb|go|rs|java|kt|swift|c|h|hpp|cpp|cs|sh|bash|zsh|md|json|jsonc|toml|ya?ml|html?|css|scss|sql|txt|lock|cfg|ini|env|proto|graphql)\b/g
const BACKTICK_RE = /`([^`\n]{1,80})`/g
// Non-global twin of PATH_RE. `test()` on a /g regex advances lastIndex, so reusing
// PATH_RE for predicate checks makes the answer depend on call order.
const IS_PATH_RE = new RegExp(PATH_RE.source)

export function looksLikePath(s) { return IS_PATH_RE.test(String(s)) }

// Splits an entity into the lowercase terms it can be matched on: path segments,
// extension, and camelCase/snake_case components. `src/config/loader.mjs` therefore
// indexes under src, config, loader and mjs — which is what lets "the config file"
// find it.
export function termsOf(entity) {
  const out = new Set()
  for (const chunk of String(entity).split(/[^A-Za-z0-9]+/)) {
    if (!chunk) continue
    for (const piece of chunk.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/\s+/)) {
      const t = piece.toLowerCase()
      if (t.length >= 2) out.add(t)
    }
  }
  return out
}

function harvest(text, into) {
  for (const m of String(text).matchAll(PATH_RE)) into.add(m[0])
  for (const m of String(text).matchAll(BACKTICK_RE)) {
    const span = m[1].trim()
    if (span && span.length <= 80 && !/\s{2,}/.test(span)) into.add(span)
  }
}

// `blocks` are the transcript blocks (oldest first); `files` are repo-relative paths from
// the bounded disk walk. Disk paths are indexed but deliberately NOT counted as "recent":
// a file existing in the repo cannot be what "it" refers to.
export function buildIndex({ blocks = [], files = [] } = {}) {
  const entities = new Set()
  const recent = new Set()
  const start = Math.max(0, blocks.length - RECENT_BLOCKS)

  blocks.forEach((block, i) => {
    const found = new Set()
    harvest(block.text, found)
    for (const e of found) {
      entities.add(e)
      if (i >= start) recent.add(e)
    }
  })

  const onDisk = new Set(files)
  for (const f of files) entities.add(f)

  const byTerm = new Map()
  for (const entity of entities) {
    for (const term of termsOf(entity)) {
      let bucket = byTerm.get(term)
      if (!bucket) byTerm.set(term, (bucket = new Set()))
      bucket.add(entity)
    }
  }

  return {
    entities,
    onDisk,
    recent,
    byTerm,
    priorUserTurns: blocks.filter((b) => b.role === 'user').length,
    // Recent entities that are plausible *files*, used when a definite description has a
    // generic file-ish head and no discriminating modifier ("the file", "the tests").
    recentPaths: new Set([...recent].filter(looksLikePath)),
  }
}

// Distinct entities carrying every one of `terms`. Empty term list means "no constraint",
// which callers handle themselves rather than getting the whole index back.
export function matchAll(index, terms) {
  const list = [...terms]
  if (!list.length) return new Set()
  let acc = null
  for (const term of list) {
    const bucket = index.byTerm.get(term)
    if (!bucket || bucket.size === 0) return new Set()
    acc = acc === null ? new Set(bucket) : new Set([...acc].filter((e) => bucket.has(e)))
    if (acc.size === 0) return acc
  }
  return acc || new Set()
}
