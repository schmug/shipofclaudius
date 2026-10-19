// Blast radius: changed files, the files that reference them (1-2 hops), and tests.
//
// HEURISTIC, and labelled as such in the cockpit. There is no per-language resolver here:
// a file "imports" a changed file when one of its lines names the changed file's stem in an
// import/require/from/include/use statement, or quotes a path ending in the file's name.
// That over-reports common stems (a file called `utils`) and misses dynamic imports, but it
// works on any language with zero dependencies. ripgrep when present, grep otherwise.

import { execFileSync } from 'node:child_process'

const CODE_EXT = /\.(m?[jt]sx?|cjs|cts|mts|py|go|rs|rb|java|kt|kts|swift|c|cc|cpp|h|hpp|cs|php|sh|bash|zsh|css|scss|less|vue|svelte|astro|json|jsonc|ya?ml|toml)$/i
const TEST_PATH = /(^|\/)(tests?|__tests__|specs?|e2e)\/|\.(test|spec)\.[a-z]+$|_test\.(go|py|rb)$|(^|\/)test_[^/]+\.py$/i
// Stems too generic to grep for on their own: fall back to `<dir>/<stem>`.
const GENERIC = new Set(['index', 'main', 'mod', '__init__', 'lib', 'utils', 'util', 'types', 'config', 'package', 'readme'])
const EXCLUDES = ['node_modules', '.git', 'dist', 'build', '.review', 'vendor', 'coverage', '.next', 'target']

const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export const isTestPath = (p) => TEST_PATH.test(p)

/** The regex (ERE/PCRE-compatible subset) that finds references to `path`. */
export function referencePattern(path) {
  const parts = path.split('/')
  const file = parts.pop()
  const stem = file.replace(/\.[^.]+$/, '')
  const dir = parts.pop()
  const needle = GENERIC.has(stem.toLowerCase()) && dir ? `${reEsc(dir)}/${reEsc(stem)}` : reEsc(stem)
  return `((import|require|from|include|use|source|load).*['"/.]${needle}(\\.[A-Za-z]+)?['"]|['"/]${reEsc(file)}['"])`
}

function search(root, pattern, haveRg) {
  try {
    const out = haveRg
      ? execFileSync('rg', ['-l', '--no-messages', '--max-filesize', '1M', ...EXCLUDES.flatMap((e) => ['-g', `!${e}`]), '-e', pattern, '.'],
        { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 << 20 })
      : execFileSync('grep', ['-rlE', ...EXCLUDES.map((e) => `--exclude-dir=${e}`), '-e', pattern, '.'],
        { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 << 20 })
    return out.split('\n').filter(Boolean).map((p) => p.replace(/^\.\//, ''))
  } catch (e) {
    // Exit 1 = no matches (both tools). Anything else is also treated as "none found".
    return []
  }
}

function hasRg() {
  try { execFileSync('rg', ['--version'], { stdio: 'ignore' }); return true } catch { return false }
}

/**
 * @param {string} root  repo working tree
 * @param {string[]} changed  repo-relative changed paths (deleted files included)
 * @param {{ hops?: number, maxNodes?: number }} [opt]
 */
export function blastRadius(root, changed, opt = {}) {
  const hops = opt.hops ?? 2
  const maxNodes = opt.maxNodes ?? 80
  const haveRg = opt.haveRg ?? hasRg()
  const nodes = new Map()
  const edges = []
  const add = (id, hop) => {
    if (!nodes.has(id)) nodes.set(id, { id, hop, changed: hop === 0, test: isTestPath(id) })
    return nodes.get(id)
  }
  for (const c of changed) add(c, 0)
  let frontier = [...changed]
  let truncated = false
  for (let hop = 1; hop <= hops && frontier.length; hop++) {
    const next = []
    for (const target of frontier) {
      if (!CODE_EXT.test(target)) continue
      for (const src of search(root, referencePattern(target), haveRg)) {
        if (src === target) continue
        if (!nodes.has(src)) {
          if (nodes.size >= maxNodes) { truncated = true; continue }
          add(src, hop)
          next.push(src)
        }
        edges.push({ from: src, to: target })
      }
    }
    frontier = next
  }
  const list = [...nodes.values()]
  return {
    heuristic: true,
    tool: haveRg ? 'ripgrep' : 'grep',
    hops,
    truncated,
    nodes: list,
    edges,
    tests: list.filter((n) => n.test).map((n) => ({ path: n.id, changed: n.changed, hop: n.hop })),
  }
}
