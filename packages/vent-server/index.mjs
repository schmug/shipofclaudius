#!/usr/bin/env node
// Thin stdio entry point. Framing only — all decisions live in server.mjs.
import { handle, makeState } from './server.mjs'
import { StringDecoder } from 'node:string_decoder'

const state = makeState()
const deps = {
  now: () => Date.now(),
  // n1 ships NO sink — the real appendVent lands with n2 (#142). Until then this
  // returns false so the live tool says `sink-unavailable` instead of confirming a
  // write that never happened. .mcp.json makes this tool reachable in real sessions
  // from the moment n1 merges, and a tool that lies about recording is the exact
  // failure mode the vent exists to avoid. n2 replaces this stub wholesale.
  appendVent: () => false,
  context: () => ({}),
}

// Decoding must be STATEFUL. A chunk boundary can fall inside a multi-byte UTF-8
// sequence, and decoding each chunk on its own turns that character into U+FFFD. The
// corruption is silent: 0x0A never appears inside a multi-byte sequence, so lines still
// split correctly, JSON.parse still succeeds, and both callVent guards still pass — only
// the text is wrong. `buf` below already anticipated a MESSAGE splitting across events;
// this is the character-level half of the same problem (#154).
const decoder = new StringDecoder('utf8')
let buf = ''
process.stdin.on('data', (chunk) => {
  buf += decoder.write(chunk)
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim()
    buf = buf.slice(i + 1)
    if (!line) continue
    let msg
    try { msg = JSON.parse(line) } catch { continue }
    let reply = null
    try { reply = handle(msg, state, deps) } catch {
      // A request (one bearing an id) must ALWAYS draw a reply. Swallowing a throw into
      // a null reply writes nothing and leaves the client blocked until its own timeout
      // — worse than any error. Notifications carry no id and still draw nothing.
      if (msg?.id !== undefined) {
        reply = { jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'Internal error' } }
      }
    }
    if (reply) process.stdout.write(JSON.stringify(reply) + '\n')
  }
})
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
