// Newline-delimited JSON framing for the vent stdio server. Extracted from index.mjs
// (#158 item 1) so these rules can be driven directly: index.mjs owns the WIRING — which
// streams, which deps, which process — and this owns the bytes-to-messages rules. Every
// framing defect this server has shipped so far lived here rather than in handle(), and
// the -32603 backstop below is unreachable from any stdin a test can write, so it needs
// an injectable `dispatch` to be exercised at all.
import { StringDecoder } from 'node:string_decoder'

// Returns a stdin 'data' handler. `dispatch(msg)` is handle() bound to its state+deps;
// `write(line)` receives one already-newline-terminated reply at a time.
export function makeFramer(deps) {
  const { dispatch, write } = deps
  // Decoding must be STATEFUL. A chunk boundary can fall inside a multi-byte UTF-8
  // sequence, and decoding each chunk on its own turns that character into U+FFFD. The
  // corruption is silent: 0x0A never appears inside a multi-byte sequence, so lines still
  // split correctly, JSON.parse still succeeds, and both callVent guards still pass — only
  // the text is wrong. `buf` below already anticipated a MESSAGE splitting across events;
  // this is the character-level half of the same problem (#154).
  const decoder = new StringDecoder('utf8')
  let buf = ''
  return (chunk) => {
    buf += decoder.write(chunk)
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (!line) continue
      let msg
      try { msg = JSON.parse(line) } catch { continue }
      let reply = null
      try { reply = dispatch(msg) } catch {
        // A request (one bearing an id) must ALWAYS draw a reply. Swallowing a throw into
        // a null reply writes nothing and leaves the client blocked until its own timeout
        // — worse than any error. Notifications carry no id and still draw nothing.
        if (msg?.id !== undefined) {
          reply = { jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'Internal error' } }
        }
      }
      if (reply) write(JSON.stringify(reply) + '\n')
    }
  }
}
