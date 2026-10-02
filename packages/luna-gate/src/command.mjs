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
    if (c === '#' && /[\s;&|(]/.test(s[k - 1])) { const e = s.indexOf('\n', k); if (e < 0) return s.length; k = e - 1; continue }
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
// `quoted`: any quoting in the delimiter makes the body literal; otherwise the shell
// expands `$(...)` and backticks in it before the command runs.
function readHeredocDelim(s, i, pending) {
  let k = i + 2
  const strip = s[k] === '-'
  if (strip) k++
  while (s[k] === ' ' || s[k] === '\t') k++
  let word = ''
  let quoted = false
  while (k < s.length && !/[\s;&|()<>]/.test(s[k])) {
    const c = s[k]
    if (c === "'" || c === '"') { quoted = true; const e = s.indexOf(c, k + 1); const end = e < 0 ? s.length : e; word += s.slice(k + 1, end); k = end + 1; continue }
    if (c === '\\') { quoted = true; word += s[k + 1] ?? ''; k += 2; continue }
    word += c; k++
  }
  if (word) pending.push({ word, strip, quoted })
  return k
}

// At the newline that ends a line with pending heredocs: returns the index of the
// newline after the last body's delimiter line (or s.length), emptying `pending`.
// An UNQUOTED body that contains `$(` or a backtick is pushed onto `expand`: the shell
// runs those substitutions, so the caller must count them as commands.
function skipHeredocBodies(s, nl, pending, expand = null) {
  let k = nl
  while (pending.length) {
    const { word, strip, quoted } = pending.shift()
    const start = k + 1
    let bodyEnd = s.length
    for (;;) {
      if (k >= s.length) { pending.length = 0; break }
      const end = s.indexOf('\n', k + 1)
      const line = s.slice(k + 1, end < 0 ? s.length : end)
      if ((strip ? line.replace(/^\t+/, '') : line) === word) { bodyEnd = k; k = end < 0 ? s.length : end; break }
      k = end < 0 ? s.length : end
    }
    const body = s.slice(start, bodyEnd)
    if (expand && !quoted && /\$[({[]|`/.test(body)) expand.push(body)
    if (k >= s.length) return s.length
  }
  return k
}

// Bash ANSI-C quoting `$'...'`, starting at the `'` (s[i]). Returns [decoded, index of
// the closing quote]. `$'gh' pr $'create'` runs gh pr create, so it must read as such.
const SIMPLE_ESC = { a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\', "'": "'", '"': '"', '?': '?' }
function ansiC(s, i) {
  let out = ''
  let k = i + 1
  for (; k < s.length && s[k] !== "'"; k++) {
    if (s[k] !== '\\') { out += s[k]; continue }
    const n = s[++k]
    let m
    if (n in SIMPLE_ESC) out += SIMPLE_ESC[n]
    else if ((m = /^[0-7]{1,3}/.exec(s.slice(k)))) { out += String.fromCharCode(parseInt(m[0], 8)); k += m[0].length - 1 }
    else if (n === 'x' && (m = /^[0-9a-fA-F]{1,2}/.exec(s.slice(k + 1)))) { out += String.fromCharCode(parseInt(m[0], 16)); k += m[0].length }
    else if ((n === 'u' || n === 'U') && (m = new RegExp(`^[0-9a-fA-F]{1,${n === 'u' ? 4 : 8}}`).exec(s.slice(k + 1)))) { out += String.fromCodePoint(parseInt(m[0], 16)); k += m[0].length }
    else if (n === 'c' && k + 1 < s.length) { out += String.fromCharCode(s[++k].charCodeAt(0) & 31) }
    else out += '\\' + (n ?? '')
  }
  return [out, k]
}

// A small POSIX-ish tokenizer: quotes, backslashes, `$(...)` and heredocs are honoured,
// and unquoted separators become `{ sep }` objects so they can never be confused with an
// argument that happens to be the string ";".
//
// `subs` collects the inner text of every `$(...)` and backtick substitution (and every
// unquoted heredoc body that contains one), so the caller can look inside them too: opaque
// for flag parsing, not for finding a hidden `gh pr create` or a command.
// `meta.redirect` is set when an unquoted `>` or `<` (other than a heredoc) appears.
export function tokenize(s, subs = [], meta = {}) {
  const out = []
  let cur = ''
  let has = false
  let q = null
  const pending = []
  const flush = () => { if (has || cur) out.push(cur); cur = ''; has = false }
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    // `${...}` (e.g. `${x@P}` runs the command substitutions in x), `$((...))` and `$[...]`
    // can execute code without a visible `$(`; flagged wherever expansion happens.
    if (c === '$' && q !== "'" && (s[i + 1] === '{' || s[i + 1] === '[' || (s[i + 1] === '(' && s[i + 2] === '('))) meta.expansion = true
    if (c === '$' && !q && s[i + 1] === "'") { const [dec, e] = ansiC(s, i + 1); cur += dec; has = true; i = e; continue }
    if (c === '$' && !q && s[i + 1] === '"') { q = '"'; has = true; i++; continue }   // $"..." (locale) is "..."
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
    // Backslash-newline is a line continuation, outside single quotes: both characters go.
    if (c === '\\' && s[i + 1] === '\n' && q !== "'") { i++; continue }
    if (q) {
      if (c === q) q = null
      else if (c === '\\' && q === '"' && i + 1 < s.length) cur += s[++i]
      else cur += c
      continue
    }
    // An unquoted `#` starting a word comments out the rest of the line: `gh pr create
    // --head risky # --head safe` opens risky, so the comment must not supply flags.
    if (c === '#' && !cur && !has) { const e = s.indexOf('\n', i); i = (e < 0 ? s.length : e) - 1; continue }
    if (c === "'" || c === '"') { q = c; has = true; continue }
    if (c === '\\' && i + 1 < s.length) { cur += s[++i]; has = true; continue }
    if (c === '<' && s[i + 1] === '<' && s[i + 2] !== '<') { flush(); i = readHeredocDelim(s, i, pending) - 1; continue }
    if (c === '\n' && pending.length) { flush(); out.push({ sep: c }); i = skipHeredocBodies(s, i, pending, subs) - 1; continue }
    // `2>&1`, `&>file`, `>&2` are redirections, not a background `&`.
    if (c === '&' && (s[i - 1] === '>' || s[i - 1] === '<' || s[i + 1] === '>')) { cur += c; continue }
    if (SEPS.has(c)) { flush(); out.push({ sep: c }); continue }
    if (/\s/.test(c)) { flush(); continue }
    if (c === '>' || c === '<') meta.redirect = true
    cur += c
  }
  flush()
  return out
}

// True when the command (or any substitution or expandable heredoc in it) uses `${...}`,
// `$((...))` or `$[...]`: parameter/arithmetic expansion that can run code before gh.
export function hasRiskyExpansion(command, depth = 0) {
  const subs = []
  const meta = {}
  tokenize(String(command), subs, meta)
  return !!meta.expansion || (depth < 8 && subs.some((sub) => hasRiskyExpansion(sub, depth + 1)))
}

// Substitutions that only produce text: the `--body "$(cat <<'EOF' ...)"` idiom.
const TEXT_ONLY = new Set(['cat', 'echo', 'printf'])

// How many commands the line runs (separator-delimited, non-empty). The hook reviews refs
// as they are BEFORE the Bash call, so anything running alongside `gh pr create` (a `cd`,
// `git checkout`, `git commit`) can change what the PR carries. That includes commands in
// `$(...)` / backticks (and unquoted heredoc bodies), which run during expansion, before
// gh. Only a single cat/echo/printf with no redirection and no nested substitution is
// free: the `--body "$(cat <<'EOF' ...)"` idiom.
export function commandCount(command, depth = 0) {
  const subs = []
  const toks = tokenize(String(command), subs)
  let n = 0
  let inCmd = false
  for (const t of toks) {
    if (typeof t === 'string') { if (!inCmd) { n++; inCmd = true } } else inCmd = false
  }
  for (const sub of subs) {
    const inner = commandCount(sub, depth + 1)
    const meta = {}
    const nested = []
    const toks = tokenize(sub, nested, meta)
    // The text-only word must come FIRST: `PATH=/tmp/bin cat` could run any `cat`.
    const free = inner === 1 && TEXT_ONLY.has(toks[0]) && !meta.redirect && !nested.length
    if (depth > 8 || (inner > 0 && !free)) n += Math.max(inner, 1)
  }
  return n
}

// gh pr create flags that take a separate value. Their value is skipped, so a title like
// `--title "-Hotfix"` is never misread as `-H otfix`.
const VALUE_FLAGS = new Set(['--title', '-t', '--body', '-b', '--body-file', '-F', '--assignee', '-a',
  '--label', '-l', '--milestone', '-m', '--project', '-p', '--reviewer', '-r',
  '--template', '-T', '--recover'])

const isGh = (t) => typeof t === 'string' && (t === 'gh' || t.endsWith('/gh'))
// Only bare `gh` (resolved through the session's own PATH) or a standard install location
// is trusted; any other path could be a wrapper that runs the real gh somewhere else.
const TRUSTED_GH = new Set(['gh', '/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh', '/home/linuxbrew/.linuxbrew/bin/gh', '/snap/bin/gh'])

const FLAGS = [['base', '--base', '-B'], ['head', '--head', '-H'], ['repo', '--repo', '-R']]

// `-R/--repo` is inherited, so gh also accepts it before the subcommand:
// `gh -R o/r pr create` and `gh pr -R o/r create`. Skips those flags from t[j], recording
// the repo, and returns the index of the next non-flag token.
function skipRepoFlags(t, j, found) {
  for (;;) {
    const a = t[j]
    if (a === '--repo' || a === '-R') { if (typeof t[j + 1] === 'string') found.repo = t[j + 1]; j += 2 }
    else if (typeof a === 'string' && a.startsWith('--repo=')) { found.repo = a.slice(7); j++ }
    else if (typeof a === 'string' && a.startsWith('-R') && a.length > 2) { found.repo = a.slice(a[2] === '=' ? 3 : 2); j++ }
    else return j
  }
}

const CREATE = new Set(['create', 'new'])  // `gh pr new` is gh's documented alias

const SAFE_ASSIGN = /^(GH_REPO|GH_HOST|GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN|GH_PROMPT_DISABLED|GH_NO_UPDATE_NOTIFIER|GH_SPINNER_DISABLED|GH_FORCE_TTY|GH_PAGER|PAGER|NO_COLOR|CLICOLOR|CLICOLOR_FORCE|TERM|LANG|LC_[A-Z]+)=/

// A value the shell computes at run time cannot be resolved here without running it:
// $VAR, $(...), backticks, and pathname/brace/tilde expansion (`--head risk?` becomes
// `risky` if such a file exists). Git refnames cannot contain `* ? [ ~`, so rejecting
// them (quoted or not; quoting is not tracked) never blocks a real branch.
const DYNAMIC = /[$`*?[\]~{}]/

// Every `gh pr create` / `gh pr new` the command would run, including inside `$(...)` /
// backticks, as { base, head, repo } (each a string or null). `repo` also takes an inline
// `GH_REPO=...` prefix. Empty when there is none.
export function findPrCreates(command, depth = 0) {
  // No raw-text prefilter: `gh pr cre\\ate` and `gh pr cre''ate` only read as `create`
  // after tokenizing.
  if (typeof command !== 'string' || depth > 8) return []
  const subs = []
  const t = tokenize(command, subs)
  const all = []
  for (let i = 0; i + 2 < t.length; i++) {
    if (!isGh(t[i])) continue
    const found = { base: null, head: null, repo: null }
    for (const k of ['host', 'repoEnvSet', 'wrapped', 'dynamic']) Object.defineProperty(found, k, { value: undefined, writable: true, enumerable: false })
    let k = skipRepoFlags(t, i + 1, found)
    if (t[k] !== 'pr') continue
    k = skipRepoFlags(t, k + 1, found)
    if (!CREATE.has(t[k])) continue
    // Inline assignments are tri-state: absent (undefined) defers to the ambient env, while
    // an explicit `GH_HOST=` / `GH_REPO=` (even empty) overrides it, as it does for gh.
    let b = i - 1
    for (; b >= 0 && typeof t[b] === 'string' && /^[A-Za-z_][A-Za-z0-9_]*=/.test(t[b]); b--) {
      if (t[b].startsWith('GH_REPO=')) { found.repoEnvSet = true; if (!found.repo) found.repo = t[b].slice(8) || null }
      if (t[b].startsWith('GH_HOST=') && found.host === undefined) found.host = t[b].slice(8)
      // Only assignments whose effect is modelled (GH_REPO/GH_HOST) or that cannot change
      // which gh runs or what it targets are allowed. PATH, LD_PRELOAD, GIT_DIR,
      // GH_CONFIG_DIR, XDG_* and the rest could swap the binary or its context.
      if (!SAFE_ASSIGN.test(t[b])) found.wrapped = true
    }
    // `gh` must be the command word. Anything else first (`env -C dir`, `sudo`, `xargs`,
    // `sh -c`) may run it in another context, so it is reported as wrapped.
    if (b >= 0 && typeof t[b] === 'string') found.wrapped = true
    if (!TRUSTED_GH.has(t[i])) found.wrapped = true
    for (let j = k + 1; j < t.length && typeof t[j] === 'string'; j++) {
      const a = t[j]
      const next = typeof t[j + 1] === 'string' ? t[j + 1] : null
      if (VALUE_FLAGS.has(a)) { j++; continue }
      for (const [key, long, short] of FLAGS) {
        if (a === long || a === short) { if (next) { found[key] = next; j++ } }
        else if (a.startsWith(long + '=')) found[key] = a.slice(long.length + 1)
        // pflag also takes `-H=feat`: the `=` is a separator, not part of the value.
        else if (a.startsWith(short) && a.length > 2 && !a.startsWith('--')) found[key] = a.slice(a[2] === '=' ? 3 : 2)
      }
    }
    if ([found.base, found.head, found.repo, found.host].some((v) => typeof v === 'string' && DYNAMIC.test(v))) found.dynamic = true
    all.push(found)
  }
  for (const sub of subs) all.push(...findPrCreates(sub, depth + 1))
  return all
}

// The first `gh pr create`, or null.
export function parsePrCreate(command) {
  return findPrCreates(command)[0] ?? null
}
