// Tests for the scrutineer-autopilot tick orchestrator, dry-run guards and finding relay.
// Scrutineer is the node:http stub; gh, codexbar and `scrutineer --version` are a stubbed exec.
// Run:  node tests/scrutineer-autopilot-tick.test.mjs
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, readdir, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { startStub } from './lib/stub-scrutineer.mjs'
import { createClient } from '../packages/scrutineer-autopilot/src/client.mjs'
import { normalizeConfig } from '../packages/scrutineer-autopilot/src/config.mjs'
import { runTick, dryRunClient, dryRunFetch, RELAY_FIELDS } from '../packages/scrutineer-autopilot/src/tick.mjs'

const tests = []
const test = (name, fn) => tests.push([name, fn])
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const NOW = Date.parse('2026-11-01T12:00:00Z')
const iso = (ms) => new Date(ms).toISOString()
const TOKEN = 'tok-SECRET-do-not-print-4242'
const HEAD = 'abc123'

const finding = (id, o = {}) => ({
  id, repository_id: 1, title: `finding ${id}`, severity: 'Medium', status: 'new', location: 'src/a.js:1', cwe: 'CWE-79',
  last_revalidate_verdict: '', production_viability: '', suggested_fix: '', suggested_fix_commit: '',
  breaking_change: '', breaking_change_rationale: '', updated_at: '2026-10-20T00:00:00Z', ...o,
})
let scanSeq = 100
const scan = (o) => ({ id: scanSeq++, repository_id: 1, finding_id: null, status: 'done', cost_usd: 0.5,
  created_at: '2026-10-01T00:00:00Z', finished_at: '2026-10-01T01:00:00Z', ...o })
// A done deep-dive at HEAD finished recently: the repo is seeded as scanned, so no rescan fires.
const deepDive = () => scan({ skill_name: 'security-deep-dive', commit: HEAD, created_at: iso(NOW - 2 * 86400e3), finished_at: iso(NOW - 2 * 86400e3 + 3600e3) })
const verifiedSecure = (fid) => [
  scan({ finding_id: fid, skill_name: 'patch', created_at: '2026-10-10T00:00:00Z', finished_at: '2026-10-10T01:00:00Z' }),
  scan({ finding_id: fid, skill_name: 'reattack', created_at: '2026-10-11T00:00:00Z', finished_at: '2026-10-11T01:00:00Z',
    report: JSON.stringify({ outcome: 'failed_to_bypass', benign_control: { reached_sink: true, crashed: false },
      variants: [1, 2, 3].map((n) => ({ valid: true, origin: 'generated', outcome: 'blocked', input: `v${n}` })) }) }),
]

let clock = NOW // the current tick's now; codexbar output is fresh relative to it
const codexbar = (provider, { updatedAt = iso(clock - 60e3), weekly = 10, primary = null } = {}) => JSON.stringify([
  { provider, usage: { updatedAt, secondary: { usedPercent: weekly }, primary: primary === null ? null : { usedPercent: primary } } },
])

// exec stub: routes match a substring of the joined command line; first match wins, `extra` before defaults.
function stubExec(extra = {}) {
  const calls = []
  const defaults = {
    'codexbar usage --provider codex': () => codexbar('codex'),
    'codexbar usage --provider claude': () => codexbar('claude', { primary: 5 }),
    'scrutineer --version': 'scrutineer 2026.10.24.1\n',
    'rules/branches': JSON.stringify([{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'ci' }] } }]),
    'protection/required_status_checks': Object.assign(new Error('Command failed'), { stderr: 'gh: Not Found (HTTP 404)' }),
    'api repos/o/app/commits/main': `${HEAD}\n`,
    'api repos/o/app/pulls': '[]',
    'api repos/o/app/releases': '[]',
    'api repos/o/app': JSON.stringify({ default_branch: 'main', visibility: 'public' }),
  }
  const routes = [...Object.entries(extra), ...Object.entries(defaults)]
  const exec = async (cmd, args) => {
    const line = [cmd, ...args].join(' ')
    calls.push(line)
    for (const [frag, route] of routes) {
      if (!line.includes(frag)) continue
      const v = typeof route === 'function' ? route(line) : route
      if (v instanceof Error) throw v
      return v
    }
    throw new Error(`unrouted exec: ${line}`)
  }
  return { exec, calls }
}

const jsonl = (rows) => ({ status: 200, body: rows.map((r) => JSON.stringify(r)).join('\n') })

// world: { findings: [], scans: [], repos?: [], detail?: (id, f) => f }. The stub ignores list filters on
// purpose, so the tick must filter by repository_id itself.
async function world(w) {
  const repos = w.repos ?? [{ id: 1, url: 'https://github.com/o/app', full_name: 'o/app' }, { id: 2, url: 'https://github.com/x/other', full_name: 'x/other' }]
  const byId = () => new Map(w.findings.map((f) => [String(f.id), f]))
  const bump = (id) => { const f = byId().get(id); if (f) f.updated_at = iso(NOW + 1000) } // Scrutineer's clock runs 1s ahead
  const stub = await startStub({
    ...(w.routes ?? {}), // test overrides match first
    'GET /api/v1/findings/{id}': (req) => {
      const f = byId().get(req.params.id)
      if (!f) return { status: 404 }
      return { json: w.detail ? w.detail(req.params.id, { ...f }) : f }
    },
    'GET /api/v1/findings': (req) => jsonl(new URLSearchParams(req.query).get('limit') === '1' ? w.findings.slice(0, 1) : w.findings),
    'GET /api/v1/scans': () => jsonl(w.scans),
    'GET /api/v1/repositories': () => jsonl(repos),
    'POST /findings/{id}/status': (req) => { const f = byId().get(req.params.id); f.status = req.body.status; bump(req.params.id); return { status: 303, headers: { Location: `/findings/${req.params.id}` } } },
    'POST /findings/{id}/notes': (req) => { bump(req.params.id); return { status: 303, headers: { Location: `/findings/${req.params.id}` } } },
    'POST /findings/{id}/{skill}': () => ({ status: 303, headers: { Location: `/scans/${scanSeq++}` } }),
    'POST /repositories/{id}/scan': (req) => ({ status: 303, headers: { Location: `/repositories/${req.params.id}` } }),
    ...(w.routes ?? {}), // a same-keyed override replaces the default handler (key order, and so match order, is unchanged)
  })
  const stateDir = await mkdtemp(join(tmpdir(), 'sa-tick-'))
  const tokenPath = join(stateDir, 'token')
  await writeFile(tokenPath, `${TOKEN}\n`)
  const config = normalizeConfig({ owner: 'o', baseUrl: stub.url, tokenPath, allowlist: ['o/app'], stateDir })
  const client = createClient({ baseUrl: stub.url, tokenPath })
  const posts = () => stub.requests.filter((r) => r.method === 'POST')
  return { stub, stateDir, config, client, posts }
}

const tick = (W, o = {}) => (clock = o.now ?? NOW, runTick({ config: W.config, client: W.client, exec: (o.exec ?? stubExec()).exec, now: o.now ?? NOW, dryRun: o.dryRun ?? false, only: o.only ?? null }))
const ledgerOf = async (W) => JSON.parse(await readFile(join(W.stateDir, 'ledger.json'), 'utf8'))
const exists = (p) => access(p).then(() => true, () => false)

test('Review Focus 1: stub not listening -> scrutineer-down, ledger file unchanged, lock released', async () => {
  const W = await world({ findings: [finding(1)], scans: [deepDive()] })
  await W.stub.close()
  const before = JSON.stringify({ findings: { 9: { stage: 'parked', parkedAt: '2026-10-01T00:00:00Z' } }, repos: {}, budgetSamples: [] })
  await writeFile(join(W.stateDir, 'ledger.json'), before)
  const r = await tick(W)
  assert.equal(r.status, 'scrutineer-down')
  assert.equal(await readFile(join(W.stateDir, 'ledger.json'), 'utf8'), before)
  assert.equal(await exists(join(W.stateDir, 'tick.lock')), false)
})

test('Review Focus 2: updated_at changes between list and pre-POST read -> no POST, skipped: changed', async () => {
  const W = await world({ findings: [finding(1)], scans: [deepDive()], detail: (id, f) => ({ ...f, updated_at: '2026-10-31T00:00:00Z' }) })
  const r = await tick(W)
  await W.stub.close()
  assert.equal(W.posts().length, 0)
  const a = r.actions.find((x) => x.findingId === 1)
  assert.equal(a.type, 'verify')
  assert.equal(a.result, 'skipped')
  assert.equal(a.reason, 'changed')
})

test('non-allowlisted repo: never POSTed, even with a forged triaged ledger entry or a re-read that moves repos', async () => {
  const W = await world({
    findings: [finding(5, { repository_id: 2, status: 'triaged', production_viability: 'VIABLE' }), finding(6)],
    scans: [deepDive(), ...verifiedSecure(5)],
    detail: (id, f) => (id === '6' ? { ...f, repository_id: 2 } : f),
  })
  await writeFile(join(W.stateDir, 'ledger.json'), JSON.stringify({ findings: { 5: { stage: 'triaged', repo: 'o/app' } }, repos: {}, budgetSamples: [] }))
  const r = await tick(W)
  await W.stub.close()
  assert.equal(W.posts().length, 0)
  assert.equal(r.actions.some((a) => a.findingId === 5), false)
  assert.equal(r.agentItems.length, 0)
  assert.equal(r.actions.find((a) => a.findingId === 6).reason, 'repository not allowlisted')
})

test('dryRun: zero POSTs recorded by the stub; actions labelled would', async () => {
  const W = await world({ findings: [finding(1), finding(2, { severity: 'High', last_revalidate_verdict: 'true_positive' })],
    scans: [scan({ skill_name: 'verify', finding_id: 2, report: '{"status":"confirmed"}' })] }) // no deep-dive: full scan due
  const r = await tick(W, { dryRun: true })
  await W.stub.close()
  assert.equal(r.status, 'ok')
  assert.equal(W.posts().length, 0)
  const acted = r.actions.filter((a) => !['skipped', 'waiting', 'not-due'].includes(a.result))
  assert.ok(acted.length >= 3, JSON.stringify(r.actions))
  for (const a of acted) assert.equal(a.result, 'would', JSON.stringify(a))
  assert.equal(await exists(join(W.stateDir, 'ledger.json')), false)
})

test('dry-run guards: dryRunClient and dryRunFetch throw on any POST', async () => {
  const W = await world({ findings: [finding(1)], scans: [] })
  const guarded = dryRunClient(W.client)
  for (const call of [() => guarded.runFindingSkill(1, 'verify'), () => guarded.setStatus(1, 'triaged'), () => guarded.addNote(1, 'x'), () => guarded.scanRepo(1, { mode: 'diff' })]) {
    await assert.rejects(call, /dry-run/)
  }
  const viaFetch = createClient({ baseUrl: W.stub.url, tokenPath: W.config.tokenPath, fetch: dryRunFetch() })
  await assert.rejects(() => viaFetch.addNote(1, 'x'), /dry-run/)
  assert.equal((await viaFetch.listFindings()).length, 1)
  await W.stub.close()
  assert.equal(W.posts().length, 0)
})

test('stale codexbar -> budget-unavailable and zero POSTs', async () => {
  const W = await world({ findings: [finding(1)], scans: [] })
  const r = await tick(W, { exec: stubExec({ 'codexbar usage --provider codex': codexbar('codex', { updatedAt: iso(NOW - 31 * 60e3) }) }) })
  await W.stub.close()
  assert.equal(r.status, 'budget-unavailable')
  assert.equal(W.posts().length, 0)
})

test('the 11th eligible verify in one tick is not enqueued', async () => {
  const W = await world({ findings: Array.from({ length: 11 }, (_, i) => finding(i + 1)), scans: [deepDive()] })
  const r = await tick(W)
  await W.stub.close()
  assert.equal(W.posts().filter((p) => p.path.endsWith('/verify')).length, 10)
  const capped = r.actions.filter((a) => a.type === 'verify' && a.reason === 'enqueue cap')
  assert.equal(capped.length, 1)
})

test('verified_secure with no open fix PR -> one fix AgentItem per repo; primaryMissing surfaced in notes', async () => {
  const W = await world({
    findings: [finding(7, { status: 'triaged', severity: 'High', production_viability: 'VIABLE' }), finding(8, { status: 'triaged', production_viability: 'VIABLE' })],
    scans: [deepDive(), ...verifiedSecure(7), ...verifiedSecure(8)],
  })
  const r = await tick(W)
  await W.stub.close()
  assert.deepEqual(r.agentItems, [{ kind: 'fix', findingId: 7, repo: 'o/app', policy: 'auto', visibility: 'public', hasGate: true, estimateUsd: 3, stateDir: W.stateDir }])
  assert.equal(W.posts().length, 0)
  assert.ok(r.notes.some((n) => n.startsWith('codex:') && /5-hour/.test(n)), r.notes.join('\n'))
})

test('requiredChecks failure -> hasGate:false plus a notes line, tick does not crash', async () => {
  const W = await world({ findings: [finding(7, { status: 'triaged', production_viability: 'VIABLE' })], scans: [deepDive(), ...verifiedSecure(7)] })
  const r = await tick(W, { exec: stubExec({ 'rules/branches': Object.assign(new Error('Command failed'), { stderr: 'HTTP 403' }) }) })
  await W.stub.close()
  assert.equal(r.status, 'ok')
  assert.equal(r.agentItems[0].hasGate, false)
  assert.ok(r.notes.some((n) => n.includes('o/app') && /required checks/.test(n)))
})

test('the token appears nowhere in the result or the run file', async () => {
  const W = await world({ findings: [finding(1), finding(2, { severity: 'High' })], scans: [scan({ skill_name: 'verify', finding_id: 2, report: '{"status":"confirmed"}' })] })
  const r = await tick(W)
  await W.stub.close()
  assert.ok(W.posts().length > 0)
  assert.equal(JSON.stringify(r).includes(TOKEN), false)
  const runs = await readdir(join(W.stateDir, 'runs'))
  assert.equal(runs.length, 1)
  assert.equal((await readFile(join(W.stateDir, 'runs', runs[0]), 'utf8')).includes(TOKEN), false)
  assert.equal(JSON.stringify(await ledgerOf(W)).includes(TOKEN), false)
})

test('park posts the note first; parkedAt covers the note bump, so the next tick skips with no second note', async () => {
  const W = await world({ findings: [finding(3, { severity: 'High' })], scans: [deepDive(), scan({ skill_name: 'verify', finding_id: 3, report: '{"status":"confirmed"}' })] })
  const r1 = await tick(W)
  const notes1 = W.posts().filter((p) => p.path === '/findings/3/notes')
  assert.equal(notes1.length, 1)
  assert.match(notes1[0].body.body, /^autopilot: no revalidate verdict/)
  assert.equal(r1.parked.length, 1)
  const e = (await ledgerOf(W)).findings['3']
  assert.equal(e.stage, 'parked')
  assert.ok(Date.parse(e.parkedAt) >= NOW + 1000, e.parkedAt)
  const r2 = await tick(W, { now: NOW + 3600e3 })
  await W.stub.close()
  assert.equal(W.posts().filter((p) => p.path === '/findings/3/notes').length, 1)
  assert.equal(r2.actions.find((a) => a.findingId === 3).type, 'skip')
})

test('an enqueued scan not yet in the export counts as open: next tick waits, no second POST', async () => {
  const W = await world({ findings: [finding(4)], scans: [deepDive()] })
  await tick(W)
  const r2 = await tick(W, { now: NOW + 3600e3 })
  await W.stub.close()
  assert.equal(W.posts().filter((p) => p.path === '/findings/4/verify').length, 1)
  assert.equal(r2.actions.find((a) => a.findingId === 4).type, 'wait')
})

test('own fix PR merged -> status fixed + note, stage marked_fixed, repo lastScannedSha = merge sha; awaiting_ci open -> regate item', async () => {
  const W = await world({
    findings: [finding(10, { status: 'triaged', production_viability: 'VIABLE' }), finding(11, { status: 'triaged', production_viability: 'VIABLE' })],
    scans: [deepDive(), ...verifiedSecure(10), ...verifiedSecure(11)],
  })
  await writeFile(join(W.stateDir, 'ledger.json'), JSON.stringify({ findings: { 10: { stage: 'awaiting_ci', pr: 5, repo: 'o/app' }, 11: { stage: 'awaiting_ci', pr: 6, repo: 'o/app' } }, repos: {}, budgetSamples: [] }))
  const exec = stubExec({
    'head=o:scrutineer/finding-10': branchPr(10, 5, { state: 'closed', mergedAt: '2026-10-31T00:00:00Z', sha: 'm5' }),
    'head=o:scrutineer/finding-11': branchPr(11, 6),
    'api repos/o/app/commits/main': 'm5\n',
  })
  const r = await tick(W, { exec })
  await W.stub.close()
  const p = W.posts().filter((x) => x.path.startsWith('/findings/10/'))
  assert.deepEqual(p.map((x) => x.path), ['/findings/10/status', '/findings/10/notes'])
  assert.equal(p[0].body.status, 'fixed')
  assert.match(p[1].body.body, /^autopilot: .*pull\/5.*m5/)
  const L = await ledgerOf(W)
  assert.equal(L.findings['10'].stage, 'marked_fixed')
  assert.equal(L.repos['o/app'].lastScannedSha, 'm5')
  assert.equal(W.posts().filter((x) => x.path.startsWith('/repositories/')).length, 0)
  assert.deepEqual(r.agentItems, [{ kind: 'regate', findingId: 11, repo: 'o/app', pr: 6, policy: 'auto', visibility: 'public', hasGate: true, estimateUsd: 3, stateDir: W.stateDir }])
})

test('first sight (Ruling 14): no deep-dive -> full scan; deep-dive at head -> no rescan', async () => {
  const A = await world({ findings: [], scans: [] })
  const ra = await tick(A)
  await A.stub.close()
  const scans = A.posts().filter((x) => x.path === '/repositories/1/scan')
  assert.equal(scans.length, 1)
  assert.equal(scans[0].body.rescan_mode, undefined)
  assert.equal(ra.actions.find((a) => a.type === 'rescan').kind, 'full')
  const B = await world({ findings: [], scans: [deepDive()] })
  await tick(B)
  await B.stub.close()
  assert.equal(B.posts().length, 0)
})

test('paused -> status paused, zero POSTs, no ledger written', async () => {
  const W = await world({ findings: [finding(1)], scans: [] })
  await writeFile(join(W.stateDir, 'paused'), '')
  const r = await tick(W)
  await W.stub.close()
  assert.equal(r.status, 'paused')
  assert.equal(W.posts().length, 0)
  assert.equal(await exists(join(W.stateDir, 'ledger.json')), false)
})

const triagedViable = (id, o = {}) => finding(id, { status: 'triaged', production_viability: 'VIABLE', ...o })
// gh api pulls?head=o:scrutineer/finding-<id> answer: one same-repo PR on the finding's own branch.
const branchPr = (id, number, { state = 'open', mergedAt = null, sha = null } = {}) => JSON.stringify([{ number, state, merged_at: mergedAt, merge_commit_sha: sha, head: { ref: `scrutineer/finding-${id}`, repo: { full_name: 'o/app' } } }])
const L0 = (findings, repos = {}) => JSON.stringify({ findings, repos, budgetSamples: [] })

test('paused: no agentItems at all; fix and regate candidates recorded skipped: paused', async () => {
  const run = async (findings, scans, ledger, extra = {}) => {
    const W = await world({ findings, scans: [deepDive(), ...scans] })
    if (ledger) await writeFile(join(W.stateDir, 'ledger.json'), L0(ledger))
    await writeFile(join(W.stateDir, 'paused'), '')
    const r = await tick(W, { exec: stubExec(extra) })
    await W.stub.close()
    assert.equal(r.status, 'paused')
    assert.equal(r.agentItems.length, 0)
    assert.equal(W.posts().length, 0)
    return r.actions.filter((a) => a.reason === 'paused').map((a) => [a.findingId, a.type])
  }
  assert.deepEqual(await run([triagedViable(7)], verifiedSecure(7)), [[7, 'fix']])
  assert.deepEqual(await run([triagedViable(11)], verifiedSecure(11), { 11: { stage: 'awaiting_ci', pr: 6, repo: 'o/app' } },
    { 'head=o:scrutineer/finding-11': branchPr(11, 6) }), [[11, 'regate']])
})

test('dry run: agent items are kept and marked would:true', async () => {
  const W = await world({ findings: [triagedViable(7)], scans: [deepDive(), ...verifiedSecure(7)] })
  const r = await tick(W, { dryRun: true })
  await W.stub.close()
  assert.equal(r.agentItems.length, 1)
  assert.equal(r.agentItems[0].would, true)
})

test('a failed prepare on a PR-stage entry still marks the repo busy: no second fix item', async () => {
  const W = await world({ findings: [triagedViable(10), triagedViable(11)], scans: [deepDive(), ...verifiedSecure(10), ...verifiedSecure(11)] })
  await writeFile(join(W.stateDir, 'ledger.json'), L0({ 10: { stage: 'awaiting_ci', pr: 5, repo: 'o/app' } }))
  const r = await tick(W, { exec: stubExec({ 'head=o:scrutineer/finding-10': new Error('gh: HTTP 502') }) })
  await W.stub.close()
  assert.equal(r.actions.find((a) => a.findingId === 10).result, 'failed')
  assert.equal(r.agentItems.filter((i) => i.kind === 'fix').length, 0)
  assert.equal(r.actions.find((a) => a.findingId === 11).result, 'waiting')
})

test('stale claude codexbar -> zero fix items, reason claude budget:', async () => {
  const W = await world({ findings: [triagedViable(7)], scans: [deepDive(), ...verifiedSecure(7)] })
  const r = await tick(W, { exec: stubExec({ 'codexbar usage --provider claude': () => codexbar('claude', { updatedAt: iso(NOW - 31 * 60e3) }) }) })
  await W.stub.close()
  assert.equal(r.status, 'ok')
  assert.equal(r.agentItems.length, 0)
  assert.match(r.actions.find((a) => a.findingId === 7).reason, /^claude budget:/)
})

test('carry 4: a new patch resets reattackRetries, then a verification_incomplete retry increments it', async () => {
  const patch = scan({ finding_id: 9, skill_name: 'patch', created_at: '2026-10-10T00:00:00Z', finished_at: '2026-10-10T01:00:00Z' })
  const incomplete = scan({ finding_id: 9, skill_name: 'reattack', created_at: '2026-10-11T00:00:00Z', finished_at: '2026-10-11T01:00:00Z', report: JSON.stringify({ outcome: 'failed_to_bypass', variants: [] }) })
  const W = await world({ findings: [triagedViable(9)], scans: [deepDive(), patch, incomplete] })
  await writeFile(join(W.stateDir, 'ledger.json'), L0({ 9: { stage: 'reattacking', repo: 'o/app', lastPatchScanId: 1, reattackRetries: 1 } }))
  await tick(W)
  await W.stub.close()
  assert.deepEqual(W.posts().map((p) => p.path), ['/findings/9/reattack']) // with retries still 1 it would park
  const e = (await ledgerOf(W)).findings['9']
  assert.equal(e.lastPatchScanId, patch.id)
  assert.equal(e.reattackRetries, 1)
})

test('carry 7: weekly tier does not rescan before 7 days since the last scan', async () => {
  const repoState = (lastScanAt) => ({ 'o/app': { id: 1, lastScannedSha: 'old', lastFullAt: NOW - 10 * 86400e3, lastScanAt, scrutineerVersion: 'scrutineer 2026.10.24.1',
    firstSeenAt: NOW - 30 * 86400e3, seen: { sha: HEAD, prMergedAt: iso(NOW), releaseAt: iso(NOW) }, events: [] } })
  const out = []
  for (const days of [3, 8]) {
    const W = await world({ findings: [], scans: [deepDive()] })
    await writeFile(join(W.stateDir, 'ledger.json'), L0({}, repoState(NOW - days * 86400e3)))
    const r = await tick(W)
    await W.stub.close()
    const a = r.actions.find((x) => x.type === 'rescan')
    out.push([a.tier, a.kind, a.result, W.posts().length])
  }
  assert.deepEqual(out, [['weekly', null, 'not-due', 0], ['weekly', 'diff', 'done', 1]])
})

test('carry 2: a running revalidate scan on the finding -> wait, no POST', async () => {
  const W = await world({ findings: [finding(1)], scans: [deepDive(), scan({ finding_id: 1, skill_name: 'revalidate', status: 'running', finished_at: null })] })
  const r = await tick(W)
  await W.stub.close()
  assert.equal(r.actions.find((a) => a.findingId === 1).type, 'wait')
  assert.equal(W.posts().length, 0)
})

test('carry 3: a skipped entry without a PR number is resolved through prForBranch', async () => {
  const W = await world({ findings: [triagedViable(13)], scans: [deepDive(), ...verifiedSecure(13)] })
  await writeFile(join(W.stateDir, 'ledger.json'), L0({ 13: { stage: 'skipped', repo: 'o/app' } }))
  const ex = stubExec({ 'head=o:scrutineer/finding-13': JSON.stringify([{ number: 31, state: 'closed', merged_at: '2026-10-31T00:00:00Z', merge_commit_sha: 'm31', head: { ref: 'scrutineer/finding-13', repo: { full_name: 'o/app' } } }]) })
  await tick(W, { exec: ex })
  await W.stub.close()
  assert.ok(ex.calls.some((c) => c.includes('repos/o/app/pulls -f head=o:scrutineer/finding-13')), ex.calls.join('\n'))
  assert.equal(W.posts().find((p) => p.path === '/findings/13/status').body.status, 'fixed')
  assert.equal((await ledgerOf(W)).findings['13'].pr, 31)
})

test('Ruling 18: an entry whose ledger pr points at a different PR is resolved by branch, and the ledger pr is corrected', async () => {
  const W = await world({ findings: [triagedViable(14)], scans: [deepDive(), ...verifiedSecure(14)] })
  await writeFile(join(W.stateDir, 'ledger.json'), L0({ 14: { stage: 'awaiting_ci', pr: 99, repo: 'o/app' } }))
  const ex = stubExec({ 'head=o:scrutineer/finding-14': branchPr(14, 41, { state: 'closed', mergedAt: '2026-10-31T00:00:00Z', sha: 'm41' }) })
  await tick(W, { exec: ex })
  await W.stub.close()
  assert.ok(!ex.calls.some((c) => c.includes('pr view')), ex.calls.join('\n'))
  const note = W.posts().find((p) => p.path === '/findings/14/notes')
  assert.match(note.body.body, /pull\/41.*m41/)
  assert.equal((await ledgerOf(W)).findings['14'].pr, 41)
})

const recordCli = (W, ...args) => promisify(execFile)('node', [join(ROOT, 'packages/scrutineer-autopilot/bin/tick.mjs'), '--state-dir', W.stateDir, '--config', join(W.stateDir, 'none.json'), ...args]).then((r) => ({ code: 0, ...r }), (e) => ({ code: e.code, stdout: e.stdout, stderr: e.stderr }))

test('--record 5 {"outcome":"merged"} sets findings[5].stage = merged', async () => {
  const W = await world({ findings: [], scans: [] })
  await W.stub.close()
  const r = await recordCli(W, '--record', '5', '{"outcome":"merged"}')
  assert.equal(r.code, 0, r.stderr)
  assert.equal((await ledgerOf(W)).findings['5'].stage, 'merged')
})

test('--record merged, then the next tick resolves the PR by branch: fixed, lastScannedSha = merge sha, no rescan', async () => {
  const W = await world({ findings: [triagedViable(9)], scans: [deepDive(), ...verifiedSecure(9)] })
  const r0 = await recordCli(W, '--record', '9', '{"outcome":"merged"}')
  assert.equal(r0.code, 0, r0.stderr)
  const ex = stubExec({
    'head=o:scrutineer/finding-9': branchPr(9, 52, { state: 'closed', mergedAt: '2026-11-01T10:00:00Z', sha: 'm52' }),
    'api repos/o/app/commits/main': 'm52\n',
  })
  await tick(W, { exec: ex })
  await W.stub.close()
  assert.equal(W.posts().find((p) => p.path === '/findings/9/status').body.status, 'fixed')
  assert.match(W.posts().find((p) => p.path === '/findings/9/notes').body.body, /pull\/52.*m52/)
  const L = await ledgerOf(W)
  assert.equal(L.findings['9'].stage, 'marked_fixed')
  assert.equal(L.repos['o/app'].lastScannedSha, 'm52')
  assert.equal(W.posts().filter((x) => x.path.startsWith('/repositories/')).length, 0)
})

test('--record stores stop_rule, reason and a computed held_path, and never a PR number or url from the outcome JSON', async () => {
  const W = await world({ findings: [], scans: [] })
  await W.stub.close()
  await writeFile(join(W.stateDir, 'ledger.json'), L0({ 6: { stage: 'patching', repo: 'o/app', pr: 3 } }))
  const out = JSON.stringify({ outcome: 'held', stop_rule: 'breaking_change', reason: 'line one\nline two', held_path: '/etc/passwd', pr: 77, pr_url: 'https://evil.example/pull/77', test_output: 'x' })
  const r = await recordCli(W, '--record', '6', out)
  assert.equal(r.code, 0, r.stderr)
  const e = (await ledgerOf(W)).findings['6']
  assert.equal(e.stage, 'held')
  assert.equal(e.stop_rule, 'breaking_change')
  assert.equal(e.reason, 'line one')
  assert.equal(e.held_path, join(W.stateDir, 'held', '6'))
  assert.equal(e.pr, 3)
  assert.equal(JSON.stringify(e).includes('evil.example'), false)
  assert.equal(JSON.stringify(e).includes('77'), false)
})

const recordStdin = (W, id, text) => new Promise((resolve) => {
  const c = spawn('node', [join(ROOT, 'packages/scrutineer-autopilot/bin/tick.mjs'), '--state-dir', W.stateDir, '--config', join(W.stateDir, 'none.json'), '--record', id])
  let err = ''
  c.stderr.on('data', (d) => { err += d })
  c.on('close', (code) => resolve({ code, stderr: err }))
  c.stdin.end(text)
})

test('--record <id> reads the outcome JSON from stdin; reason is stripped to [A-Za-z0-9 ._:/-]', async () => {
  const W = await world({ findings: [], scans: [] })
  await W.stub.close()
  const r = await recordStdin(W, '8', JSON.stringify({ outcome: 'failed', reason: "it's $(x) `y` ; rm -rf /tmp/z" }))
  assert.equal(r.code, 0, r.stderr)
  const e = (await ledgerOf(W)).findings['8']
  assert.equal(e.stage, 'failed')
  assert.equal(e.reason, 'its x y  rm -rf /tmp/z')
  assert.equal(/['$`;()]/.test(e.reason), false)
  assert.equal((await recordStdin(W, '8', 'not json')).code, 2)
})

test('--record rejects a bad finding id, outcome, stop_rule or JSON with exit 2 and no ledger write', async () => {
  const W = await world({ findings: [], scans: [] })
  await W.stub.close()
  for (const args of [['x1', '{"outcome":"merged"}'], ['5', '{"outcome":"opened"}'], ['5', '{"outcome":"stopped","stop_rule":"nope"}'], ['5', 'not json'], ['5', '[]']]) {
    const r = await recordCli(W, '--record', ...args)
    assert.equal(r.code, 2, `${args.join(' ')} -> ${r.code}`)
  }
  assert.equal(await exists(join(W.stateDir, 'ledger.json')), false)
})

test('--digest-sent writes lastDigestAt and keeps the rest of the ledger', async () => {
  const W = await world({ findings: [], scans: [] })
  await W.stub.close()
  await writeFile(join(W.stateDir, 'ledger.json'), L0({ 6: { stage: 'held' } }))
  const r = await recordCli(W, '--digest-sent')
  assert.equal(r.code, 0, r.stderr)
  const L = await ledgerOf(W)
  assert.match(L.lastDigestAt, /^\d{4}-\d\d-\d\dT/)
  assert.equal(L.findings['6'].stage, 'held')
})

test('carry 8: one finding POST fails, the tick records it and continues to the next finding', async () => {
  const W = await world({ findings: [finding(1), finding(2)], scans: [deepDive()], routes: { 'POST /findings/1/verify': { status: 500 } } })
  const r = await tick(W)
  await W.stub.close()
  assert.equal(r.status, 'ok')
  const a1 = r.actions.find((a) => a.findingId === 1)
  assert.equal(a1.result, 'failed')
  assert.match(a1.error, /500/)
  assert.equal(r.actions.find((a) => a.findingId === 2).result, 'done')
  assert.ok(W.posts().some((p) => p.path === '/findings/2/verify'))
})

test('only: an attended tick touches one finding and enqueues no rescan', async () => {
  const W = await world({ findings: [finding(1), finding(2)], scans: [] })
  const r = await tick(W, { only: 2 })
  await W.stub.close()
  assert.equal(r.status, 'ok')
  assert.ok(!r.actions.some((a) => a.findingId === 1), 'finding 1 is out of scope for this tick')
  assert.equal(r.actions.find((a) => a.findingId === 2).result, 'done')
  assert.deepEqual(W.posts().map((p) => p.path), ['/findings/2/verify'])
  assert.ok(r.notes.some((n) => /--only 2: rescans skipped/.test(n)))
})

test('bin/finding.mjs prints exactly the relay fields and never the token', async () => {
  const W = await world({ findings: [finding(12, { suggested_fix: 'diff --git a b', description: 'secret narrative' })], scans: [] })
  const cfg = join(W.stateDir, 'config.json')
  await writeFile(cfg, JSON.stringify({ owner: 'o', baseUrl: W.stub.url, tokenPath: W.config.tokenPath, allowlist: ['o/app'], stateDir: W.stateDir }))
  const { stdout } = await promisify(execFile)('node', [join(ROOT, 'packages/scrutineer-autopilot/bin/finding.mjs'), '--config', cfg, '--repo', 'o/app', '12'])
  await W.stub.close()
  const out = JSON.parse(stdout)
  assert.deepEqual(Object.keys(out).sort(), [...RELAY_FIELDS].sort())
  assert.equal(out.suggested_fix, 'diff --git a b')
  assert.equal(stdout.includes(TOKEN), false)
  assert.equal(W.posts().length, 0)
})


const findingCli = (args) => promisify(execFile)('node', [join(ROOT, 'packages/scrutineer-autopilot/bin/finding.mjs'), ...args]).then((r) => ({ code: 0, ...r }), (e) => ({ code: e.code, stdout: e.stdout, stderr: e.stderr }))

test('I8: finding.mjs exits 3 for a non-allowlisted repo or a --repo mismatch; --repo is required', async () => {
  const W = await world({ findings: [finding(12), finding(15, { repository_id: 2 })], scans: [] })
  const cfg = join(W.stateDir, 'config.json')
  await writeFile(cfg, JSON.stringify({ owner: 'o', baseUrl: W.stub.url, tokenPath: W.config.tokenPath, allowlist: ['o/app'], stateDir: W.stateDir }))
  const notAllowed = await findingCli(['--config', cfg, '--repo', 'x/other', '15'])
  const mismatch = await findingCli(['--config', cfg, '--repo', 'o/elsewhere', '12'])
  const ok = await findingCli(['--config', cfg, '--repo', 'O/App', '12'])
  const missing = await findingCli(['--config', cfg, '12'])
  await W.stub.close()
  assert.equal(notAllowed.code, 3, notAllowed.stderr)
  assert.equal(notAllowed.stdout, '')
  assert.equal(mismatch.code, 3, mismatch.stderr)
  assert.equal(mismatch.stdout, '')
  assert.equal(ok.code, 0, ok.stderr)
  assert.equal(missing.code, 1)
  assert.match(missing.stderr, /--repo/)
  assert.equal(W.posts().length, 0)
})

test('I1: recorded merged but the PR is still OPEN on GitHub -> no mark_fixed, waiting; after 24h -> parked', async () => {
  const W = await world({ findings: [triagedViable(9)], scans: [deepDive(), ...verifiedSecure(9)] })
  await writeFile(join(W.stateDir, 'ledger.json'), L0({ 9: { stage: 'merged', repo: 'o/app', recordedAt: iso(NOW - 3600e3) } }))
  const ex = stubExec({ 'head=o:scrutineer/finding-9': branchPr(9, 52) })
  const r1 = await tick(W, { exec: ex })
  assert.equal(W.posts().length, 0)
  assert.equal(r1.actions.find((a) => a.findingId === 9).type, 'wait')
  assert.equal(r1.agentItems.length, 0, 'an open PR keeps the repo busy')
  const r2 = await tick(W, { exec: stubExec({ 'head=o:scrutineer/finding-9': '[]' }), now: NOW + 25 * 3600e3 })
  await W.stub.close()
  assert.equal(r2.actions.find((a) => a.findingId === 9).type, 'park')
  assert.equal(W.posts().some((p) => p.path === '/findings/9/status'), false)
  assert.match(W.posts().find((p) => p.path === '/findings/9/notes').body.body, /^autopilot: recorded merge not confirmed on GitHub$/)
})

test('I2: a regate item is gated on the Claude budget (claude budget:), and only an awaiting_ci entry with no stop_rule regates', async () => {
  const fs = [triagedViable(11), triagedViable(12)]
  const ledger = L0({ 11: { stage: 'awaiting_ci', pr: 6, repo: 'o/app' }, 12: { stage: 'awaiting_ci', pr: 7, repo: 'o/app', stop_rule: 'merge_escalated' } })
  const routes = { 'head=o:scrutineer/finding-11': branchPr(11, 6), 'head=o:scrutineer/finding-12': branchPr(12, 7) }
  const W = await world({ findings: fs, scans: [deepDive(), ...verifiedSecure(11), ...verifiedSecure(12)] })
  await writeFile(join(W.stateDir, 'ledger.json'), ledger)
  const ok = await tick(W, { exec: stubExec(routes) })
  assert.deepEqual(ok.agentItems.map((i) => [i.kind, i.findingId]), [['regate', 11]])
  const V = await world({ findings: fs, scans: [deepDive(), ...verifiedSecure(11), ...verifiedSecure(12)] })
  await writeFile(join(V.stateDir, 'ledger.json'), ledger)
  const r = await tick(V, { exec: stubExec({ ...routes, 'codexbar usage --provider claude': () => codexbar('claude', { weekly: 99, primary: 5 }) }) })
  await W.stub.close(); await V.stub.close()
  assert.equal(r.agentItems.length, 0)
  const a = r.actions.find((x) => x.type === 'regate' && x.findingId === 11)
  assert.equal(a.result, 'skipped')
  assert.match(a.reason, /^claude budget:/)
})

test('I2: --record rejects awaiting_ci or merged with a non-null stop_rule (exit 2, no write)', async () => {
  const W = await world({ findings: [], scans: [] })
  await W.stub.close()
  for (const outcome of ['awaiting_ci', 'merged']) {
    const r = await recordCli(W, '--record', '5', JSON.stringify({ outcome, stop_rule: 'merge_escalated' }))
    assert.equal(r.code, 2, `${outcome}: ${r.stderr}`)
  }
  assert.equal(await exists(join(W.stateDir, 'ledger.json')), false)
  const ok = await recordCli(W, '--record', '5', JSON.stringify({ outcome: 'awaiting_ci', stop_rule: null }))
  assert.equal(ok.code, 0, ok.stderr)
})

test('I4: stage failed with an OPEN PR keeps the repo busy and the finding waiting; with a MERGED PR -> marked_fixed', async () => {
  const W = await world({ findings: [triagedViable(20), triagedViable(21)], scans: [deepDive(), ...verifiedSecure(20), ...verifiedSecure(21)] })
  await writeFile(join(W.stateDir, 'ledger.json'), L0({ 20: { stage: 'failed', repo: 'o/app' } }))
  const r = await tick(W, { exec: stubExec({ 'head=o:scrutineer/finding-20': branchPr(20, 60), 'head=o:scrutineer/finding-21': '[]' }) })
  assert.equal(r.actions.find((a) => a.findingId === 20).type, 'wait')
  assert.equal(r.parked.length, 0)
  assert.equal(r.agentItems.length, 0)
  assert.equal(r.actions.find((a) => a.findingId === 21).result, 'waiting')
  const M = await world({ findings: [triagedViable(20)], scans: [deepDive(), ...verifiedSecure(20)] })
  await writeFile(join(M.stateDir, 'ledger.json'), L0({ 20: { stage: 'failed', repo: 'o/app' } }))
  await tick(M, { exec: stubExec({ 'head=o:scrutineer/finding-20': branchPr(20, 60, { state: 'closed', mergedAt: '2026-10-31T00:00:00Z', sha: 'm60' }) }) })
  await W.stub.close(); await M.stub.close()
  assert.equal(M.posts().find((p) => p.path === '/findings/20/status').body.status, 'fixed')
  assert.equal((await ledgerOf(M)).findings['20'].stage, 'marked_fixed')
})

test('I6: emitting a fix item writes stage fixing + emittedAt; the next tick waits with the repo busy; after 6h it parks', async () => {
  const W = await world({ findings: [triagedViable(7), triagedViable(8)], scans: [deepDive(), ...verifiedSecure(7), ...verifiedSecure(8)] })
  const ex = () => stubExec({ 'head=o:scrutineer/finding-7': '[]' })
  const r1 = await tick(W, { exec: ex() })
  assert.deepEqual(r1.agentItems.map((i) => i.findingId), [7])
  const e = (await ledgerOf(W)).findings['7']
  assert.equal(e.stage, 'fixing')
  assert.equal(e.emittedAt, iso(NOW))
  const r2 = await tick(W, { exec: ex(), now: NOW + 3600e3 })
  assert.equal(r2.actions.find((a) => a.findingId === 7).type, 'wait')
  assert.equal(r2.agentItems.length, 0, 'fixing keeps the repo busy: no fix item for 8')
  const r3 = await tick(W, { exec: ex(), now: NOW + 7 * 3600e3 })
  await W.stub.close()
  assert.equal(r3.actions.find((a) => a.findingId === 7).type, 'park')
  assert.match(W.posts().find((p) => p.path === '/findings/7/notes').body.body, /^autopilot: fix workflow never recorded an outcome$/)
  const D = await world({ findings: [triagedViable(7)], scans: [deepDive(), ...verifiedSecure(7)] })
  await tick(D, { dryRun: true })
  await D.stub.close()
  assert.equal(await exists(join(D.stateDir, 'ledger.json')), false, 'dry run writes no fixing stage')
})

test('I6 follow-up: a stale fixing entry with an OPEN PR is not parked, becomes stopped, and the repo stays busy', async () => {
  const W = await world({ findings: [triagedViable(7), triagedViable(8)], scans: [deepDive(), ...verifiedSecure(7), ...verifiedSecure(8)] })
  await writeFile(join(W.stateDir, 'ledger.json'), L0({ 7: { stage: 'fixing', emittedAt: iso(NOW - 7 * 3600e3), repo: 'o/app' } }))
  const r = await tick(W, { exec: stubExec({ 'head=o:scrutineer/finding-7': branchPr(7, 70), 'head=o:scrutineer/finding-8': '[]' }) })
  await W.stub.close()
  assert.equal(r.actions.find((a) => a.findingId === 7).type, 'wait')
  assert.equal(r.parked.length, 0)
  assert.equal(W.posts().length, 0, 'no park note')
  assert.equal(r.agentItems.length, 0, 'no fix item for finding 8')
  assert.equal(r.actions.find((a) => a.findingId === 8).result, 'waiting')
  const e = (await ledgerOf(W)).findings['7']
  assert.equal(e.stage, 'stopped')
  assert.equal(e.pr, 70)
})

test('B: a fixing entry whose branch shows an older merged PR is not marked fixed; a newer merged PR is', async () => {
  const pr = (created) => JSON.stringify([{ number: 3, state: 'closed', merged_at: created, created_at: created, merge_commit_sha: 'm3', head: { ref: 'scrutineer/finding-7', repo: { full_name: 'o/app' } } }])
  const W = await world({ findings: [triagedViable(7), triagedViable(8)], scans: [deepDive(), ...verifiedSecure(7), ...verifiedSecure(8)] })
  await writeFile(join(W.stateDir, 'ledger.json'), L0({ 7: { stage: 'fixing', emittedAt: iso(NOW - 3600e3), repo: 'o/app' } }))
  const r = await tick(W, { exec: stubExec({ 'head=o:scrutineer/finding-7': pr('2026-09-01T00:00:00Z'), 'head=o:scrutineer/finding-8': '[]' }) })
  assert.equal(W.posts().length, 0)
  assert.equal(r.actions.find((a) => a.findingId === 7).type, 'wait')
  assert.equal(r.agentItems.length, 0, 'fixing keeps the repo busy despite the old merged PR')
  const r2 = await tick(W, { exec: stubExec({ 'head=o:scrutineer/finding-7': pr(iso(NOW - 1800e3)), 'head=o:scrutineer/finding-8': '[]' }) })
  await W.stub.close()
  assert.equal(r2.actions.find((a) => a.findingId === 7).type, 'mark_fixed')
  assert.equal(W.posts().find((p) => p.path === '/findings/7/status').body.status, 'fixed')
})

test('#326: a 200 text/html answer at baseUrl -> scrutineer-down with a content-type note, body never quoted', async () => {
  const BODY = '<!doctype html><title>SECRET-BODY-MARKER</title>'
  const W = await world({ findings: [], scans: [], routes: { 'GET /api/v1/findings': () => ({ status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: BODY }) } })
  const r = await tick(W)
  await W.stub.close()
  assert.equal(r.status, 'scrutineer-down')
  assert.equal(r.notes.at(-1), `baseUrl ${W.config.baseUrl} answered text/html; not a Scrutineer API`)
  assert.ok(!JSON.stringify(r).includes('SECRET-BODY-MARKER'))
  assert.equal(await exists(join(W.stateDir, 'runs')), false, 'an abort still writes no run file')
})

test('#326: a non-JSON non-HTML body gets the same note shape without the body', async () => {
  const W = await world({ findings: [], scans: [], routes: { 'GET /api/v1/findings': () => ({ status: 200, headers: { 'Content-Type': 'text/plain' }, body: 'SECRET-BODY-MARKER' }) } })
  const r = await tick(W)
  await W.stub.close()
  assert.equal(r.status, 'scrutineer-down')
  assert.equal(r.notes.at(-1), `baseUrl ${W.config.baseUrl} answered text/plain; not a Scrutineer API`)
})

test('#326: connection refused keeps its own note', async () => {
  const W = await world({ findings: [], scans: [] })
  await W.stub.close()
  const r = await tick(W)
  assert.equal(r.status, 'scrutineer-down')
  assert.ok(!r.notes.at(-1).includes('not a Scrutineer API'))
})

test('#326: two identical aborts leave one marker with count 2; a different note restarts; success clears', async () => {
  const html = { 'GET /api/v1/findings': () => ({ status: 200, headers: { 'Content-Type': 'text/html' }, body: '<html>' }) }
  const W = await world({ findings: [], scans: [], routes: html })
  const r1 = await tick(W, { now: NOW })
  const r2 = await tick(W, { now: NOW + 3600e3 })
  const file = join(W.stateDir, 'last-abort.json')
  assert.equal(r1.abort.count, 1)
  assert.equal(r2.abort.count, 2)
  const m = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(m.count, 2)
  assert.equal(m.status, 'scrutineer-down')
  assert.equal(m.firstSeen, iso(NOW))
  assert.equal(m.lastSeen, iso(NOW + 3600e3))
  assert.equal((await readdir(W.stateDir)).filter((f) => f.startsWith('last-abort')).length, 1)
  await tick(W, { now: NOW + 7200e3, dryRun: true })
  assert.equal(JSON.parse(await readFile(file, 'utf8')).count, 2, 'dry run does not bump the marker')
  await W.stub.close()
  const r3 = await tick(W, { now: NOW + 7200e3 }) // refused: a different note
  assert.equal(r3.abort.count, 1)
  assert.notEqual(JSON.parse(await readFile(file, 'utf8')).note, m.note)
})

test('#326: a healthy tick clears the marker; --abort-notified stamps notifiedAt', async () => {
  const W = await world({ findings: [finding(1)], scans: [deepDive()] })
  await writeFile(join(W.stateDir, 'last-abort.json'), JSON.stringify({ status: 'scrutineer-down', note: 'x', firstSeen: iso(NOW), lastSeen: iso(NOW), count: 3 }))
  const { markAbortNotified } = await import('../packages/scrutineer-autopilot/src/tick.mjs')
  const at = await markAbortNotified(W.stateDir, { now: NOW + 1000 })
  assert.equal(at, iso(NOW + 1000))
  assert.equal(JSON.parse(await readFile(join(W.stateDir, 'last-abort.json'), 'utf8')).notifiedAt, at)
  await tick(W)
  await W.stub.close()
  assert.equal(await exists(join(W.stateDir, 'last-abort.json')), false)
})

let failed = 0
for (const [name, fn] of tests) {
  try { await fn(); console.log('PASS', name) }
  catch (e) { failed++; console.error('FAIL', name, '\n  ', e.stack) }
}
console.log(failed ? `\n${failed}/${tests.length} FAILED` : `\nall ${tests.length} passed`)
process.exit(failed ? 1 : 0)
