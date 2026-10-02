#!/usr/bin/env node
// Run the luna-gate review by hand, or from a git pre-push hook so changes made by ANY
// agent or editor get the same review (the PreToolUse hook only sees Claude Code).
//
//   node review.mjs [--base <branch>] [--head <branch>] [--cwd <dir>] [--json] [--no-cache]
//   node review.mjs --ack      # the user acknowledges the current change's findings
//
// Running it is the opt-in, so LUNA_GATE does not need to be set. The rest of the
// configuration (model, effort, threshold, skip regex, budget) comes from the same env vars.
//
// Exit codes: 0 nothing at/above threshold (or skipped / acked / failed open)
//             1 blocking findings
//             2 the review failed and LUNA_GATE_ON_ERROR=closed
//            64 bad usage
import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { loadConfig } from '../src/config.mjs'
import { prepare, review, writeAck } from '../src/run.mjs'
import { renderFindings, summaryLine } from '../src/decide.mjs'

const USAGE = 'usage: review.mjs [--base <branch>] [--head <branch>] [--cwd <dir>] [--json] [--no-cache] [--ack]'

export function parseArgs(argv) {
  const a = { base: null, head: null, cwd: process.cwd(), json: false, cache: true, ack: false, help: false }
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i]
    if (t === '--base' || t === '--head' || t === '--cwd') {
      if (!argv[i + 1]) throw new Error(`${t} needs a value`)
      a[t.slice(2)] = argv[++i]
    } else if (t === '--json') a.json = true
    else if (t === '--no-cache') a.cache = false
    else if (t === '--ack') a.ack = true
    else if (t === '-h' || t === '--help') a.help = true
    else throw new Error(`unknown argument: ${t}`)
  }
  return a
}

export async function cli(argv, { env = process.env, fetchImpl, out = console.log, err = console.error } = {}) {
  let a
  try { a = parseArgs(argv) } catch (e) { err(`${e.message}\n${USAGE}`); return 64 }
  if (a.help) { out(USAGE); return 0 }
  const cfg = { ...loadConfig(env), mode: 'block' }

  if (a.ack) {
    const prep = await prepare({ cwd: a.cwd, base: a.base, head: a.head, cfg })
    if (prep.outcome) { err(`luna-gate: nothing to acknowledge (${prep.outcome.message || prep.outcome.note || 'change is not reviewed'})`); return 0 }
    await writeAck(cfg, prep.change)
    out(`luna-gate: acknowledged ${prep.change.mergeBase.slice(0, 12)}..${prep.change.headSha.slice(0, 12)}; the gate will let this exact change through.`)
    return 0
  }

  const o = await review({ cwd: a.cwd, base: a.base, head: a.head, cfg, fetchImpl, useCache: a.cache })
  if (a.json) {
    const { change, ...rest } = o
    out(JSON.stringify({ ...rest, range: change ? `${change.mergeBase}..${change.headSha}` : null }, null, 2))
  }
  if (o.kind === 'skip') { if (!a.json) out(`luna-gate: skipped${o.note ? ` — ${o.note}` : ''}`); return 0 }
  if (o.kind === 'acked') { if (!a.json) out('luna-gate: change acknowledged by the user; not re-reviewed.'); return 0 }
  if (o.kind === 'reject') { err(`luna-gate: not reviewed: ${o.message}`); return 1 }
  if (o.kind === 'error') {
    err(`luna-gate: review failed: ${o.message}`)
    return cfg.onError === 'closed' ? 2 : 0
  }
  if (!a.json) {
    out(summaryLine(cfg, o))
    if (o.review.summary || o.review.findings.length) out(renderFindings(o.review.findings, o.nonce, o.review.summary))
  }
  return o.blocking.length ? 1 : 0
}

// Compared via realpath: Node resolves the entry module's symlinks for import.meta.url but
// not for argv[1], so a symlinked install path would otherwise make the hook a silent no-op.
const isEntry = () => { try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href } catch { return false } }
if (isEntry()) {
  // exitCode, not exit(): stdout to a pipe is asynchronous on macOS, and exit() would
  // drop whatever had not drained yet (a long --json report, say).
  cli(process.argv.slice(2)).then((code) => { process.exitCode = code }, (e) => {
    console.error(`luna-gate: ${e?.message || e}`)
    process.exitCode = loadConfig().onError === 'closed' ? 2 : 0
  })
}
