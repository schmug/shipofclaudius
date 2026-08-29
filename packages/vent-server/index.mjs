#!/usr/bin/env node
// Thin stdio entry point. Framing only — all decisions live in server.mjs.
import { handle, makeState } from './server.mjs'

const state = makeState()
const deps = {
  now: () => Date.now(),
  appendVent: () => true,
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
    try { reply = handle(msg, state, deps) } catch { reply = null }
    if (reply) process.stdout.write(JSON.stringify(reply) + '\n')
  }
})
process.stdin.resume()
