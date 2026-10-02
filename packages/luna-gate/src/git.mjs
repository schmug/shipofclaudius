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

// Does `-R [HOST/]OWNER/REPO` name the repository `origin` points at?
export function sameRepo(repoFlag, remoteUrl) {
  const parts = String(repoFlag).toLowerCase().replace(/\.git$/, '').split('/')
  if (parts.length < 2 || parts.length > 3 || parts.some((p) => !p)) return false
  const [owner, repo] = parts.slice(-2)
  const host = parts.length === 3 ? parts[0] : 'github.com'
  const m = /^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^/:]+)(?::\d+)?[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(String(remoteUrl).toLowerCase())
  return !!m && m[1] === host && m[2] === owner && m[3] === repo
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

// Reads `.luna-gate.json` at a ref. Returns true only for an explicit `"enabled": false`.
export function optedOut(cwd, ref) {
  const raw = tryGit(cwd, ['show', `${ref}:.luna-gate.json`])
  if (raw === null) return false
  try { return JSON.parse(raw)?.enabled === false } catch { return false }
}

// `reject`: gh would open the PR from refs this machine cannot see, so reviewing local
// refs would review a substitute. Not an error to fail open on; block mode denies it.
export function collectChange(cwd, { base = null, head = null, repo = null, maxBytes }) {
  const root = repoRoot(cwd)
  if (!root) return { error: 'not inside a git repository' }
  if (head && head.includes(':')) {
    return { reject: `\`--head ${head}\` names a branch in another user's repository, which luna-gate cannot review locally` }
  }
  if (repo && !sameRepo(repo, originUrl(root))) {
    return { reject: `\`--repo ${repo}\` is not this checkout's origin, so luna-gate cannot resolve the PR's base and head locally` }
  }
  if (!base) base = ghMergeBase(root)
  const baseRef = resolveBase(root, base)
  if (!baseRef) return { error: `could not resolve a base branch${base ? ` for "${base}"` : ''}` }
  const headRef = resolveHead(root, head)
  if (!headRef) return { error: `could not resolve the head branch "${head}"` }
  const headSha = tryGit(root, ['rev-parse', headRef])
  const mergeBase = tryGit(root, ['merge-base', baseRef, headRef])
  if (!mergeBase) return { error: `${baseRef} and ${headRef} share no history` }

  const range = [mergeBase, headSha]
  const allFiles = parseNameStatus(git(root, ['diff', '--name-status', '-z', '-M', ...range]))
  // A rename or copy with a credential-shaped path at EITHER end is withheld whole. The
  // excludes alone would drop only the sensitive side, and the other side would still
  // carry the bytes: `config.txt -> .env` as a full deletion hunk, `.env -> notes.txt`
  // as a full addition.
  const sensitive = new Set(git(root, ['diff', '--name-only', '-z', '--no-renames', ...range, ...SENSITIVE_ONLY]).split('\0').filter(Boolean))
  const pairExcludes = allFiles.filter((f) => f.from && (sensitive.has(f.from) || sensitive.has(f.path)))
    .flatMap((f) => [f.from, f.path]).map((p) => `:(exclude,literal)${p}`)
  const pathspec = [...PATHSPEC, ...pairExcludes]
  const files = parseNameStatus(git(root, ['diff', '--name-status', '-z', '-M', ...range, ...pathspec]))
  const kept = new Set(files.flatMap((f) => [f.from, f.path]).filter(Boolean))
  const omitted = [...new Set(allFiles.flatMap((f) => [f.from, f.path]).filter((p) => p && !kept.has(p)))]

  let diff = git(root, ['diff', '--no-color', '--no-ext-diff', '-M', '--function-context', ...range, ...pathspec])
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

  const bundleHash = sha256(JSON.stringify({ diff, contents, omitted }))
  return {
    root, baseRef, headRef, headSha, mergeBase,
    files, omitted, diff, truncated, contents, skippedContents, bundleHash,
    ackKey: sha256(`${mergeBase}..${headSha}`),
    remote: originUrl(root),
    empty: files.length === 0,
  }
}
