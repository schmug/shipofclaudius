// Reads the session transcript into the ordered blocks that form the conditioning set.
//
// Two hazards drive the shape of this module:
//
// 1. Spec §3.2 — the transcript is written asynchronously and lags the in-memory
//    conversation, so the current turn is usually ABSENT when the hook fires. Callers
//    therefore treat what comes back as "context as of the previous turn" and splice the
//    submitted prompt in themselves. Nothing here tries to find the current prompt.
// 2. Long sessions produce large JSONL files, and §3.3 budgets under 2 seconds for the
//    whole fast path. So reads are tail-bounded: referent resolution cares about recency,
//    and the tail is where recency lives.
import { openSync, fstatSync, readSync, closeSync } from 'node:fs'

export const MAX_TRANSCRIPT_BYTES = 2 * 1024 * 1024

// Reads at most `maxBytes` from the END of a file. A tail read almost always slices
// through a line, so the first partial record is dropped when the file was truncated.
export function readTail(path, maxBytes = MAX_TRANSCRIPT_BYTES) {
  let fd
  try {
    fd = openSync(path, 'r')
    const size = fstatSync(fd).size
    const length = Math.min(size, maxBytes)
    const buf = Buffer.allocUnsafe(length)
    readSync(fd, buf, 0, length, size - length)
    const text = buf.toString('utf8')
    return { text: length < size ? text.slice(text.indexOf('\n') + 1) : text, truncated: length < size }
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

// Pulls display text out of one message `content`, which is either a bare string or an
// array of blocks. Tool calls contribute their string-valued inputs (that is where file
// paths live) and tool results contribute their output, because both are context the
// user's next turn can legitimately refer back to.
function textOfContent(content, out) {
  if (typeof content === 'string') { if (content) out.push(content); return }
  if (!Array.isArray(content)) return
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (typeof block.text === 'string') out.push(block.text)
    else if (block.type === 'tool_use' && block.input && typeof block.input === 'object') {
      for (const v of Object.values(block.input)) if (typeof v === 'string') out.push(v)
    } else if (block.type === 'tool_result') textOfContent(block.content, out)
  }
}

// Tolerant JSONL parse. Every line is independently try/caught: a single malformed
// record in the middle of a transcript is normal (partial writes, tool crashes) and must
// not cost us the rest of the window.
export function parseTranscript(text) {
  const blocks = []
  let malformed = 0
  for (const line of String(text).split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let rec
    try { rec = JSON.parse(trimmed) } catch { malformed++; continue }
    if (!rec || typeof rec !== 'object') { malformed++; continue }
    const role = rec.message?.role || rec.type || 'unknown'
    if (role === 'summary') continue
    const parts = []
    if (rec.message) textOfContent(rec.message.content, parts)
    else if (typeof rec.content === 'string') parts.push(rec.content)
    else if (typeof rec.summary === 'string') parts.push(rec.summary)
    if (!parts.length) continue
    blocks.push({ role, text: parts.join('\n') })
  }
  return { blocks, malformed }
}

export function loadTranscript(path, maxBytes = MAX_TRANSCRIPT_BYTES) {
  if (!path) return { blocks: [], malformed: 0, truncated: false, ok: true }
  const { text, truncated } = readTail(path, maxBytes)
  const { blocks, malformed } = parseTranscript(text)
  // A window that parsed to nothing at all, from a file that did have bytes, is the
  // "transcript unparseable" failure in §8 — the caller records phase:"error" and exits 0.
  const ok = blocks.length > 0 || text.trim() === ''
  return { blocks, malformed, truncated, ok }
}
