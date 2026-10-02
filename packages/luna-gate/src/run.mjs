// The shared pipeline behind the hook and the CLI:
//   remote skip -> collect change -> repo opt-out -> user ack -> cache -> model call
// (codex exec by default, or the Responses API with LUNA_GATE_BACKEND=api).
// Returns an outcome object; never throws for an expected condition.
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { collectChange, optedOut, sha256, repoRoot, originUrl } from './git.mjs'
import { buildRequest, newNonce } from './prompt.mjs'
import { callResponses, estimateCost, validateReview } from './openai.mjs'
import { callCodex } from './codex.mjs'
import { blockingFindings } from './decide.mjs'

const cachePath = (cfg, key) => join(cfg.dir, 'cache', `${key}.json`)
const ackPath = (cfg, key) => join(cfg.dir, 'acks', key)

async function writeQuiet(path, data) {
  try {
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, data)
  } catch { /* the cache and acks are conveniences; never fail a review over them */ }
}

// `remotes`: one URL or several (origin, plus the remote a pre-push hook is pushing to).
export function remoteSkipped(cfg, remotes) {
  if (!cfg.skipRemote) return { skip: false }
  let re
  // An unparseable pattern skips the review: the pattern exists to keep code from being
  // sent, so a typo in it must err toward not sending.
  try { re = new RegExp(cfg.skipRemote, 'i') } catch { return { skip: true, note: 'LUNA_GATE_SKIP_REMOTE is not a valid regex; not sending this change.' } }
  return [remotes].flat().some((r) => r && re.test(r)) ? { skip: true, note: null } : { skip: false }
}

export async function prepare({ cwd, base, head, repo = null, ghHost = null, from = null, remoteUrl = null, checkTarget = true, cfg }) {
  // Skip-listed repos are checked first, so they are left alone silently rather than
  // rejected or errored on.
  const root = repoRoot(cwd)
  const rs = remoteSkipped(cfg, [root ? originUrl(root) : '', remoteUrl])
  if (rs.skip) return { outcome: { kind: 'skip', note: rs.note } }
  const change = collectChange(cwd, { base, head, repo, ghHost, from, checkTarget, maxBytes: cfg.maxBytes })
  if (change.reject) return { outcome: { kind: 'reject', message: change.reject } }
  if (change.error) return { outcome: { kind: 'error', message: change.error } }
  if (change.empty) {
    return { outcome: { kind: 'skip', note: change.omitted.length ? `only withheld files changed (${change.omitted.length}); nothing sent.` : null } }
  }
  // Opt-out is honoured from EITHER side. Read from the base it is the repo's standing
  // choice; present only at head, it is this change adding it — still honoured (the point
  // is to keep code from leaving), but said out loud so a diff cannot silently skip review.
  if (optedOut(change.root, change.baseRef)) return { outcome: { kind: 'skip', note: null } }
  if (optedOut(change.root, change.headSha)) {
    return { outcome: { kind: 'skip', note: 'this change ADDS a .luna-gate.json opt-out, so it was not sent for review. Check that this was intended.' } }
  }
  return { change }
}

export async function writeAck(cfg, change) {
  await mkdir(join(cfg.dir, 'acks'), { recursive: true })
  await writeFile(ackPath(cfg, change.ackKey), `${change.mergeBase}..${change.headSha}\n${new Date().toISOString()}\n`)
}

export async function review({ cwd, base = null, head = null, repo = null, ghHost = null, from = null, remoteUrl = null, cfg, fetchImpl, useCache = true }) {
  const prep = await prepare({ cwd, base, head, repo, ghHost, from, remoteUrl, cfg })
  if (prep.outcome) return prep.outcome
  const { change } = prep

  try { await readFile(ackPath(cfg, change.ackKey)); return { kind: 'acked', change } } catch { /* not acked */ }

  const { body, prompt } = buildRequest(change, cfg)
  const cacheKey = sha256(JSON.stringify({ m: cfg.model, e: cfg.effort, b: change.bundleHash }))
  let result = null
  let cached = false
  if (useCache) {
    try {
      const c = JSON.parse(await readFile(cachePath(cfg, cacheKey), 'utf8'))
      result = { review: validateReview(c.review), usage: null }
      cached = true
    } catch { /* miss */ }
  }
  if (!result) {
    try {
      result = cfg.backend === 'api' ? await callResponses(body, cfg, fetchImpl) : await callCodex(prompt, cfg)
    } catch (e) { return { kind: 'error', message: e.message, change } }
    if (useCache) await writeQuiet(cachePath(cfg, cacheKey), JSON.stringify({ at: new Date().toISOString(), review: result.review }))
  }
  return {
    kind: 'reviewed',
    change,
    // A FRESH nonce for fencing the findings. The request's nonce was shown to the
    // reviewer, so a diff could steer it into writing that END marker and break out.
    nonce: newNonce(),
    cached,
    review: result.review,
    blocking: blockingFindings(result.review.findings, cfg),
    cost: cached ? null : estimateCost(result.usage, cfg.model),
  }
}
