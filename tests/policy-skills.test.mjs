// Content-contract test for the gate-merge policy process skills (ship,
// pr-workflow, implement-issue). Node built-ins only; zero token cost.
// Asserts each skill exists as a `workflow: none` process skill, carries the
// load-bearing gate-merge policy language (agents merge through a server-side
// ruleset/protection with required CI checks; UNKNOWN/detection failure fails
// closed to stop-at-the-open-PR), and stays sanitized for public consumption.
import { readFile } from 'node:fs/promises'
import assert from 'node:assert/strict'

const ROOT = new URL('../', import.meta.url)
const read = (rel) => readFile(new URL(rel, ROOT), 'utf8')
const skill = (name) => read(`skills/${name}/SKILL.md`)

const POLICY_SKILLS = ['ship', 'pr-workflow', 'implement-issue']

const tests = []
const test = (name, fn) => tests.push([name, fn])

const assertProcessSkill = (name, md) => {
  assert.ok(/^---[\s\S]*?\ndescription:\s*\S.*\n[\s\S]*?---/m.test(md), `${name}: frontmatter has a non-empty description`)
  assert.ok(md.includes(`name: ${name}`), `${name}: frontmatter name matches the directory`)
  assert.ok(/^workflow:\s*none$/m.test(md), `${name}: declares workflow: none (process skill, not a wrapper)`)
  assert.ok(!md.includes('scriptPath'), `${name}: must not masquerade as a Workflow wrapper`)
}

test('ship: exists as a process skill', async () => {
  assertProcessSkill('ship', await skill('ship'))
})

test('ship: merges through the mechanical gate, fail closed', async () => {
  const md = await skill('ship')
  assert.ok(/required (CI|status) checks/.test(md), 'names the gate condition (required checks)')
  assert.ok(md.includes('rules/branches'), 'checks rulesets via the rules/branches endpoint')
  assert.ok(/fail closed/i.test(md), 'UNKNOWN/detection failure fails closed')
  assert.ok(md.includes('gh pr merge --auto --squash'), 'gated path can enable auto-merge')
  assert.ok(/stop at the open PR/i.test(md), 'ungated path stops at the open PR')
  assert.ok(/which gate is\s+missing/i.test(md), 'ungated path names the missing gate')
})

test('ship: keeps the never-push-directly-to-main step', async () => {
  assert.ok(/Never push directly to main/.test(await skill('ship')))
})

test('pr-workflow: exists as a process skill', async () => {
  assertProcessSkill('pr-workflow', await skill('pr-workflow'))
})

test('pr-workflow: the gate is the merge criterion, UNKNOWN fails closed', async () => {
  const md = await skill('pr-workflow')
  assert.ok(/required (CI|status) checks/.test(md), 'names the gate condition')
  assert.ok(md.includes('rules/branches'), 'gate check hits the rules/branches endpoint')
  assert.ok(md.includes('UNKNOWN'), 'covers the detection-failure case')
  assert.ok(/fail closed/i.test(md), 'detection failure fails closed')
  assert.ok(/which gate is\s+missing/i.test(md), 'ungated path names the missing gate')
})

test('pr-workflow: keeps the risky-category ask-first carve-out', async () => {
  const md = await skill('pr-workflow')
  assert.ok(md.includes('Ask-first carve-out'), 'carve-out survives the gate rewrite')
  for (const item of ['Database schema changes', 'Auth/security changes', 'Payment/billing changes', 'Breaking API changes', 'Large refactors']) {
    assert.ok(md.includes(item), `carve-out lists: ${item}`)
  }
})

test('implement-issue: exists as a process skill', async () => {
  assertProcessSkill('implement-issue', await skill('implement-issue'))
})

test('implement-issue: handoff prompt ends gate-conditional, keeps no-push-to-main', async () => {
  const md = await skill('implement-issue')
  assert.ok(md.includes('spawn_task'), 'hands off via a spawn_task chip')
  assert.ok(/do not push\s+to main/.test(md), 'keeps the no-push-to-main directive')
  assert.ok(/squash-merge or enable auto-merge/.test(md), 'gated repos: agent merges once green')
  assert.ok(/fail closed/i.test(md), 'unverifiable gate fails closed')
  assert.ok(/which gate is\s+missing/i.test(md), 'ungated path names the missing gate')
})

test('sanitized: no personal references in any policy skill', async () => {
  for (const name of POLICY_SKILLS) {
    const md = await skill(name)
    for (const leak of ['PhishPilot', 'donthype-me', 'donthype.me']) {
      assert.ok(!md.includes(leak), `${name}: must not reference ${leak}`)
    }
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
