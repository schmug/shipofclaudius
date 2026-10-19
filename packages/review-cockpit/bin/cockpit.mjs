#!/usr/bin/env node
// CLI for the PR review cockpit. Node built-ins only.
//
// Usage (run from anywhere inside the repo being reviewed):
//   node cockpit.mjs build   [range/PR flags] [capture flags]     # collect + render, no model summary
//   node cockpit.mjs collect [range/PR flags] [capture flags]     # writes the bundle, prints the digest
//   node cockpit.mjs render  --bundle <file> [--summary-hex <hex>] [--verdict <file>]
//
// Range/PR flags:  --base <ref> (default: merge-base with main)  --head <ref> (default HEAD)
//                  --pr <number> [--repo owner/name]             (PR mode, via `gh api` REST)
// Capture flags:   --before-url <url> --after-url <url> --routes /,/pricing
//                  --transcripts <dir>   (default: ~/.claude/projects/<repo slug>*)
//                  --no-capture --no-transcripts
// Render flags:    --verdict <file> | --verdict-hex <hex>   --graph-lib <file> | --no-graph-lib   --out <file>
//
// Output goes to <repo>/.review/ (made git-ignored if it is not already). The last stdout
// line is always COCKPIT_BUNDLE=<path> (collect) or COCKPIT_HTML=<path> (render/build), and
// a failure prints COCKPIT_ERROR=<message> and exits 1.

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import { collect, digest, git } from '../src/collect.mjs'
import { renderHtml, sanitizeSummary } from '../src/render.mjs'

// Pinned graph library. The hash is the npm tarball's dist/cytoscape.min.js; a download
// that does not match it is discarded and the cockpit falls back to its built-in SVG graph.
const GRAPH_LIB = {
  url: 'https://cdnjs.cloudflare.com/ajax/libs/cytoscape/3.30.2/cytoscape.min.js',
  sha256: '83e8c54a6bec655bfd81df07df605649c268af69aeca67a5ea2da54ea42dac81',
  cacheName: 'cytoscape-3.30.2.min.js',
}

function parseArgv(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) { out._.push(a); continue }
    const key = a.slice(2)
    if (key.startsWith('no-')) { out[key] = true; continue }
    out[key] = argv[i + 1]
    i++
  }
  return out
}

const sha256 = (s) => createHash('sha256').update(s).digest('hex')

async function graphLib(args) {
  if (args['no-graph-lib']) return ''
  const check = (txt) => (txt && sha256(txt) === GRAPH_LIB.sha256 ? txt : '')
  if (args['graph-lib']) return check(readFileSync(args['graph-lib'], 'utf8'))
  const dir = join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'review-cockpit')
  const cached = join(dir, GRAPH_LIB.cacheName)
  if (existsSync(cached)) { const t = check(readFileSync(cached, 'utf8')); if (t) return t }
  try {
    const res = await fetch(GRAPH_LIB.url, { signal: AbortSignal.timeout(8000) })
    const t = check(res.ok ? await res.text() : '')
    if (t) { mkdirSync(dir, { recursive: true }); writeFileSync(cached, t) }
    return t
  } catch { return '' }
}

function outDir(root) {
  const dir = join(root, '.review')
  mkdirSync(dir, { recursive: true })
  let ignored = false
  try { git(root, ['check-ignore', '-q', '.review/probe'], { quiet: true }); ignored = true } catch {}
  if (!ignored) writeFileSync(join(dir, '.gitignore'), '# written by review-cockpit: keep cockpit output out of git\n*\n')
  return dir
}

function hexToUtf8(hex) {
  if (!/^(?:[0-9a-f]{2})*$/i.test(hex)) throw new Error('--summary-hex is not hex')
  return Buffer.from(hex, 'hex').toString('utf8')
}

// An external reviewer's verdict (codex critic JSON, a reviewer agent's output). Shown as
// data on the Approve tab; a file that does not parse is shown as an error, not dropped.
function readVerdict(args) {
  try {
    if (args['verdict-hex']) return JSON.parse(hexToUtf8(args['verdict-hex']))
    if (args.verdict) return JSON.parse(readFileSync(args.verdict, 'utf8'))
  } catch (e) {
    return { error: `could not read the verdict: ${e.message}` }
  }
  return null
}

async function main() {
  const args = parseArgv(process.argv.slice(2))
  const cmd = args._[0]
  const cwd = process.cwd()
  const routes = typeof args.routes === 'string' ? args.routes.split(',').map((r) => r.trim()).filter(Boolean) : []
  const collectOpts = () => ({
    cwd,
    base: args.base,
    head: args.head,
    pr: args.pr ? Number(args.pr) : undefined,
    repo: args.repo,
    beforeUrl: args['before-url'],
    afterUrl: args['after-url'],
    routes,
    transcripts: args.transcripts,
    noCapture: !!args['no-capture'],
    noTranscripts: !!args['no-transcripts'],
  })
  if (args.pr && !/^\d+$/.test(String(args.pr))) throw new Error('--pr must be a number')

  if (cmd === 'collect' || cmd === 'build') {
    const b = await collect(collectOpts())
    const dir = outDir(b.repo.root)
    const short = b.range.head.slice(0, 7)
    const bundlePath = join(dir, `cockpit-${short}.bundle.json`)
    writeFileSync(bundlePath, JSON.stringify(b))
    if (cmd === 'collect') {
      process.stdout.write(`${digest(b)}\n`)
      process.stdout.write(`COCKPIT_BUNDLE=${bundlePath}\n`)
      return
    }
    const html = renderHtml(b, { graphLib: await graphLib(args), verdict: readVerdict(args) })
    const out = args.out || join(dir, `cockpit-${short}.html`)
    writeFileSync(out, html)
    report(b, out)
    return
  }
  if (cmd === 'render') {
    if (!args.bundle) throw new Error('render needs --bundle')
    const b = JSON.parse(readFileSync(args.bundle, 'utf8'))
    let summary = null
    if (args['summary-hex']) { try { summary = sanitizeSummary(JSON.parse(hexToUtf8(args['summary-hex']))) } catch { summary = null } }
    const html = renderHtml(b, { summary, verdict: readVerdict(args), graphLib: await graphLib(args) })
    const out = args.out || args.bundle.replace(/\.bundle\.json$/, '.html')
    writeFileSync(out, html)
    report(b, out)
    return
  }
  throw new Error('usage: cockpit.mjs build|collect|render [flags] (see the header of this file)')
}

function report(b, out) {
  const red = b.redactions.reduce((n, r) => n + r.count, 0)
  process.stdout.write([
    `files ${b.stats.files} (+${b.stats.additions} -${b.stats.deletions}) · risk areas: ${b.risks.map((r) => r.key).join(', ') || 'none'}`,
    `redacted ${red} value(s)${red ? `: ${b.redactions.map((r) => `${r.source}/${r.kind}×${r.count}`).join(', ')}` : ''}`,
    `possible prompt-injection lines: ${b.injection.length}`,
    `sessions found: ${b.why.sessions.length}${b.why.note ? ` (${b.why.note})` : ''}`,
    `visual: ${b.visual.skipped || `${b.visual.shots.length} capture(s)`}`,
    `COCKPIT_HTML=${out}`,
  ].join('\n') + '\n')
}

main().catch((e) => {
  process.stdout.write(`COCKPIT_ERROR=${String(e && e.message || e).split('\n')[0]}\n`)
  process.exit(1)
})
