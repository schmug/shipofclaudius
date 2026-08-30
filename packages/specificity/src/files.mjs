// Bounded directory walk — the disk half of the candidate index (spec §3.2: `cwd` is
// consumed "for resolving file referents").
//
// "the config file" is ambiguous precisely when the repo holds three of them, so the
// referent resolver needs to know what is on disk, not just what is in the window. The
// walk is hard-capped on every axis because it sits inside the sub-2s fast path: a
// monorepo with 200k files must cost the same as a small one.
import { readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

export const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', 'out', 'target', 'vendor', 'coverage',
  '.next', '.nuxt', '.cache', '.venv', 'venv', '__pycache__', '.terraform', 'tmp',
])

export const WALK_LIMITS = Object.freeze({ maxDepth: 4, maxEntries: 5000, maxDirs: 800 })

// Returns repo-relative POSIX paths. Errors at any level are swallowed: an unreadable
// subdirectory degrades the index, it does not fail the hook.
export function walkFiles(root, limits = WALK_LIMITS) {
  const files = []
  if (!root) return files
  let dirsVisited = 0
  const queue = [[root, 0]]
  while (queue.length && files.length < limits.maxEntries && dirsVisited < limits.maxDirs) {
    const [dir, depth] = queue.shift()
    dirsVisited++
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      if (files.length >= limits.maxEntries) break
      const name = entry.name
      if (name.startsWith('.') && name !== '.claude' && name !== '.github') continue
      const full = join(dir, name)
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(name) || depth >= limits.maxDepth) continue
        queue.push([full, depth + 1])
      } else if (entry.isFile()) {
        files.push(relative(root, full).split(sep).join('/'))
      }
    }
  }
  return files
}
