// Recognise `gh pr create` inside a Bash tool call and pull out --base / --head.
//
// The hook's `if: "Bash(gh pr create *)"` filter is best-effort (the harness runs the hook
// anyway when it cannot tell what a command does), so the script re-checks here. A quoted
// string that merely CONTAINS the words — `echo "gh pr create"` — is one token, not three,
// and does not match.

const SEPS = new Set([';', '&', '|', '(', ')', '\n'])

// Index just past the `)` closing the `$(` at s[i], or s.length. Quotes, nested parens
// and heredoc bodies inside are skipped, so the usual
//   --body "$(cat <<'EOF' ... EOF
//   )"
// stays one opaque token whatever the body says, including a stray `"` or `--base x`.
function skipSubst(s, i) {
  let depth = 0
  const pending = []
  for (let k = i + 1; k < s.length; k++) {
    const c = s[k]
    if (c === '\\') { k++; continue }
    if (c === '\n' && pending.length) { k = skipHeredocBodies(s, k, pending) - 1; continue }
    if (c === "'") { const e = s.indexOf("'", k + 1); if (e < 0) return s.length; k = e; continue }
    if (c === '"') { k = skipDouble(s, k) - 1; continue }
    if (c === '`') { const e = s.indexOf('`', k + 1); if (e < 0) return s.length; k = e; continue }
    if (c === '<' && s[k + 1] === '<' && s[k + 2] !== '<') { k = readHeredocDelim(s, k, pending) - 1; continue }
    if (c === '(') depth++
    else if (c === ')' && --depth === 0) return k + 1
  }
  return s.length
}

// Index just past the `"` closing the double quote opened at s[i].
function skipDouble(s, i) {
  for (let k = i + 1; k < s.length; k++) {
    if (s[k] === '\\') { k++; continue }
    if (s[k] === '$' && s[k + 1] === '(') { k = skipSubst(s, k) - 1; continue }
    if (s[k] === '"') return k + 1
  }
  return s.length
}

// At `<<` (or `<<-`): records the delimiter in `pending`, returns the index after it.
function readHeredocDelim(s, i, pending) {
  let k = i + 2
  const strip = s[k] === '-'
  if (strip) k++
  while (s[k] === ' ' || s[k] === '\t') k++
  let word = ''
  while (k < s.length && !/[\s;&|()<>]/.test(s[k])) {
    const c = s[k]
    if (c === "'" || c === '"') { const e = s.indexOf(c, k + 1); const end = e < 0 ? s.length : e; word += s.slice(k + 1, end); k = end + 1; continue }
    if (c === '\\') { word += s[k + 1] ?? ''; k += 2; continue }
    word += c; k++
  }
  if (word) pending.push({ word, strip })
  return k
}

// At the newline that ends a line with pending heredocs: returns the index of the
// newline after the last body's delimiter line (or s.length), emptying `pending`.
function skipHeredocBodies(s, nl, pending) {
  let k = nl
  while (pending.length) {
    const { word, strip } = pending.shift()
    for (;;) {
      if (k >= s.length) { pending.length = 0; return s.length }
      const end = s.indexOf('\n', k + 1)
      const line = s.slice(k + 1, end < 0 ? s.length : end)
      k = end < 0 ? s.length : end
      if ((strip ? line.replace(/^\t+/, '') : line) === word) break
    }
  }
  return k
}

// A small POSIX-ish tokenizer: quotes, backslashes, `$(...)` and heredocs are honoured,
// and unquoted separators become `{ sep }` objects so they can never be confused with an
// argument that happens to be the string ";".
//
// `subs` collects the inner text of every `$(...)` and backtick substitution, so the caller
// can look inside them too: opaque for flag parsing, not for finding a hidden `gh pr create`.
export function tokenize(s, subs = []) {
  const out = []
  let cur = ''
  let has = false
  let q = null
  const pending = []
  const flush = () => { if (has || cur) out.push(cur); cur = ''; has = false }
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '$' && s[i + 1] === '(' && q !== "'") {
      const j = skipSubst(s, i)
      subs.push(s.slice(i + 2, j - 1))
      cur += s.slice(i, j); has = true; i = j - 1
      continue
    }
    if (c === '`' && q !== "'") {
      const e = s.indexOf('`', i + 1)
      const j = e < 0 ? s.length : e + 1
      subs.push(s.slice(i + 1, e < 0 ? s.length : e))
      cur += s.slice(i, j); has = true; i = j - 1
      continue
    }
    if (q) {
      if (c === q) q = null
      else if (c === '\\' && q === '"' && i + 1 < s.length) cur += s[++i]
      else cur += c
      continue
    }
    if (c === "'" || c === '"') { q = c; has = true; continue }
    if (c === '\\' && i + 1 < s.length) { cur += s[++i]; has = true; continue }
    if (c === '<' && s[i + 1] === '<' && s[i + 2] !== '<') { flush(); i = readHeredocDelim(s, i, pending) - 1; continue }
    if (c === '\n' && pending.length) { flush(); out.push({ sep: c }); i = skipHeredocBodies(s, i, pending) - 1; continue }
    if (SEPS.has(c)) { flush(); out.push({ sep: c }); continue }
    if (/\s/.test(c)) { flush(); continue }
    cur += c
  }
  flush()
  return out
}

// gh pr create flags that take a separate value. Their value is skipped, so a title like
// `--title "-Hotfix"` is never misread as `-H otfix`.
const VALUE_FLAGS = new Set(['--title', '-t', '--body', '-b', '--body-file', '-F', '--assignee', '-a',
  '--label', '-l', '--milestone', '-m', '--project', '-p', '--reviewer', '-r',
  '--template', '-T', '--recover'])

const isGh = (t) => typeof t === 'string' && (t === 'gh' || t.endsWith('/gh'))

const FLAGS = [['base', '--base', '-B'], ['head', '--head', '-H'], ['repo', '--repo', '-R']]

// `-R/--repo` is inherited, so gh also accepts it before the subcommand:
// `gh -R o/r pr create` and `gh pr -R o/r create`. Skips those flags from t[j], recording
// the repo, and returns the index of the next non-flag token.
function skipRepoFlags(t, j, found) {
  for (;;) {
    const a = t[j]
    if (a === '--repo' || a === '-R') { if (typeof t[j + 1] === 'string') found.repo = t[j + 1]; j += 2 }
    else if (typeof a === 'string' && a.startsWith('--repo=')) { found.repo = a.slice(7); j++ }
    else if (typeof a === 'string' && a.startsWith('-R') && a.length > 2) { found.repo = a.slice(2); j++ }
    else return j
  }
}

// Every `gh pr create` the command would run, including inside `$(...)` / backticks, as
// { base, head, repo } (each a string or null). Empty when there is none.
export function findPrCreates(command, depth = 0) {
  if (typeof command !== 'string' || !command.includes('create') || depth > 8) return []
  const subs = []
  const t = tokenize(command, subs)
  const all = []
  for (let i = 0; i + 2 < t.length; i++) {
    if (!isGh(t[i])) continue
    const found = { base: null, head: null, repo: null }
    let k = skipRepoFlags(t, i + 1, found)
    if (t[k] !== 'pr') continue
    k = skipRepoFlags(t, k + 1, found)
    if (t[k] !== 'create') continue
    for (let j = k + 1; j < t.length && typeof t[j] === 'string'; j++) {
      const a = t[j]
      const next = typeof t[j + 1] === 'string' ? t[j + 1] : null
      if (VALUE_FLAGS.has(a)) { j++; continue }
      for (const [key, long, short] of FLAGS) {
        if (a === long || a === short) { if (next) { found[key] = next; j++ } }
        else if (a.startsWith(long + '=')) found[key] = a.slice(long.length + 1)
        else if (a.startsWith(short) && a.length > 2 && !a.startsWith('--')) found[key] = a.slice(2)
      }
    }
    all.push(found)
  }
  for (const sub of subs) all.push(...findPrCreates(sub, depth + 1))
  return all
}

// The first `gh pr create`, or null.
export function parsePrCreate(command) {
  return findPrCreates(command)[0] ?? null
}
