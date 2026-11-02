#!/usr/bin/env node
// One autopilot tick. Usage: tick.mjs [--dry-run] [--json] [--config <path>] [--state-dir <path>]
//        tick.mjs --record <findingId> [<outcome-json>; stdin when omitted] [--state-dir <path>]   store a scrutineer-fix-pr outcome as the ledger stage (exit 2 on invalid input)
//        tick.mjs --digest-sent [--state-dir <path>]                       stamp lastDigestAt in the ledger
// Prints the TickResult. Exit 0 for ok/paused/locked, 2 for scrutineer-too-old/-down/budget-unavailable, 1 on error.
// --dry-run also wraps fetch so any non-GET request throws before it leaves the process.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile } from 'node:fs/promises'
import { loadConfig, DEFAULT_CONFIG_PATH, DEFAULTS } from '../src/config.mjs'
import { createClient } from '../src/client.mjs'
import { runTick, dryRunFetch, recordOutcome, markDigestSent, RecordError, EXIT } from '../src/tick.mjs'

const pexec = promisify(execFile)
const exec = async (cmd, args) => (await pexec(cmd, args, { maxBuffer: 64 << 20 })).stdout

function parseArgs(argv) {
  const o = { dryRun: false, json: false, config: DEFAULT_CONFIG_PATH, stateDir: null, record: null, digestSent: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dry-run') o.dryRun = true
    else if (a === '--json') o.json = true
    else if (a === '--config') o.config = argv[++i]
    else if (a === '--state-dir') o.stateDir = argv[++i]
    else if (a === '--record') {
      const id = argv[++i]
      if (id == null) throw new RecordError('--record needs <findingId> [<outcome-json>]')
      o.record = [id, argv[i + 1] != null && !argv[i + 1].startsWith('--') ? argv[++i] : null] // no JSON argument: read stdin
    }
    else if (a === '--digest-sent') o.digestSent = true
    else throw new Error(`unknown argument ${a}`)
  }
  return o
}

function summary(r) {
  const count = (xs, f) => xs.reduce((m, x) => { const k = f(x); m[k] = (m[k] ?? 0) + 1; return m }, {})
  const lines = [`status: ${r.status}${r.dryRun ? ' (dry run)' : ''}`]
  lines.push(`actions: ${JSON.stringify(count(r.actions, (a) => `${a.type}:${a.result}`))}`)
  lines.push(`agent items: ${r.agentItems.map((i) => `${i.kind} ${i.repo}#${i.findingId}`).join(', ') || 'none'}`)
  for (const n of r.notes) lines.push(`note: ${n}`)
  return lines.join('\n')
}

// Record modes read only stateDir (no owner lookup, no network); a config file may name it.
async function readStdin() {
  const chunks = []
  for await (const c of process.stdin) chunks.push(c)
  return Buffer.concat(chunks).toString('utf8')
}

async function stateDirFor(o) {
  if (o.stateDir) return o.stateDir
  try { return JSON.parse(await readFile(o.config, 'utf8')).stateDir ?? DEFAULTS.stateDir } catch (e) { if (e.code === 'ENOENT') return DEFAULTS.stateDir; throw e }
}

try {
  const o = parseArgs(process.argv.slice(2))
  if (o.record || o.digestSent) {
    const dir = await stateDirFor(o)
    if (o.record) {
      const json = o.record[1] ?? await readStdin()
      const e = await recordOutcome(dir, o.record[0], json); console.log(`recorded ${o.record[0]}: ${e.stage}`) }
    else console.log(`lastDigestAt ${await markDigestSent(dir)}`)
    process.exit(0)
  }
  const config = await loadConfig(o.config, { exec })
  if (o.stateDir) config.stateDir = o.stateDir
  const fetch = o.dryRun ? dryRunFetch(globalThis.fetch) : globalThis.fetch
  const client = createClient({ baseUrl: config.baseUrl, tokenPath: config.tokenPath, fetch })
  const r = await runTick({ config, client, exec, now: Date.now(), dryRun: o.dryRun })
  console.log(o.json ? JSON.stringify(r, null, 2) : summary(r))
  process.exit(EXIT[r.status] ?? 1)
} catch (e) {
  console.error(`tick: ${String(e?.message ?? e).split('\n')[0]}`)
  process.exit(e instanceof RecordError ? 2 : 1)
}
