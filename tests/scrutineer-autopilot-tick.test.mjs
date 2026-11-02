// Tests for the scrutineer-autopilot tick orchestrator, dry-run guards and finding relay.
// Scrutineer is the node:http stub; gh, codexbar and `scrutineer --version` are a stubbed exec.
// Run:  node tests/scrutineer-autopilot-tick.test.mjs
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, readdir, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
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
  })
  const stateDir = await mkdtemp(join(tmpdir(), 'sa-tick-'))
  const tokenPath = join(stateDir, 'token')
  await writeFile(tokenPath, `${TOKEN}\n`)
  const config = normalizeConfig({ owner: 'o', baseUrl: stub.url, tokenPath, allowlist: ['o/app'], stateDir })
  const client = createClient({ baseUrl: stub.url, tokenPath })
  const posts = () => stub.requests.filter((r) => r.method === 'POST')
  return { stub, stateDir, config, client, posts }
}

const tick = (W, o = {}) => (clock = o.now ?? NOW, runTick({ config: W.config, client: W.client, exec: (o.exec ?? stubExec()).exec, now: o.now ?? NOW, dryRun: o.dryRun ?? false }))
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
  assert.deepEqual(r.agentItems, [{ kind: 'fix', findingId: 7, repo: 'o/app', policy: 'auto', visibility: 'public', hasGate: true, estimateUsd: 3 }])
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
    'pr view 5': JSON.stringify({ state: 'MERGED', mergeCommit: { oid: 'm5' } }),
    'pr view 6': JSON.stringify({ state: 'OPEN', mergeCommit: null }),
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
  assert.deepEqual(r.agentItems, [{ kind: 'regate', findingId: 11, repo: 'o/app', pr: 6, policy: 'auto', visibility: 'public', hasGate: true }])
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

test('bin/finding.mjs prints exactly the relay fields and never the token', async () => {
  const W = await world({ findings: [finding(12, { suggested_fix: 'diff --git a b', description: 'secret narrative' })], scans: [] })
  const cfg = join(W.stateDir, 'config.json')
  await writeFile(cfg, JSON.stringify({ owner: 'o', baseUrl: W.stub.url, tokenPath: W.config.tokenPath, allowlist: ['o/app'], stateDir: W.stateDir }))
  const { stdout } = await promisify(execFile)('node', [join(ROOT, 'packages/scrutineer-autopilot/bin/finding.mjs'), '--config', cfg, '12'])
  await W.stub.close()
  const out = JSON.parse(stdout)
  assert.deepEqual(Object.keys(out).sort(), [...RELAY_FIELDS].sort())
  assert.equal(out.suggested_fix, 'diff --git a b')
  assert.equal(stdout.includes(TOKEN), false)
  assert.equal(W.posts().length, 0)
})

let failed = 0
for (const [name, fn] of tests) {
  try { await fn(); console.log('PASS', name) }
  catch (e) { failed++; console.error('FAIL', name, '\n  ', e.stack) }
}
console.log(failed ? `\n${failed}/${tests.length} FAILED` : `\nall ${tests.length} passed`)
process.exit(failed ? 1 : 0)
