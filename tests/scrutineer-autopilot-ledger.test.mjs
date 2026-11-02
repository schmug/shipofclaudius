// Unit tests for the scrutineer-autopilot ledger, tick lock, paused flag and run log.
// Run:  node tests/scrutineer-autopilot-ledger.test.mjs
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, readFile, mkdir, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openLedger, acquireLock, isPaused, writeRun, recentRuns } from '../packages/scrutineer-autopilot/src/ledger.mjs'

const tests = []
const test = (name, fn) => tests.push([name, fn])
const withDir = async (fn) => {
  const dir = await mkdtemp(join(tmpdir(), 'autopilot-ledger-'))
  try { await fn(dir) } finally { await rm(dir, { recursive: true, force: true }) }
}
const NOW = Date.parse('2026-11-01T12:00:00Z')

test('second acquireLock while held -> locked; ok after release', () => withDir(async (d) => {
  const a = await acquireLock(d, { now: NOW })
  assert.equal(a.ok, true)
  assert.deepEqual(await acquireLock(d, { now: NOW }), { ok: false, reason: 'locked' })
  await a.release()
  const b = await acquireLock(d, { now: NOW })
  assert.equal(b.ok, true)
  await b.release()
}))
test('lock 3 hours old is taken over; old holder release does not delete the new lock', () => withDir(async (d) => {
  await writeFile(join(d, 'tick.lock'), JSON.stringify({ pid: 1, at: NOW - 3 * 3600e3, token: 'old' }))
  const a = await acquireLock(d, { now: NOW })
  assert.equal(a.ok, true)
  assert.equal((await acquireLock(d, { now: NOW })).ok, false)
  await a.release()
  assert.equal((await acquireLock(d, { now: NOW })).ok, true)
}))
test('stale holder release leaves the taker lock in place', () => withDir(async (d) => {
  const a = await acquireLock(d, { now: NOW })
  const b = await acquireLock(d, { now: NOW + 3 * 3600e3 })
  assert.equal(b.ok, true)
  await a.release()
  assert.equal((await acquireLock(d, { now: NOW + 3 * 3600e3 })).ok, false)
}))
test('unparseable lock is replaced; Date accepted for now', () => withDir(async (d) => {
  await writeFile(join(d, 'tick.lock'), 'not json')
  const a = await acquireLock(d, { now: new Date(NOW) })
  assert.equal(a.ok, true)
}))
test('save then openLedger round-trips; missing file starts empty', () => withDir(async (d) => {
  const l = await openLedger(d)
  assert.deepEqual(l.data, { findings: {}, repos: {}, budgetSamples: [] })
  l.data.findings['7'] = { stage: 'triaged' }
  await l.save()
  assert.deepEqual((await openLedger(d)).data.findings, { '7': { stage: 'triaged' } })
}))
test('leftover ledger.json.tmp does not corrupt ledger.json', () => withDir(async (d) => {
  const l = await openLedger(d)
  l.data.findings['1'] = { stage: 'opened' }
  await l.save()
  await writeFile(join(d, 'ledger.json.tmp'), '{"findings": {"1": ')
  assert.deepEqual((await openLedger(d)).data.findings, { '1': { stage: 'opened' } })
  await l.save()
  assert.deepEqual((await openLedger(d)).data.findings, { '1': { stage: 'opened' } })
}))
test('corrupt ledger.json throws a clear error', () => withDir(async (d) => {
  await writeFile(join(d, 'ledger.json'), '{oops')
  await assert.rejects(openLedger(d), /ledger\.json is corrupt/)
}))
test('isPaused follows the paused file', () => withDir(async (d) => {
  assert.equal(await isPaused(d), false)
  await writeFile(join(d, 'paused'), '')
  assert.equal(await isPaused(d), true)
}))
test('writeRun filenames contain no colon; recentRuns newest first', () => withDir(async (d) => {
  const p1 = await writeRun(d, { n: 1 }, NOW)
  const p2 = await writeRun(d, { n: 2 }, NOW + 60_000)
  const p3 = await writeRun(d, { n: 3 }, new Date(NOW + 120_000))
  for (const p of [p1, p2, p3]) assert.ok(!p.split('/').pop().includes(':'), p)
  assert.deepEqual(JSON.parse(await readFile(p1, 'utf8')), { n: 1 })
  assert.deepEqual((await recentRuns(d, 2)).map((r) => r.n), [3, 2])
  assert.deepEqual(await recentRuns(join(d, 'none'), 5), [])
}))

let failed = 0
for (const [name, fn] of tests) {
  try { await fn(); console.log('PASS', name) }
  catch (e) { failed++; console.error('FAIL', name, '\n  ', e.message) }
}
console.log(failed ? `\n${failed}/${tests.length} FAILED` : `\nall ${tests.length} passed`)
process.exit(failed ? 1 : 0)
