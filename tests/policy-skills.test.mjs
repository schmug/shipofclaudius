// Content-contract test for the gate-merge policy process skills — the skills in
// POLICY_SKILLS below — plus the autonomy-block checks on parallel-build-orchestrator
// and critic-gated-build, and the security-hardening-reviewer agent's report contract.
// Node built-ins only; zero token cost.
// Asserts each POLICY_SKILLS entry exists as a `workflow: none` process skill, carries the
// load-bearing gate-merge policy language (agents merge through a server-side
// ruleset/protection with required CI checks; UNKNOWN/detection failure fails
// closed to stop-at-the-open-PR), and stays sanitized for public consumption.
import { readFile } from 'node:fs/promises'
import assert from 'node:assert/strict'

const ROOT = new URL('../', import.meta.url)
const read = (rel) => readFile(new URL(rel, ROOT), 'utf8')
const skill = (name) => read(`skills/${name}/SKILL.md`)

const POLICY_SKILLS = ['ship', 'pr-workflow', 'implement-issue', 'factory-intake']

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

// A red step is fixed and re-run, not reported and abandoned: the old "stop at the first red
// step" line contradicted step 2's "If tests fail, fix them". Stops are reserved for calls the
// agent cannot make alone.
test('ship: a red step is fixed and re-run; it stops only for a product, scope, or guardrail call', async () => {
  const md = (await skill('ship')).replace(/\s+/g, ' ')
  assert.ok(!/Stop and report failure at the first red step/.test(md), 'the stop-at-first-red rule is gone')
  assert.ok(/When a step goes red, fix it, re-run that step, and continue\./.test(md), 'red steps are fixed and re-run')
  assert.ok(/Stop and ask only when the fix needs a product decision, is outside this branch's scope, or touches a guardrail file\./.test(md), 'names the three stop conditions')
  assert.ok(/Fix errors, re-run, continue\./.test(md) && !/Stop on errors\./.test(md), 'the typecheck step follows the same rule')
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
  assert.match(md, /claude -p/, 'hands off by launching a capped `claude -p` child')
  assert.ok(/do not push\s+to main/.test(md), 'keeps the no-push-to-main directive')
  assert.ok(/squash-merge or enable auto-merge/.test(md), 'gated repos: agent merges once green')
  assert.ok(/fail closed/i.test(md), 'unverifiable gate fails closed')
  assert.ok(/which gate is\s+missing/i.test(md), 'ungated path names the missing gate')
})

test('parallel-build-orchestrator: exists as a process skill', async () => {
  assertProcessSkill('parallel-build-orchestrator', await skill('parallel-build-orchestrator'))
})

test('parallel-build-orchestrator: carries the autonomy opening sentence, its own proceed/stop lists, and the last-paragraph rule', async () => {
  const md = await skill('parallel-build-orchestrator')
  assert.ok(md.includes("You are operating autonomously. The user is not watching in real time and cannot answer questions mid-task, so asking 'Want me to…?' or 'Shall I…?' will block the work."), 'opening sentence present verbatim')
  assert.ok(md.includes('Proceed without asking:'), 'the existing proceed list survives')
  assert.ok(md.includes('Stop and ask:'), 'the existing stop list survives')
  assert.ok(/Before ending your turn, check your last paragraph\./.test(md), 'the last-paragraph rule is present')
  assert.ok(/blocked on input only the user can provide/.test(md), 'the last-paragraph rule keeps its human-input exception')
  const openIdx = md.indexOf('You are operating autonomously')
  const proceedIdx = md.indexOf('Proceed without asking:')
  const ruleIdx = md.indexOf('Before ending your turn, check your last paragraph')
  assert.ok(openIdx >= 0 && openIdx < proceedIdx && proceedIdx < ruleIdx, 'order: opening sentence, then the lists, then the last-paragraph rule')
})

// #188: Phase 5 files GitHub issues from lane followups[] and the autonomy block pre-approves that
// filing. A follow-up can describe a security weakness that is NOT yet fixed on the default branch,
// so Phase 5 must carry track-findings' disclosure routing, not only its fence: public repo -> the
// advisory path (never a public issue), private/internal -> collaborator-only issue, no path -> stop.
test('parallel-build-orchestrator: Phase 5 routes an unpatched security follow-up away from a public issue (#188)', async () => {
  const md = await skill('parallel-build-orchestrator')
  const p5 = md.slice(md.indexOf('## Phase 5'), md.indexOf('## Autonomy boundary'))
  assert.ok(p5.includes('anti-injection preamble'), 'the existing anti-injection fence survives the routing addition')
  assert.ok(/not yet fixed/i.test(p5), 'classifies each follow-up by whether the weakness is not yet fixed on the default branch')
  assert.ok(/advisory/i.test(p5) && /public/i.test(p5), 'the rule is keyed on repo visibility and names the advisory path')
  assert.ok(/MUST NOT be filed as a public issue/.test(p5), 'a public repo never gets an unpatched weakness as a public issue')
  assert.ok(/surface it to the human/i.test(p5), 'an unavailable advisory path stops and surfaces, rather than files')
  assert.ok(/private or internal/i.test(p5) && /collaborator-only/i.test(p5), 'private/internal repos keep the collaborator-only issue path, as track-findings does')
  const stop = md.slice(md.indexOf('Stop and ask:'), md.indexOf('Before ending your turn'))
  assert.ok(/not yet fixed/i.test(stop), 'the autonomy block pre-approves follow-up filing, so its stop list carries the same exception')
})

// Phase 1 used to stop for plan approval, contradicting the autonomy block's "proceed without
// asking: planning, worktrees, lane fan-out". Only a product tradeoff in the plan stops it.
test('parallel-build-orchestrator: Phase 1 fans out without an approval stop unless the plan is a product tradeoff', async () => {
  const md = await skill('parallel-build-orchestrator')
  const p1 = md.slice(md.indexOf('## Phase 1'), md.indexOf('## Phase 2'))
  assert.ok(!/for approval before fanning out/.test(p1), 'the plan-approval stop is gone')
  assert.ok(/Write `plan\.md`, record the split, then fan out\./.test(p1), 'Phase 1 ends by fanning out')
  assert.ok(/cuts a node or changes acceptance criteria, that is a product tradeoff: stop and ask\./.test(p1), 'a product tradeoff still stops')
})

test('critic-gated-build: exists as a process skill', async () => {
  assertProcessSkill('critic-gated-build', await skill('critic-gated-build'))
})

test('critic-gated-build: defines what "autonomy begins" means and names its exceptions', async () => {
  const md = await skill('critic-gated-build')
  assert.ok(!/,\s*and autonomy begins\.?/i.test(md), 'the bare undefined phrase "and autonomy begins" is gone')
  assert.ok(md.includes("You are operating autonomously from this point"), 'the opening sentence is present in place of the bare phrase')
  assert.ok(/intake/i.test(md), 'names the Phase 0 intake exception')
  assert.ok(/first-deploy/i.test(md), 'names the first-deploy check-in exception')
  assert.ok(/platform-setting/i.test(md), 'names the platform-setting decision exception')
  assert.ok(/Before ending your turn, check your last paragraph\./.test(md), 'the last-paragraph rule is present')
})

// The two-consecutive-pass streak spans up to 12 cycles. A long run gets summarized, so a streak
// held only in context is lost; the loop keeps it in a committed file and reads it back.
test('critic-gated-build: the pass streak lives in critic-reports/STATUS.md, not in context', async () => {
  const md = await skill('critic-gated-build')
  const loop = md.slice(md.indexOf('Loop discipline:'), md.indexOf('## Phase 3'))
  assert.ok(loop.includes('critic-reports/STATUS.md'), 'names the status file')
  for (const field of ['cycle number', 'five scores', 'pass streak', 'open findings', 'BLOCKED_BY_PERMISSION']) {
    assert.ok(loop.includes(field), `STATUS.md records: ${field}`)
  }
  assert.ok(/Read the streak from this file\./.test(loop), 'the streak is read back from the file')
})

// implement-issue superseded spawn_task chips; completion must route code-shaped findings there.
test('critic-gated-build: completion hands code-shaped findings to implement-issue, not chips', async () => {
  const md = await skill('critic-gated-build')
  const p3 = md.slice(md.indexOf('## Phase 3'), md.indexOf('## Templates'))
  assert.ok(!/chips?\b/i.test(p3), 'no chip hand-off survives')
  assert.ok(/run the `implement-issue` skill on the code-shaped ones, one child per issue/.test(p3), 'routes through implement-issue')
})

// The reviewer is a merge gate for fix-finding and stacked-impl-lanes. A recall-biased "surface
// anything suspicious" list mixes blockers with guesses; blockers must carry a failure demo and
// unconfirmed suspicions go in their own section.
test('security-hardening-reviewer: lists only merge-blocking problems, each with a failure demo; suspicions are parked separately', async () => {
  const md = await read('.claude/agents/security-hardening-reviewer.md')
  assert.ok(!/Prefer false positives to false negatives/.test(md), 'the recall-over-precision rule is gone')
  assert.ok(md.includes("List only problems you'd block the merge for."), 'blocking-only rule')
  assert.ok(/the file and line, the invariant it breaks, why it's wrong, and how to show it fails \(an input, request, or command\)/.test(md), 'each blocker carries its failure demonstration')
  const fmt = md.slice(md.indexOf('## Output format'), md.indexOf('## Rules'))
  assert.ok(fmt.includes("### Couldn't confirm") && fmt.includes('<file:line> — <suspicion> — <where you looked>'), "Couldn't confirm section with its line shape")
  assert.ok(fmt.includes('### Verified') && fmt.includes('### Not applicable'), 'Verified and Not applicable survive')
  assert.ok(!fmt.includes('### High-priority warnings'), 'the unscoped warnings bucket is gone')
})

test('factory-intake: exists as a process skill and its autonomy block names exactly four check-ins', async () => {
  const md = await skill('factory-intake')
  assert.ok(/^workflow:\s*none$/m.test(md))
  assert.ok(md.includes("You are operating autonomously from this point"))
  const block = md.slice(md.indexOf('You are operating autonomously'), md.indexOf('## Phase 0'))
  assert.equal((block.match(/\*\*[a-z ]+\*\* \(Phase \d+\)/g) || []).length, 4, 'four bolded, phase-numbered check-ins')
  assert.ok(/Before ending your turn, check your last paragraph\./.test(md))
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
