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

export function parseRepo(url) {
  if (!url) return null
  const m = String(url).match(/[:/]([^/:]+)\/([^/]+?)(?:\.git)?$/)
  return m ? `${m[1]}/${m[2]}` : null
}

export function captureContext(env = process.env, gitFn = realGit) {
  const cwd = env.CLAUDE_PROJECT_DIR || null
  const session = env.CLAUDE_CODE_SESSION_ID || null
  if (!cwd) return { cwd: null, repo: null, branch: null, session }
  let repo = null
  let branch = null
  try {
    repo = parseRepo(gitFn(cwd, ['config', '--get', 'remote.origin.url']))
    branch = gitFn(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']) || null
  } catch {
    repo = null
    branch = null
  }
  return { cwd, repo, branch, session }
}
