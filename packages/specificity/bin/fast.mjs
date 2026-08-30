#!/usr/bin/env node
// H1 — the synchronous UserPromptSubmit hook (spec §3).
//
// Registered as a `command` hook on UserPromptSubmit; reads the event JSON on stdin,
// writes the §6 cache record, and prints its advisory JSON on stdout. Budget is under 2
// seconds and stdlib only, so everything here is local string work: no model calls, no
// network, no subprocesses.
//
// THE INVARIANT (spec §8): no configuration of this tool may break a session. Every path
// except an explicit gate-mode block exits 0 — including a missing transcript, an
// unparseable one, an unwritable cache dir, and any unexpected throw.
//
// Exit-code discipline (§3.4): 2 is the only code that blocks, and on UserPromptSubmit it
// also ERASES the prompt. 1 is a non-blocking error that merely prints a hook-error
// notice. So failure is never signalled with 1 in the hope of gating.
import { readSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { loadConfig, configDir } from '../src/config.mjs'
import { loadTranscript } from '../src/transcript.mjs'
import { walkFiles } from '../src/files.mjs'
import { buildIndex } from '../src/context-index.mjs'
import { extractReferents } from '../src/referents.mjs'
import { buildFastBlock, buildRecord, summarize, ambiguityContext } from '../src/record.mjs'
import { writeRecord } from '../src/cache.mjs'

// Synchronous drain of fd 0. The hook is a short-lived process whose entire job is
// bounded by a timeout, so blocking here is simpler and more predictable than the async
// stream dance; EAGAIN is retried because a pipe can be momentarily empty.
function readStdin() {
  const chunks = []
  const buf = Buffer.allocUnsafe(65536)
  for (;;) {
    let n
    try {
      n = readSync(0, buf, 0, buf.length, null)
    } catch (e) {
      if (e.code === 'EAGAIN') continue
      if (e.code === 'EOF') break
      throw e
    }
    if (n === 0) break
    chunks.push(Buffer.from(buf.subarray(0, n)))
  }
  return Buffer.concat(chunks).toString('utf8')
}

export function computeFast(event, { cwd } = {}) {
  const transcript = loadTranscript(event.transcript_path)
  const root = cwd || event.cwd || process.cwd()
  const index = buildIndex({ blocks: transcript.blocks, files: walkFiles(root) })
  const referents = extractReferents(event.prompt || '')
  return { fast: buildFastBlock(event.prompt || '', referents, index), transcript }
}

// Builds everything the hook emits without performing any I/O of its own, so the whole
// decision — record, exit code, stdout payload — is unit-testable.
export function decide(event, config) {
  let fast = null
  let phase = 'skipped'  // M1 ships no sampler; see record.mjs on why this is not "fast"
  try {
    const result = computeFast(event)
    fast = result.fast
    if (!result.transcript.ok) phase = 'error'
  } catch {
    phase = 'error'
  }

  const sessionId = typeof event.session_id === 'string' ? event.session_id : ''
  const record = buildRecord({ session_id: sessionId, prompt_id: event.prompt_id, fast, phase })

  if (config.mode === 'gate' && fast && fast.unresolved >= config.gate_threshold) {
    const listed = fast.referents.filter((r) => r.status === 'unresolved').map((r) => `  - "${r.text}"`)
    return {
      record,
      exitCode: 2,  // the ONLY blocking path in this program
      stderr: `Blocked: ${fast.unresolved} unresolved referents (gate_threshold=${config.gate_threshold}).\n${listed.join('\n')}\n`,
    }
  }

  const payload = { systemMessage: summarize(fast) }
  if (config.emit_ambiguities && fast) {
    const additionalContext = ambiguityContext(fast)
    if (additionalContext) {
      payload.hookSpecificOutput = { hookEventName: 'UserPromptSubmit', additionalContext }
    }
  }
  return { record, exitCode: 0, stdout: `${JSON.stringify(payload)}\n` }
}

function main() {
  let event = {}
  try { event = JSON.parse(readStdin() || '{}') } catch { event = {} }

  const dir = configDir()
  const config = loadConfig(dir)
  const { record, exitCode, stdout, stderr } = decide(event, config)

  // A cache the status line cannot read is a cosmetic failure, never a session failure.
  try { writeRecord(dir, record.session_id, record) } catch { /* fail open */ }

  if (stderr) process.stderr.write(stderr)
  if (stdout) process.stdout.write(stdout)
  // Deliberately NOT process.exit(): stdout to a pipe is async, and exiting can truncate
  // the JSON payload the host is waiting on. Setting exitCode lets Node flush and leave.
  process.exitCode = exitCode
}

// Only run when invoked as the hook, so the test suite can import the module.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main() } catch { process.exitCode = 0 }  // last-resort fail-open
}
