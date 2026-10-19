// Provenance ("Why"): find the Claude Code session transcripts that produced a change and
// pull out what a reviewer needs from them.
//
// Claude Code stores one JSONL per session under <config>/projects/<slug>/, where <slug> is
// the session's cwd with every non-alphanumeric character replaced by "-". Worktree sessions
// get a longer slug with the same prefix, so every directory starting with the repo's slug
// is scanned. A session is RELEVANT when it edited at least one file the diff changes; a
// session that only matched the branch name is kept too, ranked lower.
//
// Everything extracted here is untrusted text (prompts, tool input, tool output) and is
// redacted by the caller before it is embedded or shown to a model.

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join, isAbsolute, relative } from 'node:path'
import { homedir } from 'node:os'
import { hunkId } from './diff.mjs'

export const projectSlug = (dir) => String(dir).replace(/[^A-Za-z0-9]/g, '-')

export function projectsRoot(env = process.env) {
  return join(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects')
}

const CHECK_CMD = /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(test|build|check|lint|typecheck|ci)\b|\bnode\s+(--test\b|tests?\/)|\b(pytest|vitest|jest|mocha|tsc|eslint|biome|ruff|mypy|pyright|go\s+(test|build|vet)|cargo\s+(test|build|clippy)|make(\s+\w+)?|playwright\s+test|wrangler\s+deploy|claude\s+plugin\s+(validate|test))\b/
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])
const READ_TOOLS = new Set(['Read', 'NotebookRead'])
const PLAN_TOOLS = /^(ExitPlanMode|TodoWrite|TaskCreate|TaskUpdate|mcp__hearthbot__update_status)$/

const clip = (s, n) => {
  const t = String(s == null ? '' : s)
  return t.length > n ? `${t.slice(0, n)}… [${t.length - n} more chars]` : t
}
const textOf = (content) => {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((c) => (typeof c === 'string' ? c : c && c.type === 'text' ? c.text : '')).filter(Boolean).join('\n')
  return ''
}
const stripHarness = (s) => s.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()

/** Map an absolute (or cwd-relative) tool path onto a repo-relative one; null if outside. */
export function toRepoPath(p, repoRoot, cwd) {
  if (!p || typeof p !== 'string') return null
  const abs = isAbsolute(p) ? p : join(cwd || repoRoot, p)
  // A worktree checkout of the same repo: <root>/.claude/worktrees/<name>/<path>.
  const wt = abs.match(/\/\.claude\/worktrees\/[^/]+\/(.+)$/)
  if (wt) return wt[1]
  const rel = relative(repoRoot, abs)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null
  return rel
}

/** List candidate transcript files, newest first. */
export function findTranscripts({ repoRoot, dir, sinceMs = 0 }) {
  const files = []
  const scan = (d) => {
    for (const f of readdirSync(d)) {
      if (!f.endsWith('.jsonl')) continue
      const full = join(d, f)
      const st = statSync(full)
      if (st.mtimeMs >= sinceMs) files.push({ path: full, mtimeMs: st.mtimeMs })
    }
  }
  if (dir) {
    if (existsSync(dir)) scan(dir)
  } else {
    const root = projectsRoot()
    if (!existsSync(root)) return []
    const slug = projectSlug(repoRoot)
    for (const d of readdirSync(root)) if (d === slug || d.startsWith(`${slug}-`)) scan(join(root, d))
  }
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs)
}

/**
 * Parse one transcript into the provenance record.
 * @param {string} jsonl  file contents
 * @param {{ repoRoot: string, changed: Set<string> }} ctx
 */
export function parseTranscript(jsonl, { repoRoot, changed }) {
  const s = { sessionId: '', title: '', branches: new Set(), start: '', end: '', prompts: [], plan: [], edits: [], reads: new Set(), commands: [] }
  const pending = new Map() // tool_use_id -> command record awaiting its result
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue
    let o
    try { o = JSON.parse(line) } catch { continue }
    if (o.type === 'ai-title' && o.aiTitle) s.title = o.aiTitle
    if (o.sessionId && !s.sessionId) s.sessionId = o.sessionId
    if (o.gitBranch) s.branches.add(o.gitBranch)
    if (o.timestamp) { if (!s.start) s.start = o.timestamp; s.end = o.timestamp }
    if (o.isSidechain) continue
    const msg = o.message
    if (!msg) continue
    if (o.type === 'user') {
      if (Array.isArray(msg.content)) {
        for (const c of msg.content) {
          if (c && c.type === 'tool_result' && pending.has(c.tool_use_id)) {
            const rec = pending.get(c.tool_use_id)
            const out = textOf(c.content)
            rec.status = c.is_error === true || /^Exit code [1-9]/.test(out) ? 'fail' : 'pass'
            rec.output = clip(out.split('\n').slice(-12).join('\n'), 1200)
            pending.delete(c.tool_use_id)
          }
        }
      }
      if (o.isMeta) continue
      const txt = stripHarness(textOf(Array.isArray(msg.content) ? msg.content.filter((c) => c && c.type !== 'tool_result') : msg.content))
      if (txt && !/^<(command|local-command)-/.test(txt)) s.prompts.push({ ts: o.timestamp || '', text: clip(txt, 2000) })
      continue
    }
    if (o.type !== 'assistant' || !Array.isArray(msg.content)) continue
    for (const c of msg.content) {
      if (!c || c.type !== 'tool_use') continue
      const inp = c.input || {}
      if (EDIT_TOOLS.has(c.name)) {
        const file = toRepoPath(inp.file_path || inp.notebook_path, repoRoot, o.cwd)
        if (!file) continue
        const snippets = c.name === 'MultiEdit' && Array.isArray(inp.edits)
          ? inp.edits.map((e) => e.new_string || '')
          : [c.name === 'Write' ? (inp.content || '') : (inp.new_string || inp.new_source || '')]
        s.edits.push({ ts: o.timestamp || '', tool: c.name, file, inDiff: changed.has(file), snippet: clip(snippets.join('\n…\n'), 600), _new: snippets })
      } else if (READ_TOOLS.has(c.name)) {
        const file = toRepoPath(inp.file_path || inp.notebook_path, repoRoot, o.cwd)
        if (file) s.reads.add(file)
      } else if (c.name === 'Bash' && typeof inp.command === 'string') {
        if (CHECK_CMD.test(inp.command)) {
          const rec = { ts: o.timestamp || '', command: clip(inp.command, 500), status: 'unknown', output: '' }
          s.commands.push(rec)
          pending.set(c.id, rec)
        }
      } else if (PLAN_TOOLS.test(c.name)) {
        const body = inp.plan || inp.text || (Array.isArray(inp.todos) ? inp.todos.map((t) => `${t.status === 'completed' ? '✓' : '○'} ${t.content}`).join('\n') : '') || inp.subject || inp.description || ''
        if (body) s.plan.push({ ts: o.timestamp || '', tool: c.name, text: clip(body, 2000) })
      }
    }
  }
  return s
}

/** Attach each edit to the diff hunk(s) its new text landed in. */
export function mapEditsToHunks(edits, files) {
  const byPath = new Map(files.map((f, i) => [f.path, { f, i }]))
  for (const e of edits) {
    e.hunks = []
    const hit = byPath.get(e.file)
    if (!hit) continue
    const want = new Set(e._new.flatMap((t) => t.split('\n')).map((l) => l.trim()).filter((l) => l.length > 3))
    hit.f.hunks.forEach((h, hi) => {
      if (h.lines.some((l) => l.t === '+' && want.has(l.s.trim()))) e.hunks.push(hunkId(hit.i, hi))
    })
    if (!e.hunks.length && e.tool === 'Write' && hit.f.hunks.length) e.hunks.push(hunkId(hit.i, 0))
  }
  for (const e of edits) delete e._new
  return edits
}

/**
 * Locate, parse and rank the sessions behind a change.
 * @returns {{ searched: string, sessions: object[], note: string }}
 */
export function provenance({ repoRoot, files, branch, sinceMs = 0, dir, maxSessions = 5 }) {
  const changed = new Set(files.map((f) => f.path))
  const searched = dir || join(projectsRoot(), `${projectSlug(repoRoot)}*`)
  let candidates
  try { candidates = findTranscripts({ repoRoot, dir, sinceMs }) } catch (e) { return { searched, sessions: [], note: `could not read transcripts: ${e.message}` } }
  const sessions = []
  for (const c of candidates.slice(0, 200)) {
    let raw
    try { raw = readFileSync(c.path, 'utf8') } catch { continue }
    const s = parseTranscript(raw, { repoRoot, changed })
    const touched = s.edits.filter((e) => e.inDiff).length
    const onBranch = branch && s.branches.has(branch)
    if (!touched && !onBranch) continue
    mapEditsToHunks(s.edits, files)
    const reads = [...s.reads]
    sessions.push({
      file: c.path,
      sessionId: s.sessionId,
      title: s.title,
      branches: [...s.branches],
      start: s.start,
      end: s.end,
      score: touched * 10 + (onBranch ? 5 : 0),
      prompts: s.prompts.slice(0, 40),
      plan: s.plan.slice(-15),
      edits: s.edits.slice(0, 200),
      readNotChanged: reads.filter((r) => !changed.has(r)).sort().slice(0, 200),
      commands: s.commands.slice(-60),
    })
  }
  sessions.sort((a, b) => b.score - a.score)
  const note = candidates.length === 0
    ? 'No transcripts found for this repository on this machine.'
    : sessions.length === 0 ? `Scanned ${candidates.length} transcript(s); none edited a changed file or ran on this branch.` : ''
  return { searched, scanned: candidates.length, sessions: sessions.slice(0, maxSessions), note }
}
