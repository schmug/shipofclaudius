// Config for the prompt-specificity scorer (spec §7).
//
// Node built-ins only, like everything else in this repo, so the "TOML" parser here is
// deliberately a flat key=value reader rather than a real one: every key in §7 is a
// scalar at the top level, and vendoring a TOML grammar to read eight scalars would be
// the kind of dependency the repo exists to avoid. Section headers are tolerated and
// ignored; arrays and inline tables are ignored rather than erroring, because §8's
// invariant is that no configuration of this tool may break a session.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const DEFAULTS = Object.freeze({
  mode: 'advisory',            // 'advisory' | 'gate'
  gate_threshold: 3,           // unresolved referents that trigger exit 2 in gate mode
  emit_ambiguities: false,     // send unresolved referents to Claude via additionalContext
  sample_count: 10,            // N per side of the delta (M2); 8 was below the N=10 the
                               // published work uses, and small N biases entropy downward
  sample_max_tokens: 200,      // truncation per sample (M2)
  skip_threshold: 120,         // prompt tokens above which sampling is skipped if grounded (M2)
  embedding_backend: 'local',  // 'local' | 'hosted' | 'llm' (M2)
  sampling_model: '',          // model used for the 2N samples (M2)
})

const MODES = new Set(['advisory', 'gate'])
const BACKENDS = new Set(['local', 'hosted', 'llm'])

// Strips a trailing `# comment`, respecting quotes so a `#` inside a string survives.
function stripComment(line) {
  let quote = null
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quote) { if (c === quote && line[i - 1] !== '\\') quote = null; continue }
    if (c === '"' || c === "'") { quote = c; continue }
    if (c === '#') return line.slice(0, i)
  }
  return line
}

function parseValue(raw) {
  const v = raw.trim()
  if (v === '') return undefined
  if (v === 'true') return true
  if (v === 'false') return false
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1)
  }
  if (/^-?\d+$/.test(v)) return Number.parseInt(v, 10)
  if (/^-?\d*\.\d+$/.test(v)) return Number.parseFloat(v)
  return undefined  // arrays, inline tables, dates: not used by §7, so not supported
}

export function parseToml(text) {
  const out = {}
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = stripComment(rawLine).trim()
    if (!line || line.startsWith('[')) continue  // section headers are flattened away
    const eq = line.indexOf('=')
    if (eq < 1) continue
    const key = line.slice(0, eq).trim().replace(/^["']|["']$/g, '')
    if (!key) continue
    const value = parseValue(line.slice(eq + 1))
    if (value !== undefined) out[key] = value
  }
  return out
}

// Coerces a parsed table onto DEFAULTS. Anything of the wrong type, out of range, or
// outside an enum falls back to its default rather than throwing — a typo in the config
// file must not be able to take a session down.
export function normalizeConfig(raw = {}) {
  const c = { ...DEFAULTS }
  const num = (k, min, max) => {
    const v = raw[k]
    if (typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max) c[k] = Math.floor(v)
  }
  if (MODES.has(raw.mode)) c.mode = raw.mode
  if (BACKENDS.has(raw.embedding_backend)) c.embedding_backend = raw.embedding_backend
  if (typeof raw.emit_ambiguities === 'boolean') c.emit_ambiguities = raw.emit_ambiguities
  if (typeof raw.sampling_model === 'string') c.sampling_model = raw.sampling_model
  num('gate_threshold', 1, 1000)
  num('sample_count', 1, 64)
  num('sample_max_tokens', 1, 8192)
  num('skip_threshold', 0, 100000)
  return c
}

export function configDir() {
  return process.env.SPECIFICITY_DIR || join(homedir(), '.claude', 'specificity')
}

export function loadConfig(dir = configDir()) {
  try {
    return normalizeConfig(parseToml(readFileSync(join(dir, 'config.toml'), 'utf8')))
  } catch {
    return { ...DEFAULTS }  // absent or unreadable config is the normal case
  }
}
