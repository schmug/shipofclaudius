// The per-session cache file (spec §6) — the only coupling between the hook and the
// status line.
//
// Written temp-and-rename because the status line may read at ANY moment: it re-renders
// on every conversation update, so a half-written file is not a rare race, it is a
// routine one. rename(2) within a directory is atomic, so a reader sees either the whole
// previous record or the whole new one.
import { mkdirSync, writeFileSync, renameSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

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

export function writeRecord(dir, sessionId, record) {
  const target = cachePathFor(dir, sessionId)
  if (!target) return null
  mkdirSync(dir, { recursive: true })
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
