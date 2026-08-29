#!/usr/bin/env node
// Thin stdio entry point. Framing only — all decisions live in server.mjs.
import { handle, makeState } from './server.mjs'

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

let buf = ''
process.stdin.on('data', (chunk) => {
  buf += chunk.toString()
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
process.stdin.resume()
