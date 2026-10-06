// The `codex exec` backend: the same review, billed to the user's Codex CLI login (a
// ChatGPT subscription) instead of an API key.
//
// codex exec is an agent, not a completion endpoint, and the prompt carries an
// attacker-writable diff. A tool that can read the disk would let that diff steer the
// model into reading ~/.ssh or .env and sending the bytes to OpenAI, which the git
// pathspec excludes exist to prevent. So:
//  - every tool feature that reads local state or reaches out is disabled. Verified live
//    2026-10-02 (codex-cli 0.159.0-alpha.12.1, gpt-6-luna): with shell_tool + unified_exec
//    off, functions.exec could not read a canary file; code_mode_host off removes its host.
//  - an unknown --disable name makes codex exit 1 (verified on 0.153.4 and 0.159), so a
//    renamed feature fails the review instead of silently turning a tool back on.
//  - the run happens in a fresh empty temp dir, with the user's config.toml (MCP servers,
//    plugins, notify hooks), exec rules, memories and session history all left out.
//  - codex's stderr is its transcript, i.e. model text derived from the diff, so it is
//    written to a log file for the user and never put into a message Claude reads.
import { spawn } from 'node:child_process'
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SCHEMA } from './prompt.mjs'
import { validateReview } from './openai.mjs'

export const DISABLED_FEATURES = Object.freeze([
  'shell_tool', 'unified_exec', 'code_mode_host', 'view_image', 'memories', 'apps', 'plugins',
  'browser_use', 'computer_use', 'in_app_browser', 'multi_agent', 'multi_agent_v2', 'hooks',
])

const LOG_CAP = 256 * 1024

// gpt-6-luna on a ChatGPT login is rejected (HTTP 400) by codex-cli older than this.
export const MIN_CODEX_VERSION = [0, 159, 0]

export function parseCodexVersion(text) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(text))
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

export function versionLess(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i]
  return false
}

// Runs `<bin> --version`. Resolves the stdout text, or null when it hangs; rejects like
// spawn does when the binary cannot start.
function codexVersionText(bin) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(null) }, 10_000)
    child.stdout.on('data', (c) => { if (out.length < 4096) out += c })
    child.on('error', (e) => { clearTimeout(timer); reject(e) })
    child.on('close', () => { clearTimeout(timer); resolve(out) })
  })
}

export function codexArgs(cfg, work) {
  return [
    'exec', '-C', work, '--skip-git-repo-check', '-s', 'read-only',
    '--ephemeral', '--ignore-user-config', '--ignore-rules',
    ...DISABLED_FEATURES.flatMap((f) => ['--disable', f]),
    '-c', 'web_search="disabled"',
    '-m', cfg.model, '-c', `model_reasoning_effort="${cfg.effort}"`,
    '--output-schema', join(work, 'schema.json'), '-o', join(work, 'review.json'),
    '--color', 'never', '-',
  ]
}

// Runs codex with the prompt on stdin. Resolves { code, signal, timedOut, stderr }.
function run(bin, args, prompt, cwd, timeoutMs) {
  return new Promise((resolve, reject) => {
    // detached: codex is the leader of its own process group, so a timeout kills
    // anything it started too, not just the wrapper.
    const child = spawn(bin, args, { cwd, stdio: ['pipe', 'ignore', 'pipe'], detached: true })
    let stderr = ''
    let timedOut = false
    child.stderr.on('data', (c) => { if (stderr.length < LOG_CAP) stderr += c })
    child.stdin.on('error', () => { /* codex exited before reading the prompt; its exit code says why */ })
    const timer = setTimeout(() => {
      timedOut = true
      try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
    }, timeoutMs)
    child.on('error', (e) => { clearTimeout(timer); reject(e) })
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, timedOut, stderr }) })
    child.stdin.end(prompt)
  })
}

export async function callCodex(prompt, cfg) {
  const notFound = (e) => new Error(e?.code === 'ENOENT'
    ? `codex CLI not found at "${cfg.codexBin}" (install it, or set LUNA_GATE_CODEX_BIN)`
    : `could not start codex: ${e?.code || 'spawn failed'}`)
  // A stale default `codex` would otherwise get an HTTP 400 for the model and fail open or
  // deny every PR with no hint why. An unreadable version is not blocked: it may be a wrapper.
  let vtext
  try { vtext = await codexVersionText(cfg.codexBin) } catch (e) { throw notFound(e) }
  const v = parseCodexVersion(vtext)
  if (v && versionLess(v, MIN_CODEX_VERSION)) {
    throw new Error(`codex CLI ${v.join('.')} at "${cfg.codexBin}" is too old for ${cfg.model} (needs >= ${MIN_CODEX_VERSION.join('.')}); point LUNA_GATE_CODEX_BIN at a newer codex`)
  }
  const work = await mkdtemp(join(tmpdir(), 'luna-gate-codex-'))
  try {
    await writeFile(join(work, 'schema.json'), JSON.stringify(SCHEMA))
    let r
    try {
      r = await run(cfg.codexBin, codexArgs(cfg, work), prompt, work, cfg.timeoutMs)
    } catch (e) {
      throw notFound(e)
    }
    if (r.timedOut) throw new Error(`timed out after ${Math.round(cfg.timeoutMs / 1000)}s`)
    if (r.code !== 0) {
      const log = join(cfg.dir, 'codex-last.log')
      let where = ''
      try { await mkdir(cfg.dir, { recursive: true }); await writeFile(log, r.stderr); where = `; log: ${log}` } catch { /* best effort */ }
      throw new Error(`codex exited ${r.code ?? r.signal}${where}`)
    }
    let text = ''
    try { text = await readFile(join(work, 'review.json'), 'utf8') } catch { /* handled below */ }
    if (!text.trim()) throw new Error('codex produced no final message')
    let obj
    try { obj = JSON.parse(text) } catch { throw new Error('model output was not valid JSON') }
    return { review: validateReview(obj), usage: null }
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {})
  }
}
