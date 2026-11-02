// Unit tests for the scrutineer-autopilot config, loopback guard and repo policy.
// Pure, model-free code: ordinary unit tests with an injected `exec` stub.
// Run:  node tests/scrutineer-autopilot-config.test.mjs
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULTS, normalizeConfig, isLoopback, repoKey, policyFor, loadConfig } from '../packages/scrutineer-autopilot/src/config.mjs'

const tests = []
const test = (name, fn) => tests.push([name, fn])

test('isLoopback: accepts 127.0.0.1, localhost and [::1]', () => {
  for (const u of ['http://127.0.0.1:1', 'http://localhost:1', 'http://[::1]:1']) assert.equal(isLoopback(u), true, u)
})

test('isLoopback: rejects other hosts and malformed input', () => {
  for (const u of ['http://127.0.0.2', 'http://localhost.evil.com', 'https://example.com', 'not a url', '']) {
    assert.equal(isLoopback(u), false, u)
  }
})

test('normalizeConfig: refuses a non-loopback baseUrl', () => {
  assert.throws(() => normalizeConfig({ baseUrl: 'http://10.0.0.5:8080' }, { owner: 'o' }), /loopback/)
})

test('repoKey: handles https, ssh and non-GitHub URLs', () => {
  assert.equal(repoKey('https://github.com/Owner/Repo.git'), 'owner/repo')
  assert.equal(repoKey('git@github.com:Owner/Other.git'), 'owner/other')
  assert.equal(repoKey('https://gitlab.com/a/b'), null)
})

test('policyFor: allowlist default auto, unknown exclude, explicit stop', () => {
  const cfg = normalizeConfig({ allowlist: ['O/Site', 'o/other'], repoPolicy: { 'O/Site': 'stop' } }, { owner: 'o' })
  assert.equal(policyFor(cfg, 'o/other'), 'auto')
  assert.equal(policyFor(cfg, 'o/site'), 'stop')
  assert.equal(policyFor(cfg, 'x/unlisted'), 'exclude')
})

test('normalizeConfig: ships no default stop list', () => {
  const cfg = normalizeConfig({ allowlist: ['o/a'] }, { owner: 'o' })
  assert.deepEqual(cfg.repoPolicy, {})
})

test('normalizeConfig: rejects an unknown policy value', () => {
  assert.throws(() => normalizeConfig({ repoPolicy: { 'o/a': 'yolo' } }, { owner: 'o' }), /policy/)
})

test('normalizeConfig: budget defaults match the spec numbers and DEFAULTS is frozen', () => {
  assert.deepEqual(normalizeConfig({}, { owner: 'o' }).budget, {
    reserve: 30, margin: 5, primaryWindowCap: 80, pctPerDollarSeed: 0.5,
    calibrationSamples: 20, calibrationDays: 14, estimateSamples: 10, estimatePercentile: 75,
    fallbackDiffUsd: 5, fallbackFullUsd: 15, fixEstimateUsd: 3,
    maxEnqueuesPerTick: 10, maxScanGroupsRunning: 1, fullRescanDays: 90,
  })
  assert.ok(Object.isFrozen(DEFAULTS) && Object.isFrozen(DEFAULTS.budget))
})

test('normalizeConfig: default tokenPath is the spec §5 operator-token file', () => {
  assert.ok(normalizeConfig({}, { owner: 'o' }).tokenPath.endsWith('scrutineer/data/operator-token'))
})

test('normalizeConfig: budget overrides merge over defaults', () => {
  assert.equal(normalizeConfig({ budget: { reserve: 10 } }, { owner: 'o' }).budget.reserve, 10)
})

test('I7: normalizeConfig throws on a non-finite or non-number budget value, or an unknown budget key', () => {
  for (const v of ['10', null, NaN, Infinity, -Infinity, true, [], {}]) {
    assert.throws(() => normalizeConfig({ budget: { reserve: v } }, { owner: 'o' }), /budget/, String(v))
  }
  assert.throws(() => normalizeConfig({ budget: { reserv: 10 } }, { owner: 'o' }), /budget.*reserv/)
  assert.throws(() => normalizeConfig({ budget: { __proto__: null, constructor: 1 } }, { owner: 'o' }), /budget/)
  assert.equal(normalizeConfig({ budget: { margin: 0, fixEstimateUsd: 2.5 } }, { owner: 'o' }).budget.fixEstimateUsd, 2.5)
})

test('normalizeConfig: owner is lowercased and required', () => {
  assert.equal(normalizeConfig({}, { owner: 'Foo' }).owner, 'foo')
  assert.throws(() => normalizeConfig({}, {}), /owner/)
})

test('config.mjs contains no personal literal', () => {
  const src = readFileSync(new URL('../packages/scrutineer-autopilot/src/config.mjs', import.meta.url), 'utf8')
  assert.ok(!/schmug/i.test(src), 'no schmug literal')
  assert.ok(!/\/Users\/cory/.test(src), 'no home path literal')
  assert.ok(!/8081/.test(src), 'no port literal')
})

test('loadConfig: asks gh for the owner only when absent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sa-cfg-'))
  const p = join(dir, 'config.json')
  const calls = []
  const exec = async (cmd, args) => { calls.push([cmd, ...args]); return 'GhUser\n' }
  writeFileSync(p, JSON.stringify({ allowlist: ['ghuser/a'] }))
  const a = await loadConfig(p, { exec })
  assert.equal(a.owner, 'ghuser')
  assert.deepEqual(calls, [['gh', 'api', 'user', '--jq', '.login']])
  calls.length = 0
  writeFileSync(p, JSON.stringify({ owner: 'Set' }))
  assert.equal((await loadConfig(p, { exec })).owner, 'set')
  assert.equal(calls.length, 0)
})

test('loadConfig: a missing file yields defaults with an empty allowlist', async () => {
  const cfg = await loadConfig(join(tmpdir(), 'sa-does-not-exist', 'config.json'), { exec: async () => 'o\n' })
  assert.deepEqual(cfg.allowlist, [])
  assert.equal(cfg.owner, 'o')
})

// ---- runner ----
let failed = 0
for (const [name, fn] of tests) {
  try { await fn(); console.log('PASS', name) }
  catch (e) { failed++; console.error('FAIL', name, '\n  ', e.message) }
}
console.log(failed ? `\n${failed}/${tests.length} FAILED` : `\nall ${tests.length} passed`)
process.exit(failed ? 1 : 0)
