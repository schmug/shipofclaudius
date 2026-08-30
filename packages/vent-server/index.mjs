#!/usr/bin/env node
// Thin stdio entry point. Wiring only — the framing rules live in framing.mjs and every
// decision lives in server.mjs.
import { handle, makeState } from './server.mjs'
import { makeFramer } from './framing.mjs'
import { captureContext } from './context.mjs'
import { appendVent } from './sink.mjs'

// The host spawns one server process per session, so process-lifetime state IS
// session state — which is what makes MAX_PER_SESSION mean what it says.
const state = makeState()
const deps = {
  now: () => Date.now(),
  // VENT_SINK redirects the sink. It is read from the SERVER's environment, which the
  // host fixes at spawn time before any agent runs; an agent supplies only `text` and
  // can never reach it, so this is a test seam and not an escalation (THREAT_MODEL.md).
  // It exists so the suite can drive this entry point end-to-end without appending to
  // the operator's own ~/.claude/vents.jsonl, and so CI — which has no ~/.claude —
  // exercises the real wiring instead of reporting a permanent sink-unavailable.
  appendVent: (record) => appendVent(record, process.env.VENT_SINK || undefined),
  context: () => captureContext(),
}

process.stdin.on('data', makeFramer({
  dispatch: (msg) => handle(msg, state, deps),
  write: (line) => process.stdout.write(line),
}))
// The host owns this process's lifecycle. When it goes away mid-write the pipe breaks,
// and an unhandled EPIPE turns a routine disconnect into a crashed child with a stack
// trace — a vent is a side channel and must never be the noisy thing in a session. A
// broken pipe is expected teardown and exits quietly; anything else is a real fault and
// still reaches stderr rather than being swallowed (#155).
const onStreamError = (err) => {
  if (err?.code === 'EPIPE' || err?.code === 'ERR_STREAM_DESTROYED') process.exit(0)
  try { process.stderr.write(`vent: stream error: ${err?.code || err?.message}\n`) } catch {}
  process.exit(1)
}
process.stdout.on('error', onStreamError)
process.stdin.on('error', onStreamError)
process.stdin.resume()
