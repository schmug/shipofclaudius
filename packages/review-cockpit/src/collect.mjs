// Collect everything the cockpit shows into one redacted bundle.
//
// The bundle is the ONLY thing the renderer and the summarizing model see. Redaction runs
// here, once, before anything is written to disk, so no later stage can embed a raw secret
// by accident. The bundle carries a redaction report saying what was removed.

import { execFileSync } from 'node:child_process'
import { parseUnifiedDiff } from './diff.mjs'
import { redact, redactDeep, reportToList } from './redact.mjs'
import { riskCategories, injectionFlags } from './risk.mjs'
import { blastRadius } from './graph.mjs'
import { provenance } from './transcripts.mjs'
import { captureVisuals } from './capture.mjs'

const REF = /^(?!-)[A-Za-z0-9._/@^~-]+$/

export function git(cwd, args, opt = {}) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', opt.quiet ? 'ignore' : 'pipe'], maxBuffer: 256 << 20 })
}
const tryGit = (cwd, args) => { try { return git(cwd, args, { quiet: true }).trim() } catch { return '' } }

/** owner/name from the origin remote (no GraphQL: `gh repo view` is blocked in some envs). */
export function originSlug(cwd) {
  const url = tryGit(cwd, ['remote', 'get-url', 'origin'])
  const m = url.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/) || url.match(/\/git\/([^/]+\/[^/]+?)(?:\.git)?\/?$/)
  return m ? m[1] : ''
}

function defaultBase(cwd, head) {
  for (const cand of ['origin/main', 'main', 'origin/master', 'master']) {
    const mb = tryGit(cwd, ['merge-base', head, cand])
    if (mb) return { base: mb, baseLabel: `merge-base with ${cand}` }
  }
  throw new Error('could not find a merge-base with main/master; pass --base')
}

function fromPr(cwd, pr, repo) {
  const slug = repo || originSlug(cwd)
  if (!slug) throw new Error('could not determine owner/repo from the origin remote; pass --repo')
  const gh = (args) => execFileSync('gh', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 << 20 })
  const meta = JSON.parse(gh(['api', `repos/${slug}/pulls/${pr}`]))
  const diff = gh(['api', '-H', 'Accept: application/vnd.github.diff', `repos/${slug}/pulls/${pr}`])
  return {
    diff,
    base: meta.base.sha,
    head: meta.head.sha,
    baseLabel: `${meta.base.ref} (PR #${pr} base)`,
    headLabel: `${meta.head.ref} (PR #${pr})`,
    branch: meta.head.ref,
    pr: { number: pr, title: meta.title || '', url: meta.html_url || '', author: (meta.user && meta.user.login) || '' },
    // Head is only on disk if the PR branch was fetched; the graph then reads the local tree.
    headLocal: !!tryGit(cwd, ['cat-file', '-e', `${meta.head.sha}^{commit}`]) || tryGit(cwd, ['rev-parse', 'HEAD']) === meta.head.sha,
  }
}

/**
 * @param {{ cwd: string, base?: string, head?: string, pr?: number, repo?: string,
 *   beforeUrl?: string, afterUrl?: string, routes?: string[], transcripts?: string,
 *   noCapture?: boolean, noTranscripts?: boolean }} o
 */
export async function collect(o) {
  const root = git(o.cwd, ['rev-parse', '--show-toplevel']).trim()
  let src
  if (o.pr) {
    src = fromPr(root, o.pr, o.repo)
  } else {
    const head = o.head || 'HEAD'
    if (!REF.test(head) || (o.base && !REF.test(o.base))) throw new Error('base/head must be plain git refs')
    const headSha = git(root, ['rev-parse', '--verify', `${head}^{commit}`]).trim()
    const b = o.base ? { base: git(root, ['rev-parse', '--verify', `${o.base}^{commit}`]).trim(), baseLabel: o.base } : defaultBase(root, headSha)
    src = {
      diff: git(root, ['diff', '--no-color', '--no-ext-diff', '-M', b.base, headSha]),
      base: b.base,
      head: headSha,
      baseLabel: b.baseLabel,
      headLabel: head,
      branch: tryGit(root, ['rev-parse', '--abbrev-ref', head]) || head,
      pr: null,
      headLocal: true,
    }
  }

  const report = new Map()
  const rawDiff = redact(src.diff, 'diff', report)
  const files = parseUnifiedDiff(rawDiff)
  const changed = files.map((f) => f.path)
  const commits = tryGit(root, ['log', '--format=%h %s', `${src.base}..${src.head}`]).split('\n').filter(Boolean).slice(0, 100)
  const baseTime = Number(tryGit(root, ['show', '-s', '--format=%ct', src.base])) * 1000 || 0

  const graph = src.headLocal ? blastRadius(root, changed) : { heuristic: true, skipped: 'PR head is not checked out locally; fetch it to build the graph.', nodes: changed.map((id) => ({ id, hop: 0, changed: true, test: false })), edges: [], tests: [] }
  const why = o.noTranscripts
    ? { searched: '', sessions: [], note: 'Transcript scan disabled (--no-transcripts).' }
    : redactDeep(provenance({ repoRoot: root, files, branch: src.branch, sinceMs: baseTime ? baseTime - 86400000 : 0, dir: o.transcripts }), 'transcript', report)
  const visual = o.noCapture ? { skipped: 'Capture disabled (--no-capture).', shots: [] } : await captureVisuals({ beforeUrl: o.beforeUrl, afterUrl: o.afterUrl, routes: o.routes, cwd: root })

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    repo: { root, slug: originSlug(root) },
    range: { base: src.base, head: src.head, baseLabel: src.baseLabel, headLabel: src.headLabel, branch: src.branch, pr: src.pr },
    commits: commits.map((c) => redact(c, 'commits', report)),
    stats: { files: files.length, additions: files.reduce((n, f) => n + f.additions, 0), deletions: files.reduce((n, f) => n + f.deletions, 0) },
    rawDiff,
    files,
    risks: riskCategories(files),
    injection: injectionFlags(files),
    graph,
    why,
    tryIt: { beforeUrl: o.beforeUrl || '', afterUrl: o.afterUrl || '', routes: o.routes && o.routes.length ? o.routes : ['/'] },
    visual,
    redactions: reportToList(report),
  }
}

/**
 * The text the summarizing model sees: bounded, redacted, and structured so that the
 * caller can fence it as untrusted data. Never includes screenshots.
 */
export function digest(b, maxDiff = 60000) {
  const lines = []
  lines.push(`RANGE ${b.range.baseLabel} (${b.range.base.slice(0, 12)}) .. ${b.range.headLabel} (${b.range.head.slice(0, 12)})`)
  if (b.range.pr) lines.push(`PR #${b.range.pr.number}: ${b.range.pr.title}`)
  lines.push(`STATS ${b.stats.files} files, +${b.stats.additions} -${b.stats.deletions}`)
  lines.push('COMMITS', ...b.commits.map((c) => `  ${c}`))
  lines.push('FILES', ...b.files.map((f) => `  ${f.status} ${f.path} (+${f.additions} -${f.deletions})`))
  lines.push('RISK CATEGORIES TOUCHED', ...(b.risks.length ? b.risks.map((r) => `  ${r.key}: ${r.hits.length} hit(s)`) : ['  none']))
  lines.push(`POSSIBLE PROMPT-INJECTION LINES: ${b.injection.length}`, ...b.injection.slice(0, 10).map((i) => `  ${i.file}:${i.line}`))
  const s = b.why.sessions[0]
  if (s) {
    lines.push(`SESSION ${s.sessionId} "${s.title}"`)
    lines.push('USER PROMPTS (first 3, clipped)', ...s.prompts.slice(0, 3).map((p) => `  > ${p.text.slice(0, 800).replace(/\n/g, '\n    ')}`))
    lines.push('CHECKS RUN', ...s.commands.slice(-10).map((c) => `  [${c.status}] ${c.command.slice(0, 160)}`))
  } else lines.push('SESSION none found')
  lines.push('DIFF')
  lines.push(b.rawDiff.length > maxDiff ? `${b.rawDiff.slice(0, maxDiff)}\n[diff truncated: ${b.rawDiff.length - maxDiff} more chars]` : b.rawDiff)
  return lines.join('\n')
}
