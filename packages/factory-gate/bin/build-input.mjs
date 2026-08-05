#!/usr/bin/env node
// Fetch a PR's gate facts with `gh` and write `gate-input.json`. Called by the Action's land job.
//
// Usage:
//   node packages/factory-gate/bin/build-input.mjs \
//     --pr 900 --repo owner/name --base main \
//     [--evidence evidence.json] --out gate-input.json
//
// Exit codes: 0 wrote the input · 1 could not (the caller must then ESCALATE, never merge).
//
// This binary only FETCHES and SHAPES — it makes no decision. All shaping lives in
// ../src/build-input.mjs so it can be tested offline; everything here is I/O.

import { writeFile, readFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { buildGateInput, resolveLinkedIssue, requiredContextsPath } from '../src/build-input.mjs'

const run = promisify(execFile)

function parseArgv(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) out[a.slice(2)] = true
    else { out[a.slice(2)] = next; i++ }
  }
  return out
}

const gh = async (args) => {
  const { stdout } = await run('gh', args, { maxBuffer: 32 * 1024 * 1024 })
  return stdout
}
const ghJSON = async (args, what) => {
  try { return JSON.parse(await gh(args)) }
  catch (e) { throw new Error(`could not fetch ${what}: ${e.message}`) }
}

/**
 * The base branch's required-check contexts, via branch protection with a repository-rulesets
 * fallback. Returns [] when neither resolves — and [] makes `ci_green` FAIL, which is correct: a
 * repo whose required checks cannot be discovered has not proven anything about its CI.
 */
async function requiredContexts(repo, base) {
  // NOTE: `gh api` takes no `-R` — the repo goes in the PATH (see requiredContextsPath).
  try {
    const v = JSON.parse(await gh(['api', requiredContextsPath(repo, base, 'protection'),
      '--jq', '.required_status_checks.contexts']))
    if (Array.isArray(v) && v.length) return v.map(String)
  } catch { /* classic branch protection is absent — repos on rulesets 404 here */ }
  try {
    const v = JSON.parse(await gh(['api', requiredContextsPath(repo, base, 'rules'),
      '--jq', '[.[] | select(.type=="required_status_checks") | .parameters.required_status_checks[].context]']))
    if (Array.isArray(v)) return v.map(String)
  } catch { /* neither resolved */ }
  return []
}

async function main() {
  const a = parseArgv(process.argv.slice(2))
  if (!a.pr) throw new Error('--pr <number> is required')
  if (!a.out) throw new Error('--out <gate-input.json> is required')

  const R = a.repo ? ['-R', String(a.repo)] : []
  const pr = await ghJSON([...R, 'pr', 'view', String(a.pr), '--json',
    'number,body,labels,files,additions,deletions,mergeStateStatus,baseRefName,statusCheckRollup'], `PR #${a.pr}`)

  // Routing only — the gate re-extracts authoritatively and fails closed if this disagrees.
  const linked = resolveLinkedIssue(pr.body)
  let issue = null
  if (linked) {
    try { issue = await ghJSON([...R, 'issue', 'view', String(linked), '--json', 'number,author,body,labels'], `issue #${linked}`) }
    catch (e) { console.error(`build-input: ${e.message} — the gate will fail closed on the missing issue`) }
  } else {
    console.error('build-input: the PR body declares no single resolvable `Closes #N` — the gate will fail single_closes')
  }

  let evidence = null
  if (a.evidence && a.evidence !== true) {
    try { evidence = JSON.parse(await readFile(String(a.evidence), 'utf8')) }
    catch (e) { console.error(`build-input: could not read --evidence (${e.message}) — omitting it`) }
  }

  const base = a.base && a.base !== true ? String(a.base) : (pr.baseRefName || 'main')
  const input = buildGateInput({ pr, issue, requiredContexts: await requiredContexts(a.repo, base), evidence })

  await writeFile(String(a.out), JSON.stringify(input, null, 2) + '\n')
  console.error(`build-input: wrote ${a.out} (PR #${input.pr.number} -> issue ${input.issue.number ?? 'unresolved'}, ` +
    `${input.pr.changedFiles ? input.pr.changedFiles.length : '?'} files, ${input.requiredContexts.length} required contexts)`)
}

main().catch((e) => {
  // Exit 1: the caller must ESCALATE. An input we could not build is never a merge.
  console.error(`build-input: ${e.message}`)
  process.exit(1)
})
