// Environment-only configuration for luna-gate.
//
// Every key has a safe default and a malformed value falls back to that default instead
// of throwing: the hook must never break a session (same invariant as packages/specificity).
// The one default that matters most is `mode: 'off'` — nothing leaves the machine until the
// user sets LUNA_GATE explicitly, because enabling this sends source code to a third party.
import { homedir } from 'node:os'
import { join } from 'node:path'

export const MODES = Object.freeze(['off', 'advisory', 'block'])
export const SEVERITIES = Object.freeze(['info', 'low', 'medium', 'high', 'critical'])
export const CONFIDENCES = Object.freeze(['low', 'medium', 'high'])
export const EFFORTS = Object.freeze(['none', 'low', 'medium', 'high', 'xhigh', 'max'])
export const ON_ERROR = Object.freeze(['open', 'closed'])
// codex: `codex exec` on the user's Codex CLI login (a ChatGPT subscription, no API key).
// api: one POST to the Responses API with OPENAI_API_KEY.
export const BACKENDS = Object.freeze(['codex', 'api'])

export const DEFAULTS = Object.freeze({
  mode: 'off',
  backend: 'codex',
  // gpt-6-luna needs codex-cli >= 0.159 on a ChatGPT login; 0.153.4 gets HTTP 400
  // "not supported when using Codex with a ChatGPT account" (checked 2026-10-02).
  codexBin: 'codex',
  model: 'gpt-6-luna',
  effort: 'max',
  threshold: 'high',
  onError: 'open',
  // ~150K tokens. GPT-6 Luna bills 2x input / 1.5x output past 272K input tokens, so the
  // default stays well under that cliff even with the developer prompt added.
  maxBytes: 600_000,
  // Under the 600 s hook timeout we document, so a slow review fails open *cleanly* (with
  // a message) rather than being killed by the harness with its output discarded.
  timeoutMs: 540_000,
  maxOutputTokens: 100_000,
  baseUrl: 'https://api.openai.com/v1',
  skipRemote: '',
  dir: join(homedir(), '.claude', 'luna-gate'),
})

const pick = (v, allowed, dflt) => {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : ''
  return allowed.includes(s) ? s : dflt
}
const posInt = (v, dflt) => {
  const n = Number(v)
  return Number.isSafeInteger(n) && n > 0 ? n : dflt
}
const str = (v, dflt) => (typeof v === 'string' && v.trim() ? v.trim() : dflt)

export function loadConfig(env = process.env) {
  return {
    mode: pick(env.LUNA_GATE, MODES, DEFAULTS.mode),
    backend: pick(env.LUNA_GATE_BACKEND, BACKENDS, DEFAULTS.backend),
    codexBin: str(env.LUNA_GATE_CODEX_BIN, DEFAULTS.codexBin),
    model: str(env.LUNA_GATE_MODEL, DEFAULTS.model),
    effort: pick(env.LUNA_GATE_EFFORT, EFFORTS, DEFAULTS.effort),
    threshold: pick(env.LUNA_GATE_THRESHOLD, SEVERITIES, DEFAULTS.threshold),
    onError: pick(env.LUNA_GATE_ON_ERROR, ON_ERROR, DEFAULTS.onError),
    maxBytes: posInt(env.LUNA_GATE_MAX_BYTES, DEFAULTS.maxBytes),
    timeoutMs: posInt(env.LUNA_GATE_TIMEOUT_MS, DEFAULTS.timeoutMs),
    maxOutputTokens: posInt(env.LUNA_GATE_MAX_OUTPUT_TOKENS, DEFAULTS.maxOutputTokens),
    baseUrl: str(env.OPENAI_BASE_URL, DEFAULTS.baseUrl).replace(/\/+$/, ''),
    skipRemote: str(env.LUNA_GATE_SKIP_REMOTE, DEFAULTS.skipRemote),
    dir: str(env.LUNA_GATE_DIR, DEFAULTS.dir),
    apiKey: str(env.OPENAI_API_KEY, ''),
  }
}

export const severityRank = (s) => SEVERITIES.indexOf(s)
