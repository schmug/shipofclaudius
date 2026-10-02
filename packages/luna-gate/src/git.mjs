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
  '**/.env', '**/.env.*', '**/.dev.vars', '**/.dev.vars.*', '**/.npmrc', '**/.pypirc', '**/.netrc',
  '**/*.pem', '**/*.key', '**/*.p12', '**/*.pfx', '**/*.jks', '**/*.keystore',
  '**/id_rsa*', '**/id_ecdsa*', '**/id_ed25519*', '**/credentials.json', '**/*.tfstate', '**/*.tfstate.*',
])
export const NOISE_GLOBS = Object.freeze([
  '**/package-lock.json', '**/pnpm-lock.yaml', '**/yarn.lock', '**/bun.lockb', '**/bun.lock',
  '**/Cargo.lock', '**/poetry.lock', '**/uv.lock', '**/Gemfile.lock', '**/composer.lock', '**/go.sum',
  '**/*.min.js', '**/*.min.css', '**/*.map',
])
const excludes = (globs) => globs.map((g) => `:(exclude,glob)${g}`)
const PATHSPEC = ['--', '.', ...excludes(SENSITIVE_GLOBS), ...excludes(NOISE_GLOBS)]

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

export function resolveHead(cwd, name) {
  if (!name) return 'HEAD'
  // `--head owner:branch` (fork syntax) — only the branch part is meaningful locally.
  const branch = name.includes(':') ? name.slice(name.indexOf(':') + 1) : name
  for (const c of [branch, `origin/${branch}`]) if (isCommit(cwd, c)) return c
  return null
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

export function collectChange(cwd, { base = null, head = null, maxBytes }) {
  const root = repoRoot(cwd)
  if (!root) return { error: 'not inside a git repository' }
  const baseRef = resolveBase(root, base)
  if (!baseRef) return { error: `could not resolve a base branch${base ? ` for "${base}"` : ''}` }
  const headRef = resolveHead(root, head)
  if (!headRef) return { error: `could not resolve the head branch "${head}"` }
  const headSha = tryGit(root, ['rev-parse', headRef])
  const mergeBase = tryGit(root, ['merge-base', baseRef, headRef])
  if (!mergeBase) return { error: `${baseRef} and ${headRef} share no history` }

  const range = [mergeBase, headSha]
  const allFiles = parseNameStatus(git(root, ['diff', '--name-status', '-z', '-M', ...range]))
  const files = parseNameStatus(git(root, ['diff', '--name-status', '-z', '-M', ...range, ...PATHSPEC]))
  const kept = new Set(files.map((f) => f.path))
  const omitted = allFiles.filter((f) => !kept.has(f.path)).map((f) => f.path)

  let diff = git(root, ['diff', '--no-color', '--no-ext-diff', '-M', '--function-context', ...range, ...PATHSPEC])
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
