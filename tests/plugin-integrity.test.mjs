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

test('plugin.json is valid JSON with name/description and NO pinned version', async () => {
  const m = await readJSON('.claude-plugin/plugin.json')
  assert.equal(m.name, 'shipofclaudius', 'plugin name matches the repo slug')
  assert.ok(typeof m.description === 'string' && m.description.length > 0, 'non-empty description')
  // Intentionally unversioned: Claude Code falls back to the git commit SHA so every
  // commit ships to installers. A pinned `version` here would gate updates off until
  // someone remembers to bump it (it never got bumped across many feature commits).
  // See https://code.claude.com/docs/en/plugins-reference#version-management
  assert.ok(!('version' in m), 'plugin.json must NOT pin a version (use commit-SHA delivery)')
})

test('marketplace.json is valid JSON, lists the plugin, and pins no version', async () => {
  const mk = await readJSON('.claude-plugin/marketplace.json')
  assert.ok(Array.isArray(mk.plugins) && mk.plugins.length >= 1, 'has a plugins array')
  const plugin = mk.plugins.find((p) => p && p.name === 'shipofclaudius')
  assert.ok(plugin, 'lists the shipofclaudius plugin')
  // A version in the marketplace entry would also gate updates (resolution order:
  // plugin.json version -> marketplace entry version -> git SHA). Keep both unset.
  assert.ok(!('version' in plugin), 'marketplace entry must NOT pin a version')
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

// Process skills are session-long playbooks, not Workflow wrappers. They opt out
// of the 1:1 mapping EXPLICITLY via `workflow: none` in frontmatter — an absent
// workflow script alone is still an orphan and still fails the 1:1 check.
const isProcessSkill = async (name) => {
  const md = await read(`skills/${name}/SKILL.md`)
  return /^workflow:\s*none$/m.test(md)
}

const partitionedSkills = async () => {
  const wrappers = []
  const process = []
  for (const name of await skillNames()) {
    ;(await isProcessSkill(name)) ? process.push(name) : wrappers.push(name)
  }
  return { wrappers, process }
}

test('every workflow has exactly one wrapper skill, and vice versa (1:1, no orphans)', async () => {
  const { wrappers } = await partitionedSkills()
  assert.deepEqual(wrappers, await workflowNames(),
    'non-process skills/<name>/ set must equal .claude/workflows/<name>.js set')
})

test('process skills: declared explicitly, self-consistent, and never Workflow wrappers', async () => {
  const { process } = await partitionedSkills()
  for (const name of process) {
    const md = await read(`skills/${name}/SKILL.md`)
    assert.ok(/^---[\s\S]*?\ndescription:\s*\S.*\n[\s\S]*?---/m.test(md), `${name}: frontmatter has a non-empty description`)
    assert.ok(md.includes(`name: ${name}`), `${name}: frontmatter name matches the directory`)
    assert.ok(!md.includes('scriptPath'), `${name}: a process skill must not masquerade as a Workflow wrapper`)
    // every bundled reference the body mentions must exist
    for (const m of md.matchAll(/references\/([\w.-]+)/g)) {
      await read(`skills/${name}/references/${m[1]}`)
    }
  }
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

// ---- the Action template ----
// The adoption kit ships a GitHub Actions workflow that no simulator covers, because it is YAML
// executed by GitHub rather than a Workflow script. These are string-shape assertions (Node
// built-ins only, no YAML parser) over the properties that are load-bearing for SAFETY or that
// have already broken once. Each one below corresponds to a real defect, not a style preference.

const factoryYml = async () => read('.factory/templates/factory.yml')
// Comments legitimately NAME the forbidden things in order to warn against them ("do NOT add
// --admin"), so a check for a dangerous string must read the executable YAML only.
const factoryCode = async () =>
  (await factoryYml()).split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')

test('factory.yml: the land job readies the draft BEFORE gating', async () => {
  const y = await factoryYml()
  const ready = y.indexOf('gh pr ready')
  const build = y.indexOf('build-input.mjs')
  assert.ok(ready > 0, 'a `gh pr ready` step exists')
  assert.ok(build > 0 && ready < build,
    'readying must precede the gate input: factory-issue-fix opens a DRAFT, a draft reports ' +
    'mergeStateStatus=DRAFT, and gate condition 8 rejects DRAFT — so without this the factory ' +
    'can never land anything it produced')
  assert.ok(/--undo/.test(y), 'an escalated PR is converted back to a draft (the ladder still ends at a draft)')
})

test('factory.yml: the gate exit code is captured, not swallowed by the inherited `bash -e`', async () => {
  const y = await factoryYml()
  assert.ok(/\|\| code=\$\?/.test(y),
    'GitHub runs run: blocks as `bash -e {0}` and `set -uo pipefail` does not clear it — without ' +
    '`|| code=$?` the normal escalate path (exit 2) aborts the step before the code is captured')
  assert.ok(/if: always\(\)/.test(y), 'the comment/escalate steps run under always(), or they are skipped on escalate')
})

test('factory.yml: pull_request_target never checks out or executes PR-authored code', async () => {
  const y = await factoryCode()
  assert.ok(/pull_request_target/.test(y), 'the workflow uses pull_request_target')
  assert.ok(!/head\.sha|head\.ref/.test(y),
    'the land job must never check out the PR head — pull_request_target runs with write access')
  assert.ok(/ref: \$\{\{ github\.event\.pull_request\.base\.ref \}\}/.test(y), 'it checks out the BASE ref')
  const land = y.slice(y.indexOf('  land:'))
  assert.ok(!/npm ci|npm install|npm run build/.test(land),
    'no install or build step in the land job — the gate is dependency-free on purpose')
})

test('factory.yml: the gate config is read from the base ref, never the PR', async () => {
  const y = await factoryYml()
  assert.ok(/\.factory\/gate\.json/.test(y), 'it passes the repo gate config')
  assert.ok(/--config-source/.test(y), 'provenance is stamped into the verdict')
})

test('factory.yml: the merge is never forced', async () => {
  const y = await factoryCode()
  assert.ok(/gh pr merge/.test(y), 'it merges')
  assert.ok(!/--admin/.test(y), 'never --admin (it would bypass the protections the gate mirrors)')
  assert.ok(!/--delete-branch/.test(y), 'never --delete-branch')
  assert.ok(!/force/.test(y.slice(y.indexOf('  land:'))), 'never force-pushes')
})

test('factory.yml: untrusted GitHub context reaches run: blocks only via env', async () => {
  const y = await factoryYml()
  for (const field of ['issue.title', 'pull_request.title', 'pull_request.body', 'issue.body', 'head_commit.message']) {
    assert.ok(!y.includes(`github.event.${field}`), `${field} is never interpolated (injection vector)`)
  }
  assert.ok(/case "\$\{FACTORY_STOP_AFTER\}"/.test(y), 'dispatch inputs are allowlist-validated before reaching the driver')
})

// ---- runner ----
let failed = 0
for (const [name, fn] of tests) {
  try { await fn(); console.log('PASS', name) }
  catch (e) { failed++; console.error('FAIL', name, '\n  ', e.message) }
}
console.log(failed ? `\n${failed}/${tests.length} FAILED` : `\nall ${tests.length} passed`)
process.exit(failed ? 1 : 0)
