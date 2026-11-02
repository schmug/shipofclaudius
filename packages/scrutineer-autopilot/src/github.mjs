// GitHub reads for the autopilot, through an injected `exec(cmd, args) -> stdout`.
// Only `gh api` / `gh pr` reads. A non-404 failure always propagates: swallowing an auth
// failure as "no gate" would mis-route a merge decision.

const OWN_PR_PREFIX = 'scrutineer/finding-'

const gh = async (exec, args) => exec('gh', args)
const ghJson = async (exec, args) => JSON.parse(await gh(exec, args))

const errText = (e) => `${e?.stderr ?? ''}\n${e?.stdout ?? ''}\n${e?.message ?? ''}`
// gh prints "gh: Not Found (HTTP 404)" on stderr and exits non-zero.
const isNotFound = (e) => /HTTP 404|Not Found/i.test(errText(e))

const ms = (iso) => (iso ? Date.parse(iso) : -Infinity)

// An autopilot fix PR is a scrutineer/finding-* branch in the repo itself. Anyone can open a fork PR with that
// branch name on a public repo, so the name alone is never trusted: a fork PR must neither suppress a rescan
// nor stand in for the autopilot's PR (merged -> fixed/published, closed -> park).
const ownerOf = (key) => String(key).split('/')[0].toLowerCase()
const isOwnFixPr = (key, p) => String(p.head?.ref ?? '').startsWith(OWN_PR_PREFIX)
  && String(p.head?.repo?.full_name ?? '').toLowerCase() === String(key).toLowerCase()

export async function pollRepo(key, since = {}, { exec }) {
  const repo = await ghJson(exec, ['api', `repos/${key}`])
  const defaultBranch = repo.default_branch
  const visibility = repo.visibility === 'public' ? 'public' : 'private' // internal -> private
  const headSha = (await gh(exec, ['api', `repos/${key}/commits/${defaultBranch}`, '--jq', '.sha'])).trim()

  const pulls = await ghJson(exec, ['api', `repos/${key}/pulls?state=closed&sort=updated&direction=desc&per_page=20`])
  const mergedPrs = pulls
    .filter((p) => p.merged_at && !isOwnFixPr(key, p))
    .filter((p) => ms(p.merged_at) > ms(since.prMergedAt))
    .map((p) => ({ number: p.number, mergedAt: p.merged_at, headRef: p.head?.ref ?? '' }))

  const rels = await ghJson(exec, ['api', `repos/${key}/releases?per_page=5`])
  const releases = rels
    .filter((r) => !r.draft && r.published_at && ms(r.published_at) > ms(since.releaseAt))
    .map((r) => ({ tag: r.tag_name, publishedAt: r.published_at }))

  return { defaultBranch, visibility, headSha, pushed: headSha !== since.sha, mergedPrs, releases }
}

export async function requiredChecks(key, branch, { exec }) {
  const names = new Set()
  try {
    const rules = await ghJson(exec, ['api', `repos/${key}/rules/branches/${branch}`])
    for (const r of rules) {
      if (r.type !== 'required_status_checks') continue
      for (const c of r.parameters?.required_status_checks ?? []) if (c.context) names.add(c.context)
    }
  } catch (e) {
    if (!isNotFound(e)) throw e
  }
  try {
    const p = await ghJson(exec, ['api', `repos/${key}/branches/${branch}/protection/required_status_checks`])
    for (const c of p.contexts ?? []) names.add(c)
    for (const c of p.checks ?? []) if (c.context) names.add(c.context)
  } catch (e) {
    if (!isNotFound(e)) throw e
  }
  return [...names]
}

export async function prState(key, pr, { exec }) {
  const v = await ghJson(exec, ['pr', 'view', String(pr), '-R', key, '--json', 'state,mergeCommit'])
  return { state: v.state, mergeSha: v.mergeCommit?.oid ?? null }
}

// Server-side filter: head=<owner>:<branch> returns only PRs whose head is in the base repo's owner namespace, so
// fork PRs with the same branch name cannot crowd the real one out of the page. head.repo.full_name === key is a
// second guard. Every value is its own argv element (gh encodes -f into the GET query string).
export async function prForBranch(key, branch, { exec }) {
  const list = await ghJson(exec, ['api', '--method', 'GET', `repos/${key}/pulls`, '-f', `head=${ownerOf(key)}:${branch}`, '-f', 'state=all', '-f', 'per_page=5'])
  const p = (Array.isArray(list) ? list : []).find((x) => x?.head?.ref === branch
    && String(x.head?.repo?.full_name ?? '').toLowerCase() === String(key).toLowerCase())
  if (!p) return null
  const merged = p.merged_at != null
  return { number: p.number, state: merged ? 'MERGED' : p.state === 'open' ? 'OPEN' : 'CLOSED', mergeSha: merged ? p.merge_commit_sha ?? null : null }
}
