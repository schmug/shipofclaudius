#!/usr/bin/env node
// PreToolUse hook: before Claude runs `gh pr create`, send the branch's change to
// GPT-6 Luna (by default at max reasoning effort, through `codex exec`) for a security review.
//
// Not registered by the plugin. Wire it into your own settings.json (see README,
// "Pre-PR review gate"); nothing happens until LUNA_GATE is set to advisory or block.
//
// THE INVARIANT: this hook never breaks a session. Every path exits 0 and a failure is a
// message, never an exit code. The only way it stops a PR is an explicit
// permissionDecision "deny" in block mode. It never emits "allow".
import { readSync, realpathSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { loadConfig } from '../src/config.mjs'
import { findPrCreates, commandCount, hasRiskyExpansion, hasAmbiguousGh } from '../src/command.mjs'
import { review } from '../src/run.mjs'
import { hookOutput } from '../src/decide.mjs'

const REVIEW_BIN = fileURLToPath(new URL('./review.mjs', import.meta.url))
const shq = (p) => `'${String(p).replace(/'/g, `'\\''`)}'`

function readStdin() {
  const chunks = []
  const buf = Buffer.allocUnsafe(65536)
  for (;;) {
    let n
    try { n = readSync(0, buf, 0, buf.length, null) } catch (e) {
      if (e.code === 'EAGAIN') continue
      if (e.code === 'EOF') break
      throw e
    }
    if (n === 0) break
    chunks.push(Buffer.from(buf.subarray(0, n)))
  }
  return Buffer.concat(chunks).toString('utf8')
}

// Returns the stdout payload (string) or null for "say nothing".
// `parse` is a seam so a test can make the parser throw.
const PARSER = { findPrCreates, commandCount, hasRiskyExpansion, hasAmbiguousGh }
export async function main(raw, { env = process.env, fetchImpl, parse = PARSER } = {}) {
  let event
  try { event = JSON.parse(raw) } catch { return null }
  if (!event || event.tool_name !== 'Bash') return null
  const cfg = loadConfig(env)
  if (cfg.mode === 'off') return null
  const command = event.tool_input?.command
  // Parsing is inside a try: a parser crash on hostile input becomes a rejection (deny in
  // block mode), never a silent exit that lets the call through.
  let prs, ambiguous, risky, count, parseError = null
  try {
    prs = parse.findPrCreates(command)
    // A gh call whose subcommand the shell computes might be `gh pr create` in disguise;
    // check that before treating the command as unrelated.
    ambiguous = !prs.length && parse.hasAmbiguousGh(command)
    if (prs.length) { risky = parse.hasRiskyExpansion(command); count = parse.commandCount(command) }
  } catch (e) { parseError = e?.message || String(e) }
  if (!parseError && !prs.length && !ambiguous) return null
  let outcome
  if (parseError) {
    outcome = { kind: 'reject', message: 'luna-gate could not parse this command' }
  } else if (!prs.length) {
    outcome = { kind: 'reject', message: 'a `gh` call\'s command word or `pr`/`create` slot is computed by the shell, so luna-gate cannot tell whether it opens a PR' }
  } else if (prs.length > 1) {
    // One review covers one range; approving the first would let the rest through unreviewed.
    outcome = { kind: 'reject', message: `this command runs \`gh pr create\` ${prs.length} times, and one review covers one PR` }
  } else if (prs[0].unknownFlag) {
    outcome = { kind: 'reject', message: '`gh pr create` has a flag luna-gate does not know, so it cannot tell which values select the base, head or repo' }
  } else if (prs[0].dynamic) {
    outcome = { kind: 'reject', message: 'an argument to `gh pr create` (or a GH_REPO/GH_HOST value) is computed by the shell, so it could select a different base, head or repo after the review; use literal values' }
  } else if (risky) {
    outcome = { kind: 'reject', message: 'the command uses `${...}`, `$((...))` or `$[...]` expansion, which can run code before gh does' }
  } else if (prs[0].wrapped) {
    outcome = { kind: 'reject', message: '`gh pr create` runs behind a wrapper (such as `env -C`) or an environment assignment (PATH, GIT_*, GH_CONFIG_DIR, ...) that can swap the binary or point it at another repository than this checkout' }
  } else if (count > 1) {
    outcome = { kind: 'reject', message: '`gh pr create` shares this Bash call with other commands, which could change the checkout or refs after the review ran' }
  } else {
    const [pr] = prs
    try {
      outcome = await review({ cwd: event.cwd || process.cwd(), base: pr.base, head: pr.head,
        repo: pr.repo || (pr.repoEnvSet ? null : env.GH_REPO) || null,
        ghHost: pr.host !== undefined ? pr.host : (env.GH_HOST ?? null), cfg, fetchImpl })
    } catch (e) {
      outcome = { kind: 'error', message: e?.message || String(e) }
    }
  }
  // The ack names the exact reviewed range by SHA (and the repo root), so it can neither
  // miss the change that was blocked nor cover a different one.
  const c = outcome.change
  const ackCommand = `node ${shq(REVIEW_BIN)} --ack` + (c ? ` --cwd ${shq(c.root)} --base ${c.mergeBase} --head ${c.headSha}` : '')
  const out = hookOutput(cfg, outcome, { ackCommand })
  return out ? JSON.stringify(out) : null
}

// Compared via realpath: Node resolves the entry module's symlinks for import.meta.url but
// not for argv[1], so a symlinked install path would otherwise make the hook a silent no-op.
const isEntry = () => { try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href } catch { return false } }
if (isEntry()) {
  // A closed stdout (EPIPE) is still exit 0. The deny payload can run past the 64 KiB pipe
  // buffer, and stdout to a pipe is asynchronous on macOS, so exit only once it has drained;
  // exiting straight after write() would truncate the JSON and silently drop the deny.
  process.stdout.on('error', () => process.exit(0))
  let raw = ''
  try { raw = readStdin() } catch { process.exit(0) }
  main(raw).then(
    (s) => { if (s) process.stdout.write(s + '\n', () => process.exit(0)); else process.exit(0) },
    () => process.exit(0),
  )
}
