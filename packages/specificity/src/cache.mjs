// The per-session cache file (spec §6) — the only coupling between the hook and the
// status line.
//
// Written temp-and-rename because the status line may read at ANY moment: it re-renders
// on every conversation update, so a half-written file is not a rare race, it is a
// routine one. rename(2) within a directory is atomic, so a reader sees either the whole
// previous record or the whole new one.
import { mkdirSync, writeFileSync, renameSync, unlinkSync, statSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'

export const PHASES = new Set(['fast', 'sampling', 'complete', 'skipped', 'error'])

// `session_id` arrives from the hook payload, so it is untrusted input that we are about
// to interpolate into a filesystem path. Anything that is not a plain id is rejected
// outright rather than sanitized — there is no legitimate session id with a slash in it,
// so a value containing one is a bug or an attack, and neither deserves a written file.
const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/

export function isSafeSessionId(id) {
  return typeof id === 'string' && SAFE_ID_RE.test(id)
}

export function cachePathFor(dir, sessionId) {
  if (!isSafeSessionId(sessionId)) return null
  return join(dir, `${sessionId}.json`)
}

// How far up the tree we are willing to create. A cache directory is one or two levels
// below an existing home, never eight.
export const MAX_CREATE_DEPTH = 8

// Creates `dir`, WITHOUT `mkdirSync(..., { recursive: true })`.
//
// That flag hangs. On Linux, `mkdirSync('/proc/nonexistent', { recursive: true })` never
// returns, while the plain non-recursive call throws ENOENT in under a millisecond and
// `statSync` on the same path throws ENOENT just as fast. It cost a 30-minute CI hang to
// find, and it is not a hypothetical: `dir` comes from `SPECIFICITY_DIR` or `$HOME`, both
// of which a user can point anywhere. A UserPromptSubmit hook that hangs blocks the turn
// until the host's timeout, and no try/catch can rescue a call that never returns — which
// makes this the one way the tool could violate §8's invariant outright.
//
// So: walk up with `statSync` to the nearest existing ancestor, bounded, then create back
// down with non-recursive `mkdirSync` calls. Every syscall here is one of the two proven
// to fail fast.
export function ensureDir(dir) {
  const abs = resolve(dir)
  const missing = []
  let cur = abs
  for (;;) {
    let st = null
    try { st = statSync(cur) } catch { /* missing, or unreadable: treat as missing */ }
    if (st) {
      if (!st.isDirectory()) throw new Error(`ENOTDIR: ${cur} exists and is not a directory`)
      break
    }
    missing.push(cur)
    const parent = dirname(cur)
    // `dirname('/') === '/'`: we have run out of tree without finding anything real.
    if (parent === cur) throw new Error(`no existing ancestor for ${abs}`)
    if (missing.length > MAX_CREATE_DEPTH) throw new Error(`${abs} is more than ${MAX_CREATE_DEPTH} levels below any existing directory`)
    cur = parent
  }
  for (const d of missing.reverse()) mkdirSync(d)  // non-recursive: fails fast, never hangs
  return abs
}

export function writeRecord(dir, sessionId, record) {
  const target = cachePathFor(dir, sessionId)
  if (!target) return null
  ensureDir(dir)
  const tmp = `${target}.${process.pid}.tmp`
  try {
    writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
    renameSync(tmp, target)
  } catch (e) {
    try { unlinkSync(tmp) } catch { /* the temp file may never have been created */ }
    throw e
  }
  return target
}
