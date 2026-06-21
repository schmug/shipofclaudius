// Offline integrity test for the shipofclaudius plugin packaging.
// Node built-ins only; zero token cost. Asserts the plugin manifest is valid and
// (extended in a later task) that every workflow has a correct wrapper skill.
import { readFile } from 'node:fs/promises'
import assert from 'node:assert/strict'

const ROOT = new URL('../', import.meta.url)
const read = (rel) => readFile(new URL(rel, ROOT), 'utf8')
const readJSON = async (rel) => JSON.parse(await read(rel))

const tests = []
const test = (name, fn) => tests.push([name, fn])

test('plugin.json is valid JSON with name/version/description', async () => {
  const m = await readJSON('.claude-plugin/plugin.json')
  assert.equal(m.name, 'shipofclaudius', 'plugin name matches the repo slug')
  assert.equal(typeof m.version, 'string', 'version is a string')
  assert.ok(typeof m.description === 'string' && m.description.length > 0, 'non-empty description')
})

test('marketplace.json is valid JSON and lists the shipofclaudius plugin', async () => {
  const mk = await readJSON('.claude-plugin/marketplace.json')
  assert.ok(Array.isArray(mk.plugins) && mk.plugins.length >= 1, 'has a plugins array')
  assert.ok(mk.plugins.some((p) => p && p.name === 'shipofclaudius'), 'lists the shipofclaudius plugin')
})

import { readdir } from 'node:fs/promises'

// The single source of truth for the bundled-script reference. If Task 4's smoke test
// forces the fallback, change ONLY this line (and re-run the suite).
const wfRef = (name) => `\${CLAUDE_PLUGIN_ROOT}/.claude/workflows/${name}.js`

const workflowNames = async () =>
  (await readdir(new URL('.claude/workflows/', ROOT)))
    .filter((f) => f.endsWith('.js'))
    .map((f) => f.slice(0, -3))
    .sort()

const skillNames = async () => {
  const entries = await readdir(new URL('skills/', ROOT), { withFileTypes: true })
  return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort()
}

test('every workflow has exactly one wrapper skill, and vice versa (1:1, no orphans)', async () => {
  assert.deepEqual(await skillNames(), await workflowNames(),
    'skills/<name>/ set must equal .claude/workflows/<name>.js set')
})

test('each wrapper targets its own bundled workflow via scriptPath + has a description', async () => {
  for (const name of await workflowNames()) {
    const md = await read(`skills/${name}/SKILL.md`)
    assert.ok(/^---[\s\S]*?\ndescription:\s*\S.*\n[\s\S]*?---/m.test(md), `${name}: frontmatter has a non-empty description`)
    assert.ok(md.includes(`name: ${name}`), `${name}: frontmatter name matches the workflow`)
    assert.ok(md.includes('Workflow({') && md.includes('scriptPath'), `${name}: instructs a Workflow scriptPath call`)
    assert.ok(md.includes(wfRef(name)), `${name}: references its own bundled script path (${wfRef(name)})`)
  }
})

// ---- runner ----
let failed = 0
for (const [name, fn] of tests) {
  try { await fn(); console.log('PASS', name) }
  catch (e) { failed++; console.error('FAIL', name, '\n  ', e.message) }
}
console.log(failed ? `\n${failed}/${tests.length} FAILED` : `\nall ${tests.length} passed`)
process.exit(failed ? 1 : 0)
