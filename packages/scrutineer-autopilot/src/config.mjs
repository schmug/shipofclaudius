// Config, loopback guard and repo policy for the scrutineer-autopilot.
// Pure and model-free. `exec` is injected: async (cmd, args) => stdout string.
// Invariants: baseUrl must be loopback; no personal values live here (owner, token path and
// policy come from the user's config.json); `stop` is never defaulted, only user-configured.
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const STATE_DIR = join(homedir(), '.claude', 'scrutineer-autopilot')
export const DEFAULT_CONFIG_PATH = join(STATE_DIR, 'config.json')
const POLICIES = new Set(['auto', 'stop', 'exclude'])

export const DEFAULTS = Object.freeze({
  baseUrl: 'http://127.0.0.1:8080',
  tokenPath: join(homedir(), 'scrutineer', 'data', 'operator-token'),
  stateDir: STATE_DIR,
  budget: Object.freeze({
    reserve: 30,
    margin: 5,
    primaryWindowCap: 80,
    pctPerDollarSeed: 0.5,
    calibrationSamples: 20,
    calibrationDays: 14,
    estimateSamples: 10,
    estimatePercentile: 75,
    fallbackDiffUsd: 5,
    fallbackFullUsd: 15,
    fixEstimateUsd: 3,
    maxEnqueuesPerTick: 10,
    maxScanGroupsRunning: 1,
    fullRescanDays: 90,
  }),
})

export function isLoopback(url) {
  let u
  try { u = new URL(url) } catch { return false }
  return ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)
}

// "owner/name" lowercased from https, ssh or git+ GitHub URLs; null for anything else.
export function repoKey(url) {
  if (typeof url !== 'string') return null
  const m = url.trim().match(/^(?:https?:\/\/(?:www\.)?github\.com\/|(?:ssh:\/\/)?git@github\.com[:/])([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i)
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null
}

export function normalizeConfig(raw = {}, { owner } = {}) {
  const resolvedOwner = String(raw.owner ?? owner ?? '').toLowerCase()
  if (!resolvedOwner) throw new Error('config: owner is required')
  const baseUrl = raw.baseUrl ?? DEFAULTS.baseUrl
  if (!isLoopback(baseUrl)) throw new Error(`config: baseUrl must be loopback (127.0.0.1, localhost or ::1), got ${baseUrl}`)
  const repoPolicy = {}
  for (const [k, v] of Object.entries(raw.repoPolicy ?? {})) {
    if (!POLICIES.has(v)) throw new Error(`config: invalid policy ${JSON.stringify(v)} for ${k}`)
    repoPolicy[k.toLowerCase()] = v
  }
  return {
    owner: resolvedOwner,
    baseUrl,
    tokenPath: raw.tokenPath ?? DEFAULTS.tokenPath,
    allowlist: (raw.allowlist ?? []).map((s) => String(s).toLowerCase()),
    repoPolicy,
    budget: { ...DEFAULTS.budget, ...(raw.budget ?? {}) },
    stateDir: raw.stateDir ?? DEFAULTS.stateDir,
  }
}

export function policyFor(config, key) {
  const k = String(key).toLowerCase()
  if (!config.allowlist.includes(k)) return 'exclude'
  return config.repoPolicy[k] ?? 'auto'
}

export async function loadConfig(path = DEFAULT_CONFIG_PATH, { exec } = {}) {
  let raw = {}
  try { raw = JSON.parse(await readFile(path, 'utf8')) } catch (e) { if (e.code !== 'ENOENT') throw e }
  let owner = raw.owner
  if (!owner) owner = (await exec('gh', ['api', 'user', '--jq', '.login'])).trim()
  return normalizeConfig(raw, { owner })
}
