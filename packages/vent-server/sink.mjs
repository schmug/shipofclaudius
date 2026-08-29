// Append-only JSONL sink. A single small O_APPEND write, so concurrent sessions
// interleave whole lines rather than corrupting each other. Never read-modify-write.
//
// Two properties this file is responsible for (see THREAT_MODEL.md):
//   - It NEVER throws. A vent is a side channel; a missing or unwritable sink must
//     be a `false` return the caller turns into a calm outcome, not an exception
//     that surfaces in the session.
//   - One record is exactly one line. JSON.stringify escapes any newline inside the
//     agent-supplied `text`, so a vent cannot forge a second record for the reader.
import { appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const DEFAULT_SINK = join(homedir(), '.claude', 'vents.jsonl')

export function appendVent(record, path = DEFAULT_SINK) {
  try {
    // mode applies only at creation. The record carries cwd, repo, branch, session and
    // free-form text that in practice quotes paths, command output and error messages;
    // the default 0644 under a 0755 ~/.claude makes all of that world-readable.
    appendFileSync(path, JSON.stringify(record) + '\n', { mode: 0o600 })
    return true
  } catch {
    return false
  }
}
