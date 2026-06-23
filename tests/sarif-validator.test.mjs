// Teeth check for tests/lib/sarif-2_1_0.mjs — the shared SARIF 2.1.0 conformance
// validator used by the security-scan bundle sims. A validator that accepts
// everything would make the "SARIF projection validates" assertions worthless, so
// this pins both that a well-formed log PASSES and that each spec violation FAILS.
// Run:  node tests/sarif-validator.test.mjs
import assert from 'node:assert/strict'
import { validateSarif } from './lib/sarif-2_1_0.mjs'

// A minimal but fully-conformant SARIF 2.1.0 static-analysis log.
const good = () => ({
  version: '2.1.0',
  $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
  runs: [{
    tool: { driver: { name: 'deep-security-scan', version: '1', rules: [{ id: 'sql-injection' }] } },
    results: [{
      ruleId: 'sql-injection',
      level: 'error',
      message: { text: 'SQL injection via raw query' },
      locations: [{ physicalLocation: { artifactLocation: { uri: 'src/db.ts' }, region: { startLine: 42 } } }],
      partialFingerprints: { 'shipFingerprint/v1': 'scf1:deadbeefdeadbeef' },
    }],
  }],
})

const tests = []
const test = (name, fn) => tests.push([name, fn])

test('a well-formed SARIF 2.1.0 log validates', () => {
  const r = validateSarif(good())
  assert.ok(r.valid, `expected valid, errors: ${r.errors.join('; ')}`)
})

test('a result with no locations/region still validates (locations optional)', () => {
  const log = good()
  delete log.runs[0].results[0].locations
  assert.ok(validateSarif(log).valid)
})

// ---- negative controls: each must be REJECTED (proves the validator has teeth) ----
const reject = (name, mutate) => test(`rejects: ${name}`, () => {
  const log = good(); mutate(log)
  const r = validateSarif(log)
  assert.ok(!r.valid, `expected INVALID for "${name}" but it passed`)
})

reject('wrong version', (l) => { l.version = '2.0.0' })
reject('runs not an array', (l) => { l.runs = {} })
reject('missing tool.driver.name', (l) => { delete l.runs[0].tool.driver.name })
reject('rule id not a string', (l) => { l.runs[0].tool.driver.rules[0].id = 123 })
reject('result missing message', (l) => { delete l.runs[0].results[0].message })
reject('bad level enum', (l) => { l.runs[0].results[0].level = 'fatal' })
reject('ruleId wrong type', (l) => { l.runs[0].results[0].ruleId = 7 })
reject('artifactLocation.uri wrong type', (l) => { l.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri = 5 })
reject('region.startLine zero', (l) => { l.runs[0].results[0].locations[0].physicalLocation.region.startLine = 0 })
reject('partialFingerprints value not a string', (l) => { l.runs[0].results[0].partialFingerprints['shipFingerprint/v1'] = 1 })

// ---- runner ----
let failed = 0
for (const [name, fn] of tests) {
  try { await fn(); console.log('PASS', name) }
  catch (e) { failed++; console.error('FAIL', name, '\n  ', e.message) }
}
console.log(failed ? `\n${failed}/${tests.length} FAILED` : `\nall ${tests.length} passed`)
process.exit(failed ? 1 : 0)
