// Gather the change a PR would carry: merge-base(base, head)..head, as a bounded bundle.
//
// Two things are deliberately kept OUT of what gets sent to the model:
//  - credential-shaped files (.env, keys, .npmrc, .dev.vars, ...). Their NAMES are listed
//    so the reviewer knows they exist; their bytes never leave the machine.
//  - lockfiles / minified bundles: huge, low-signal churn that would eat the byte budget.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'

const MAX_BUFFER = 512 * 1024 * 1024
export const MAX_FILE_BYTES = 200_000

export const SENSITIVE_GLOBS = Object.freeze([
  '**/.env', '**/.env.*', '**/*.env', '**/.envrc', '**/.dev.vars', '**/.dev.vars.*', '**/.npmrc', '**/.pypirc', '**/.netrc',
  '**/.git-credentials', '**/.aws/credentials', '**/*.pem', '**/*.key', '**/*.p12', '**/*.pfx', '**/*.jks', '**/*.keystore', '**/*.ppk',
  '**/id_rsa*', '**/id_dsa*', '**/id_ecdsa*', '**/id_ed25519*', '**/credentials.json', '**/*.tfstate', '**/*.tfstate.*',
])
export const NOISE_GLOBS = Object.freeze([
  '**/package-lock.json', '**/pnpm-lock.yaml', '**/yarn.lock', '**/bun.lockb', '**/bun.lock',
  '**/Cargo.lock', '**/poetry.lock', '**/uv.lock', '**/Gemfile.lock', '**/composer.lock', '**/go.sum',
  '**/*.min.js', '**/*.min.css', '**/*.map',
])
// icase: git pathspecs are case-sensitive even on a case-insensitive volume, so without it
// `.ENV` or `Server.PEM` would be sent.
const excludes = (globs) => globs.map((g) => `:(exclude,glob,icase)${g}`)
const PATHSPEC = ['--', '.', ...excludes(SENSITIVE_GLOBS), ...excludes(NOISE_GLOBS)]
const SENSITIVE_ONLY = ['--', ...SENSITIVE_GLOBS.map((g) => `:(glob,icase)${g}`)]

export const git = (cwd, args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: MAX_BUFFER, stdio: ['ignore', 'pipe', 'pipe'] })
const tryGit = (cwd, args) => { try { return git(cwd, args).trim() } catch { return null } }
const gitBuf = (cwd, args) =>
  execFileSync('git', args, { cwd, maxBuffer: MAX_BUFFER, stdio: ['ignore', 'pipe', 'pipe'] })

export const sha256 = (s) => createHash('sha256').update(s).digest('hex')

const isCommit = (cwd, ref) => tryGit(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])

// An explicit name prefers the remote-tracking ref (what GitHub will diff against), then
// the local branch. No name: origin/HEAD, then the usual suspects.
export function resolveBase(cwd, name) {
  const candidates = name
    ? [`origin/${name}`, name]
    : [tryGit(cwd, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']),
        'origin/main', 'origin/master', 'main', 'master']
  for (const c of candidates) if (c && isCommit(cwd, c)) return c
  return null
}

// With --head, gh skips pushing and opens the PR from the branch as it is on the remote,
// so the remote-tracking ref comes first. (A stale tracking ref is the residual risk.)
// `owner:branch` is rejected by collectChange before this is reached.
export function resolveHead(cwd, name) {
  if (!name) return 'HEAD'
  for (const c of [`origin/${name}`, name]) if (isCommit(cwd, c)) return c
  return null
}

// gh's own fallback when --base is omitted: `branch.<current>.gh-merge-base` — the
// checked-out branch, even when --head names another — then the target repo's default
// branch (origin/HEAD and friends, in resolveBase).
export function ghMergeBase(cwd) {
  const branch = tryGit(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
  return branch ? tryGit(cwd, ['config', '--get', `branch.${branch}.gh-merge-base`]) || null : null
}

// A remote URL as "host/owner/repo", or null.
export function remoteId(url) {
  const m = /^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^/:]+)(?::\d+)?[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(String(url).toLowerCase())
  return m ? `${m[1]}/${m[2]}/${m[3]}` : null
}

// Does `-R [HOST/]OWNER/REPO` (or GH_REPO) name the repository `remoteUrl` points at?
// A hostless selector means GH_HOST when set, as gh resolves it, else github.com.
export function sameRepo(repoFlag, remoteUrl, defaultHost = 'github.com') {
  const parts = String(repoFlag).toLowerCase().replace(/\.git$/, '').split('/')
  if (parts.length < 2 || parts.length > 3 || parts.some((p) => !p)) return false
  const id = remoteId(remoteUrl)
  const host = parts.length === 3 ? parts[0] : String(defaultHost || 'github.com').toLowerCase()
  return !!id && id === [host, ...parts.slice(-2)].join('/')
}

// Without -R/GH_REPO, gh targets the remote pinned by `gh repo set-default`
// (`remote.<name>.gh-resolved = base`), and otherwise picks among the remotes itself.
// Returns a reason string when that target is, or may be, a repo other than origin.
export function ghTargetMismatch(root) {
  const origin = remoteId(originUrl(root))
  const remotes = (tryGit(root, ['remote']) || '').split('\n').filter(Boolean)
  const urlOf = (r) => remoteId(tryGit(root, ['remote', 'get-url', r]) || '')
  const pins = remotes.map((r) => [r, tryGit(root, ['config', '--get', `remote.${r}.gh-resolved`])]).filter(([, v]) => v)
  if (pins.length) {
    const [name, v] = pins[0]
    const ok = v === 'base' ? urlOf(name) === origin : sameRepo(v, originUrl(root))
    return ok ? null : `\`gh repo set-default\` points gh at remote "${name}", not origin`
  }
  const other = remotes.find((r) => r !== 'origin' && urlOf(r) !== origin)
  return other ? `remote "${other}" is a different repository and no \`gh repo set-default\` pins origin, so gh may target it` : null
}

export const repoRoot = (cwd) => tryGit(cwd, ['rev-parse', '--show-toplevel'])
export const originUrl = (cwd) => tryGit(cwd, ['remote', 'get-url', 'origin']) || ''

// Parses `git diff --name-status -z` output. Renames/copies carry two paths.
export function parseNameStatus(raw) {
  const parts = raw.split('\0')
  const out = []
  for (let i = 0; i < parts.length - 1;) {
    const status = parts[i++]
    if (!status) continue
    if (status[0] === 'R' || status[0] === 'C') { out.push({ status: status[0], from: parts[i++], path: parts[i++] }) }
    else out.push({ status: status[0], path: parts[i++] })
  }
  return out
}

// Parses `git diff --raw -z --no-abbrev`: { status, from?, path, oldSha, newSha }.
export function parseRaw(raw) {
  const parts = raw.split('\0')
  const out = []
  for (let i = 0; i < parts.length - 1;) {
    const head = parts[i++]
    if (!head.startsWith(':')) continue
    const [, , oldSha, newSha, st] = head.slice(1).split(' ')
    const status = st[0]
    if (status === 'R' || status === 'C') out.push({ status, from: parts[i++], path: parts[i++], oldSha, newSha })
    else out.push({ status, path: parts[i++], oldSha, newSha })
  }
  return out
}

// Reads `.luna-gate.json` at a ref. Returns true only for an explicit `"enabled": false`.
export function optedOut(cwd, ref) {
  const raw = tryGit(cwd, ['show', `${ref}:.luna-gate.json`])
  if (raw === null) return false
  try { return JSON.parse(raw)?.enabled === false } catch { return false }
}

// `reject`: gh would open the PR from refs this machine cannot see, so reviewing local
// refs would review a substitute. Not an error to fail open on; block mode denies it.
// `from`: a pre-push hook's remote SHA. The range is then from..head DIRECTLY, not
// merge-base..head, so a rewind or a force-push shows the commits it removes too.
// `checkTarget: false` skips the gh-target rejections, for acknowledging an exact range
// that was already reviewed (the ack names it by SHA).
export function collectChange(cwd, { base = null, head = null, repo = null, ghHost = null, from = null, checkTarget = true, maxBytes }) {
  const root = repoRoot(cwd)
  if (!root) return { error: 'not inside a git repository' }
  if (checkTarget && head && head.includes(':')) {
    return { reject: `\`--head ${head}\` names a branch in another user's repository, which luna-gate cannot review locally` }
  }
  if (checkTarget && repo && !sameRepo(repo, originUrl(root), ghHost || undefined)) {
    return { reject: `\`--repo ${repo}\` (or GH_REPO) is not this checkout's origin, so luna-gate cannot resolve the PR's base and head locally` }
  }
  if (checkTarget && !repo) {
    const why = ghTargetMismatch(root)
    if (why) return { reject: `${why}; luna-gate only reviews PRs against origin` }
  }
  if (!base && !from) base = ghMergeBase(root)
  const baseRef = from ? isCommit(root, from) : resolveBase(root, base)
  if (!baseRef) return { error: from ? `remote commit ${from} is not in this clone` : `could not resolve a base branch${base ? ` for "${base}"` : ''}` }
  const headRef = resolveHead(root, head)
  if (!headRef) return { error: `could not resolve the head branch "${head}"` }
  const headSha = tryGit(root, ['rev-parse', headRef])
  const mergeBase = from ? baseRef : tryGit(root, ['merge-base', baseRef, headRef])
  if (!mergeBase) return { error: `${baseRef} and ${headRef} share no history` }

  const range = [mergeBase, headSha]
  // -C --find-copies-harder: an unchanged `.env` copied to `notes.txt` shows up as a copy.
  const allFiles = parseRaw(git(root, ['diff', '--raw', '-z', '--no-abbrev', '-M', '-C', '--find-copies-harder', ...range]))
  // A rename or copy with a credential-shaped path at EITHER end is withheld whole. The
  // excludes alone would drop only the sensitive side, and the other side would still
  // carry the bytes: `config.txt -> .env` as a full deletion hunk, `.env -> notes.txt`
  // as a full addition. Copy detection is heuristic (and gives up past diff.renameLimit),
  // so any file whose old or new blob IS a credential file's blob is withheld as well.
  // Every credential-shaped file in either tree, with its blob: a diff from the empty tree,
  // because ls-tree does not take glob/icase pathspec magic.
  const emptyTree = git(root, ['hash-object', '-t', 'tree', '/dev/null']).trim()
  const emptyBlob = git(root, ['hash-object', '-t', 'blob', '/dev/null']).trim()
  const sensitive = new Set()
  const sensitiveBlobs = new Set()
  for (const ref of [mergeBase, headSha]) {
    for (const f of parseRaw(git(root, ['diff', '--raw', '-z', '--no-abbrev', '--no-renames', emptyTree, ref, ...SENSITIVE_ONLY]))) {
      sensitive.add(f.path)
      if (f.newSha !== emptyBlob) sensitiveBlobs.add(f.newSha)
    }
  }
  // An edited copy can fall below git's similarity threshold and keep a different blob
  // while still carrying a credential line. So every line (12+ chars, trimmed) of every
  // credential-shaped file is a marker, and any changed file whose old or new content
  // contains one is withheld whole. Best effort: a secret reformatted onto a different
  // line is not caught.
  const secretLines = new Set()
  for (const sha of sensitiveBlobs) {
    let text = ''
    try { text = gitBuf(root, ['cat-file', 'blob', sha]).toString('utf8') } catch { continue }
    for (const l of text.split('\n')) { const t = l.trim(); if (t.length >= 12) secretLines.add(t) }
  }
  const carriesSecret = (sha) => {
    if (!secretLines.size || !sha || /^0+$/.test(sha)) return false
    let text = ''
    try { text = gitBuf(root, ['cat-file', 'blob', sha]).toString('utf8') } catch { return false }
    return text.split('\n').some((l) => secretLines.has(l.trim()))
  }
  const leaks = (f) => (f.from && (sensitive.has(f.from) || sensitive.has(f.path))) ||
    (!sensitive.has(f.path) && (sensitiveBlobs.has(f.newSha) || sensitiveBlobs.has(f.oldSha) ||
      carriesSecret(f.newSha) || carriesSecret(f.oldSha)))
  const pairExcludes = allFiles.filter(leaks).flatMap((f) => [f.from, f.path].filter(Boolean)).map((p) => `:(exclude,literal)${p}`)
  const pathspec = [...PATHSPEC, ...pairExcludes]
  const files = parseNameStatus(git(root, ['diff', '--name-status', '-z', '-M', ...range, ...pathspec]))
  const kept = new Set(files.flatMap((f) => [f.from, f.path]).filter(Boolean))
  // A copy's source is unchanged, so it is only "withheld" when the pair was withheld.
  const omitted = [...new Set(allFiles.flatMap((f) => (f.status === 'C' && !leaks(f) ? [f.path] : [f.from, f.path]))
    .filter((p) => p && !kept.has(p)))]

  let diff = git(root, ['diff', '--no-color', '--no-ext-diff', '-M', '--function-context', ...range, ...pathspec])
  // The cache key covers the WHOLE diff: two changes that share a truncated prefix must
  // not share a verdict.
  const fullDiffHash = sha256(diff)
  let truncated = false
  if (Buffer.byteLength(diff) > maxBytes) {
    diff = Buffer.from(diff).subarray(0, maxBytes).toString('utf8') + '\n[... diff truncated by luna-gate: byte budget reached ...]\n'
    truncated = true
  }

  // Post-image of each changed text file, smallest first, while the budget lasts. The
  // diff alone hides the callers and guards where most real bugs live.
  let budget = maxBytes - Buffer.byteLength(diff)
  const contents = []
  const skippedContents = []
  const candidates = files.filter((f) => f.status !== 'D').map((f) => {
    const size = Number(tryGit(root, ['cat-file', '-s', `${headSha}:${f.path}`]))
    return { path: f.path, size: Number.isFinite(size) ? size : Infinity }
  }).sort((a, b) => a.size - b.size)
  for (const c of candidates) {
    if (c.size > MAX_FILE_BYTES || c.size > budget) { skippedContents.push(c.path); continue }
    let buf
    try { buf = gitBuf(root, ['show', `${headSha}:${c.path}`]) } catch { skippedContents.push(c.path); continue }
    if (buf.includes(0)) continue  // binary
    contents.push({ path: c.path, text: buf.toString('utf8') })
    budget -= buf.length
  }

  const bundleHash = sha256(JSON.stringify({ fullDiffHash, diff, contents, skippedContents, omitted }))
  return {
    root, baseRef, headRef, headSha, mergeBase,
    files, omitted, diff, truncated, contents, skippedContents, bundleHash,
    ackKey: sha256(`${mergeBase}..${headSha}`),
    remote: originUrl(root),
    empty: files.length === 0,
  }
}
