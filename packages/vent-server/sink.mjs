// Append-only JSONL sink. A single small O_APPEND write, so concurrent sessions
// interleave whole lines rather than corrupting each other. Never read-modify-write.
//
// Three properties this file is responsible for (see THREAT_MODEL.md):
//   - It NEVER throws. A vent is a side channel; a missing or unwritable sink must
//     be a `false` return the caller turns into a calm outcome, not an exception
//     that surfaces in the session.
//   - One record is exactly one line. JSON.stringify escapes any newline inside the
//     agent-supplied `text`, so a vent cannot forge a second record for the reader.
//   - A write that does NOT complete damages exactly one line. The reader is
//     line-by-line, so an unterminated fragment would otherwise be concatenated by the
//     next append into a single unparseable line, losing two records instead of one.
import { closeSync, openSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

// The line terminator, written on its own to close a damaged record. Module-level so
// the repair path allocates nothing at the moment the disk is already refusing writes.
const TERMINATOR = Buffer.from('\n', 'utf8')

// `null` rather than a relative path when there is no usable home. homedir() returns ''
// on a host with no HOME and no passwd entry (containers, some CI runners), and
// join('', '.claude', 'vents.jsonl') is '.claude/vents.jsonl' — resolved against
// whatever directory the host spawned this server in. That silently RESOLVES inside any
// repo with a .claude/ directory, so vents would land in a working tree and be read by
// nobody. No sink is honest; the caller turns it into a calm `sink-unavailable`.
export function defaultSink(home = homedir()) {
  return isAbsolute(home) ? join(home, '.claude', 'vents.jsonl') : null
}

export const DEFAULT_SINK = defaultSink()

// `writeFn` is a test seam, not a knob: it exists because a short write is the one
// failure mode no real filesystem can be asked for on demand, and it is the failure
// that corrupts the READER rather than merely losing a record. Same role `gitFn` plays
// in context.mjs. Nothing agent-reachable ever reaches this parameter.
export function appendVent(record, path = DEFAULT_SINK, writeFn = writeSync) {
  if (!path) return false
  const line = Buffer.from(JSON.stringify(record) + '\n', 'utf8')
  let fd
  try {
    // mode applies only at creation. The record carries cwd, repo, branch, session and
    // free-form text that in practice quotes paths, command output and error messages;
    // the default 0644 under a 0755 ~/.claude makes all of that world-readable.
    fd = openSync(path, 'a', 0o600)
    // ONE write, O_APPEND, no read-modify-write: that is what lets concurrent sessions
    // interleave whole lines. A short return is not an error — write(2) may accept fewer
    // bytes than offered (ENOSPC partway, an interrupting signal) and report success —
    // so the byte count is the ONLY signal that the line on disk is a fragment.
    // appendFileSync discards it and loops instead, which is how a partial line could be
    // left behind while the caller was told only `sink-unavailable`.
    if (writeFn(fd, line, 0, line.length) === line.length) return true
    // Short. The bytes on disk are a truncated record with no terminator, and the next
    // append — from this process or a concurrent one — would run straight onto the end
    // of it. Closing the line confines the damage to itself: one unparseable line the
    // reader skips, instead of one unparseable line that also eats its successor.
    // Best-effort by construction: if the disk is full this fails too, and there is
    // nothing further to try. Never truncate back instead — under O_APPEND the bytes at
    // the end of the file may belong to another session by now.
    try { writeFn(fd, TERMINATOR, 0, TERMINATOR.length) } catch { /* already lost */ }
    return false
  } catch {
    return false
  } finally {
    if (fd !== undefined) { try { closeSync(fd) } catch { /* nothing left to salvage */ } }
  }
}
