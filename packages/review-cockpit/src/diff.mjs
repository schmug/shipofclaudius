// Unified-diff parser for the review cockpit.
//
// Input is `git diff` / `gh api ... Accept: application/vnd.github.diff` output. The parser
// is forgiving by design: anything it cannot place is kept in the raw diff, which the
// cockpit always shows, so a misparse loses structure but never loses bytes.

/**
 * @typedef {{ t: '+'|'-'|' ', s: string, oldNo: number|null, newNo: number|null }} DiffLine
 * @typedef {{ header: string, oldStart: number, newStart: number, lines: DiffLine[] }} Hunk
 * @typedef {{ path: string, oldPath: string, status: 'added'|'deleted'|'renamed'|'modified',
 *   binary: boolean, additions: number, deletions: number, hunks: Hunk[] }} DiffFile
 */

const unquote = (p) => {
  // git quotes paths with unusual bytes: "a/foo\tbar". Undo the common escapes only.
  if (!p.startsWith('"')) return p
  return p.slice(1, -1).replace(/\\(["\\tn])/g, (_, c) => ({ t: '\t', n: '\n' }[c] || c))
}
const stripPrefix = (p) => (p === '/dev/null' ? p : p.replace(/^[ab]\//, ''))

/** @param {string} text @returns {DiffFile[]} */
export function parseUnifiedDiff(text) {
  const files = []
  let file = null
  let hunk = null
  let oldNo = 0
  let newNo = 0
  for (const line of String(text || '').split('\n')) {
    if (line.startsWith('diff --git ')) {
      const m = line.match(/^diff --git (?:"?a\/(.+?)"?) (?:"?b\/(.+?)"?)$/)
      file = { path: m ? m[2] : '', oldPath: m ? m[1] : '', status: 'modified', binary: false, additions: 0, deletions: 0, hunks: [] }
      files.push(file)
      hunk = null
      continue
    }
    if (!file) continue
    if (!hunk || !/^[-+ \\]/.test(line) || line.startsWith('--- ') || line.startsWith('+++ ')) {
      if (line.startsWith('new file mode')) { file.status = 'added'; continue }
      if (line.startsWith('deleted file mode')) { file.status = 'deleted'; continue }
      if (line.startsWith('rename from ')) { file.status = 'renamed'; file.oldPath = line.slice(12); continue }
      if (line.startsWith('rename to ')) { file.path = line.slice(10); continue }
      if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) { file.binary = true; continue }
      if (line.startsWith('--- ') && !hunk) { const p = stripPrefix(unquote(line.slice(4))); if (p !== '/dev/null') file.oldPath = p; continue }
      if (line.startsWith('+++ ') && !hunk) { const p = stripPrefix(unquote(line.slice(4))); if (p !== '/dev/null') file.path = p; continue }
    }
    const h = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
    if (h) {
      hunk = { header: line, oldStart: Number(h[1]), newStart: Number(h[2]), lines: [] }
      oldNo = hunk.oldStart
      newNo = hunk.newStart
      file.hunks.push(hunk)
      continue
    }
    if (!hunk) continue
    const t = line[0]
    if (t === '+') { hunk.lines.push({ t, s: line.slice(1), oldNo: null, newNo: newNo++ }); file.additions++ }
    else if (t === '-') { hunk.lines.push({ t, s: line.slice(1), oldNo: oldNo++, newNo: null }); file.deletions++ }
    else if (t === ' ') hunk.lines.push({ t, s: line.slice(1), oldNo: oldNo++, newNo: newNo++ })
    // '\ No newline at end of file' and the trailing empty split element are ignored.
  }
  if (files.length === 0) return files
  for (const f of files) if (f.status === 'deleted' && !f.path) f.path = f.oldPath
  return files
}

/** Stable anchor id for a hunk, shared by the Code tab and every link into it. */
export const hunkId = (fileIndex, hunkIndex) => `h-${fileIndex}-${hunkIndex}`
export const fileId = (fileIndex) => `f-${fileIndex}`
