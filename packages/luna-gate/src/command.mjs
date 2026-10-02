// Recognise `gh pr create` inside a Bash tool call and pull out --base / --head.
//
// The hook's `if: "Bash(gh pr create *)"` filter is best-effort (the harness runs the hook
// anyway when it cannot tell what a command does), so the script re-checks here. A quoted
// string that merely CONTAINS the words — `echo "gh pr create"` — is one token, not three,
// and does not match.

const SEPS = new Set([';', '&', '|', '(', ')', '\n'])

// A small POSIX-ish tokenizer: quotes and backslashes are honoured, and unquoted
// separators become `{ sep }` objects so they can never be confused with an argument
// that happens to be the string ";".
export function tokenize(s) {
  const out = []
  let cur = ''
  let has = false
  let q = null
  const flush = () => { if (has || cur) out.push(cur); cur = ''; has = false }
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (q) {
      if (c === q) q = null
      else if (c === '\\' && q === '"' && i + 1 < s.length) cur += s[++i]
      else cur += c
      continue
    }
    if (c === "'" || c === '"') { q = c; has = true; continue }
    if (c === '\\' && i + 1 < s.length) { cur += s[++i]; has = true; continue }
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
  '--label', '-l', '--milestone', '-m', '--project', '-p', '--reviewer', '-r', '--repo', '-R',
  '--template', '-T', '--recover'])

const isGh = (t) => typeof t === 'string' && (t === 'gh' || t.endsWith('/gh'))

// Returns null when the command does not run `gh pr create`; otherwise { base, head },
// each a string or null.
export function parsePrCreate(command) {
  if (typeof command !== 'string' || !command.includes('create')) return null
  const t = tokenize(command)
  for (let i = 0; i + 2 < t.length; i++) {
    if (!(isGh(t[i]) && t[i + 1] === 'pr' && t[i + 2] === 'create')) continue
    const found = { base: null, head: null }
    for (let j = i + 3; j < t.length && typeof t[j] === 'string'; j++) {
      const a = t[j]
      const next = typeof t[j + 1] === 'string' ? t[j + 1] : null
      if (VALUE_FLAGS.has(a)) { j++; continue }
      for (const [key, long, short] of [['base', '--base', '-B'], ['head', '--head', '-H']]) {
        if (a === long || a === short) { if (next) { found[key] = next; j++ } }
        else if (a.startsWith(long + '=')) found[key] = a.slice(long.length + 1)
        else if (a.startsWith(short) && a.length > 2 && !a.startsWith('--')) found[key] = a.slice(2)
      }
    }
    return found
  }
  return null
}
