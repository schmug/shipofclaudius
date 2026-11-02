#!/usr/bin/env node
// Read-only finding relay for the fix workflow. Usage: finding.mjs [--config <path>] <finding-id>
// Prints only RELAY_FIELDS of one finding as JSON. Never prints the token; any non-GET request throws.
// Exit 3 when the finding's repository is not allowlisted (spec §11 scope check), 1 on error.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { loadConfig, DEFAULT_CONFIG_PATH, repoKey, policyFor } from '../src/config.mjs'
import { createClient } from '../src/client.mjs'
import { dryRunFetch, relayFields } from '../src/tick.mjs'

const pexec = promisify(execFile)
const exec = async (cmd, args) => (await pexec(cmd, args)).stdout

try {
  const argv = process.argv.slice(2)
  let config = DEFAULT_CONFIG_PATH
  const ci = argv.indexOf('--config')
  if (ci >= 0) config = argv.splice(ci, 2)[1]
  const id = argv[0]
  if (!/^\d+$/.test(id ?? '')) throw new Error('usage: finding.mjs [--config <path>] <finding-id>')
  const cfg = await loadConfig(config, { exec })
  const client = createClient({ baseUrl: cfg.baseUrl, tokenPath: cfg.tokenPath, fetch: dryRunFetch(globalThis.fetch) })
  const f = await client.getFinding(id)
  const repo = (await client.listRepositories()).find((r) => r.id === f.repository_id)
  const key = repoKey(repo?.url)
  if (!key || !key.startsWith(`${cfg.owner}/`) || policyFor(cfg, key) === 'exclude') {
    console.error(`finding ${id}: repository not allowlisted`)
    process.exit(3)
  }
  console.log(JSON.stringify(relayFields(f), null, 2))
} catch (e) {
  console.error(`finding: ${String(e?.message ?? e).split('\n')[0]}`)
  process.exit(1)
}
