// Context the agent never has to supply. Git is best-effort and time-bounded:
// a slow or absent git must degrade to null, never hang the tool call.
//
// Nothing here is agent-influenceable. `cwd` comes from CLAUDE_PROJECT_DIR, set by
// the host when it spawns this server — before any agent runs — and the git argv is
// two fixed literal arrays. execFileSync runs git directly with no shell, so even a
// hostile cwd is an argument, never a command. See THREAT_MODEL.md.
import { execFileSync } from 'node:child_process'

function realGit(cwd, args) {
  try {
    const out = execFileSync('git', args, {
      cwd, encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'],
    })
    return out.trim() || null
  } catch {
    return null
  }
}

// The canonical §4.4 context shape, and the single place it is written down. Every
// return below is built FROM it, so "every context field is string-or-null, never
// undefined" is structural rather than four literals that have to agree. server.mjs
// imports it as the fallback for a deps.context() that throws — a frozen literal, so
// the pure dispatcher gains a shape, not a side effect.
export const NULL_CONTEXT = Object.freeze({ cwd: null, repo: null, branch: null, session: null })

export function parseRepo(url) {
  if (!url) return null
  // Normalized, because this is a GROUPING KEY: the weekly triage buckets records by it.
  // git stores the clone URL exactly as typed (so a trailing slash is legal) and GitHub
  // URLs are case-insensitive, so `schmug/x`, `schmug/x/` and `Schmug/X.git` are one
  // repo and must not become three.
  const m = String(url).replace(/\/+$/, '').match(/[:/]([^/:]+)\/([^/]+?)(?:\.git)?$/)
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null
}

export function captureContext(env = process.env, gitFn = realGit) {
  const cwd = env.CLAUDE_PROJECT_DIR || null
  const session = env.CLAUDE_CODE_SESSION_ID || null
  if (!cwd) return { ...NULL_CONTEXT, session }
  let repo = null
  let branch = null
  try {
    repo = parseRepo(gitFn(cwd, ['config', '--get', 'remote.origin.url']))
    branch = gitFn(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']) || null
  } catch {
    repo = null
    branch = null
  }
  return { ...NULL_CONTEXT, cwd, repo, branch, session }
}
