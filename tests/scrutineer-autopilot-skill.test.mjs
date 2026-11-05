// Static checks on the scrutineer-autopilot process skill and its references.
// Run:  node tests/scrutineer-autopilot-skill.test.mjs
import assert from 'node:assert/strict'
import { readFile, access } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DIR = join(ROOT, 'skills', 'scrutineer-autopilot')
const read = (p) => readFile(join(DIR, p), 'utf8')
const tests = []
const test = (name, fn) => tests.push([name, fn])

test('SKILL.md has workflow: none and names the fix workflow', async () => {
  const md = await read('SKILL.md')
  assert.match(md.match(/^---\n([\s\S]*?)\n---/)[1], /^workflow: none$/m)
  assert.ok(md.includes('shipofclaudius:scrutineer-fix-pr'))
})

test('every references/<file> the skill and its template mention exists', async () => {
  const seen = new Set()
  for (const f of ['SKILL.md', 'references/scheduled-task.md']) {
    for (const m of (await read(f)).matchAll(/references\/([\w.-]+)/g)) seen.add(m[1])
  }
  assert.ok(seen.has('config.example.json') && seen.has('scheduled-task.md'))
  for (const f of seen) await access(join(DIR, 'references', f))
})

test('config.example.json parses and uses placeholders', async () => {
  const c = JSON.parse(await read('references/config.example.json'))
  assert.equal(c.owner, 'your-gh-login')
})

test('the scheduled-task template points at PLUGIN-FALLBACK.md for Unknown skill', async () => {
  const t = await read('references/scheduled-task.md')
  assert.match(t, /Unknown skill/)
  assert.ok(t.includes('~/.claude/scheduled-tasks/PLUGIN-FALLBACK.md'))
})

test('no shipped skill file contains schmug, /Users/ or 8081', async () => {
  for (const f of ['SKILL.md', 'references/scheduled-task.md', 'references/config.example.json']) {
    const t = await read(f)
    for (const bad of [/schmug/i, /\/Users\//, /8081/]) assert.doesNotMatch(t, bad, `${f} matches ${bad}`)
  }
})

test('M5/I3: docs describe the shipped behaviour (verified diff, DIRTY stop, push notification, no test_output)', async () => {
  const readme = await readFile(join(ROOT, 'README.md'), 'utf8')
  const rows = readme.split('\n').filter((l) => l.startsWith('| [`scrutineer-fix-pr.js`]') || l.startsWith('- **`scrutineer-fix-pr`**'))
  assert.equal(rows.length, 2)
  for (const l of rows) {
    assert.doesNotMatch(l, /minimal fix/i, 'README: scrutineer-fix-pr applies the verified diff, not a minimal fix')
    assert.doesNotMatch(l, /test_output/, 'README: the workflow returns no test_output')
  }
  assert.ok(rows.some((l) => /reattack-verified diff/.test(l)))
  const spec = await readFile(join(ROOT, 'docs/specs/2026-10-26-scrutineer-lifecycle-autopilot-design.md'), 'utf8')
  const rule4 = spec.split('\n').findIndex((l) => l.startsWith('4. `merge-pr-with-gate` escalates'))
  assert.ok(rule4 > 0)
  assert.doesNotMatch(spec.split('\n').slice(rule4, rule4 + 2).join(' '), /re-apply/)
  assert.doesNotMatch(spec, /Ping as a PR comment/)
  assert.match(spec, /Ping as a push notification/)
  const md = await read('SKILL.md')
  assert.doesNotMatch(md, /test_output/)
  assert.match(md, /stateDir/)
})

let failed = 0
for (const [name, fn] of tests) {
  try { await fn(); console.log('PASS', name) }
  catch (e) { failed++; console.error('FAIL', name, '\n  ', e.stack) }
}
console.log(failed ? `\n${failed}/${tests.length} FAILED` : `\nall ${tests.length} passed`)
process.exit(failed ? 1 : 0)
