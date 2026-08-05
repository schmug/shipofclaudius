#!/usr/bin/env node
// CLI entry point for the factory merge gate. Called by the GitHub Action.
//
// Usage:
//   node packages/factory-gate/bin/gate.mjs \
//     --input   gate-input.json      # produced by `gh` calls in the Action
//     --config  gate.json            # the repo's .factory/gate.json, EXTRACTED FROM main
//     --config-source "main@<sha>"   # provenance, stamped into the verdict
//     [--verdict-out verdict.json] [--comment-out comment.md]
//
// Exit codes:
//   0  merge   — every condition passed
//   2  escalate— at least one condition failed (the normal "needs a human" path)
//   1  error   — the gate itself could not run (unreadable input, bad JSON)
//
// ⚠️ THE GATE-FROM-MAIN INVARIANT IS THE CALLER'S JOB. This script reads whatever files it is
// pointed at. The Action MUST extract both this package and the repo's gate config from the
// base branch (`git show main:.factory/gate.json`) before invoking it, so a PR cannot edit the
// rules it is judged by. `.factory/**` and `.github/workflows/**` are on the MANDATORY denylist
// as defence in depth, so even a mis-wired caller escalates such a PR rather than merging it.

import { readFile, writeFile } from 'node:fs/promises'
import { evaluate, renderVerdict } from '../src/gate-core.mjs'

function parseArgv(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const key = a.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) { out[key] = true }
    else { out[key] = next; i++ }
  }
  return out
}

const readJSON = async (p, what) => {
  let text
  try { text = await readFile(p, 'utf8') }
  catch (e) { throw new Error(`cannot read ${what} at ${p}: ${e.message}`) }
  try { return JSON.parse(text) }
  catch (e) { throw new Error(`${what} at ${p} is not valid JSON: ${e.message}`) }
}

async function main() {
  const a = parseArgv(process.argv.slice(2))
  if (!a.input) throw new Error('--input <gate-input.json> is required')

  const input = await readJSON(a.input, 'gate input')
  // An ABSENT config is not an error — normalizeConfig turns undefined into all-safe defaults,
  // which trust nobody. A repo that forgot to add .factory/gate.json gets "escalate", not a crash.
  const config = a.config ? await readJSON(a.config, 'gate config') : undefined

  const verdict = evaluate(input, config, { configSource: a['config-source'] || 'unknown' })
  const comment = renderVerdict(verdict)

  if (a['verdict-out']) await writeFile(a['verdict-out'], JSON.stringify(verdict, null, 2) + '\n')
  if (a['comment-out']) await writeFile(a['comment-out'], comment + '\n')

  process.stdout.write(comment + '\n')

  if (process.env.GITHUB_OUTPUT) {
    await writeFile(process.env.GITHUB_OUTPUT,
      `outcome=${verdict.outcome}\npass=${verdict.pass}\nfailed=${verdict.failed.join(',')}\n`, { flag: 'a' })
  }

  process.exit(verdict.pass ? 0 : 2)
}

main().catch((e) => {
  // Exit 1 is distinct from exit 2 on purpose: "the gate broke" must never be mistaken for
  // "the gate said no", and it must never be mistaken for "the gate said yes".
  console.error(`factory-gate: ${e.message}`)
  process.exit(1)
})
