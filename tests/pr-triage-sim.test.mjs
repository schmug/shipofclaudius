// Offline simulator tests for ../pr-triage-fanout.js.
// Same harness as dss-sim / defense-scan: wraps the workflow source in an
// AsyncFunction with stubbed agent()/parallel()/phase()/log() globals so the
// author-resolution + filtering logic is testable in milliseconds at zero token
// cost. Focus: the generalized author filter — explicit args.author vs. the
// auto-detected gh user (the gather agent's `viewer` field). Run:
//   node tests/pr-triage-sim.test.mjs
import { readFile } from 'node:fs/promises'
import assert from 'node:assert/strict'

const SRC_PATH = new URL('../pr-triage-fanout.js', import.meta.url)
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

function assertSatisfiable(schema, label) {
  const walk = (s, path) => {
    if (!s || typeof s !== 'object') return
    if (s.additionalProperties === false && Array.isArray(s.required)) {
      for (const k of s.required) {
        assert.ok(
          s.properties && s.properties[k],
          `unsatisfiable schema in agent '${label}' at ${path || '<root>'}: required '${k}' missing from properties`
        )
      }
    }
    for (const [k, v] of Object.entries(s.properties || {})) walk(v, `${path}.${k}`)
    if (s.items) walk(s.items, `${path}[]`)
  }
  walk(schema, '')
}

// Runs the workflow with a canned gather result and per-PR triage stub. `gather`
// is whatever the 'gather-open-prs' agent returns ({repo, viewer?, prs:[...]});
// `triage(n)` (optional) returns the per-PR triage object.
async function runScript({ args, gather, triage } = {}) {
  const src = (await readFile(SRC_PATH, 'utf8')).replace('export const meta', 'const meta')
  const calls = { phases: [], logs: [], agents: [], gatherPrompt: '' }
  const agent = async (prompt, opts = {}) => {
    calls.agents.push({ prompt, opts })
    if (opts.schema) assertSatisfiable(opts.schema, opts.label || '?')
    const label = opts.label || ''
    await new Promise((r) => setTimeout(r, 1))
    if (label === 'gather-open-prs') { calls.gatherPrompt = prompt; return gather }
    if (label.startsWith('triage:#')) {
      const n = Number(label.slice('triage:#'.length))
      return triage ? triage(n)
        : { number: n, action: 'AWAITING_HUMAN', ci_status: 'PASSING', mergeability: 'CLEAN', rationale: 'canned' }
    }
    throw new Error('unexpected agent label: ' + label)
  }
  const parallel = (thunks) => Promise.all(thunks.map((t) => Promise.resolve().then(t).catch(() => null)))
  const phase = (t) => calls.phases.push(t)
  const log = (m) => calls.logs.push(m)
  const fn = new AsyncFunction('args', 'budget', 'agent', 'parallel', 'pipeline', 'phase', 'log', 'workflow', src)
  const result = await fn(args, undefined, agent, parallel, null, phase, log, null)
  return { result, calls }
}

const tests = []
const test = (name, fn) => tests.push([name, fn])

test('no args.author: filters to the auto-detected gh user (the gathered viewer)', async () => {
  const gather = {
    repo: 'o/r', viewer: 'alice', prs: [
      { number: 1, author: 'alice', state: 'OPEN' },
      { number: 2, author: 'app/dependabot', state: 'OPEN' },
      { number: 3, author: 'alice', state: 'OPEN' },
    ],
  }
  const { result, calls } = await runScript({ args: {}, gather })
  assert.equal(result.author_filter, 'alice', 'author filter resolved from the gathered viewer')
  assert.deepEqual(result.kept.map((p) => p.number).sort(), [1, 3], 'kept only the viewer-authored PRs')
  assert.deepEqual(result.dropped.map((p) => p.number), [2], 'dropped the non-author PR')
  assert.equal(result.triaged.length, 2, 'one triage agent per kept PR')
  assert.ok(/gh api user/.test(calls.gatherPrompt), 'gather prompt asks for the authenticated login when no args.author')
})

test('explicit args.author wins over the gathered viewer and skips the viewer lookup', async () => {
  const gather = {
    repo: 'o/r', viewer: 'alice', prs: [
      { number: 1, author: 'alice', state: 'OPEN' },
      { number: 2, author: 'bob', state: 'OPEN' },
    ],
  }
  const { result, calls } = await runScript({ args: { author: 'bob' }, gather })
  assert.equal(result.author_filter, 'bob', 'explicit args.author is used verbatim')
  assert.deepEqual(result.kept.map((p) => p.number), [2], 'kept only the args.author PRs')
  assert.ok(!/gh api user/.test(calls.gatherPrompt), 'no viewer lookup requested when args.author is explicit')
})

test('unresolvable author (no viewer, no args.author) throws rather than triaging everyone', async () => {
  const gather = { repo: 'o/r', prs: [{ number: 1, author: 'alice', state: 'OPEN' }] } // no viewer field
  await assert.rejects(runScript({ args: {}, gather }), /could not resolve an author/)
})

test('explicit numbers path also applies the author filter', async () => {
  const gather = {
    repo: 'o/r', viewer: 'x', prs: [
      { number: 1, author: 'bob', state: 'OPEN' },
      { number: 2, author: 'carol', state: 'OPEN' },
    ],
  }
  const { result, calls } = await runScript({ args: { numbers: [1, 2], author: 'bob' }, gather })
  assert.ok(/For EACH of these PR numbers/.test(calls.gatherPrompt), 'explicit-numbers gather branch used')
  assert.deepEqual(result.kept.map((p) => p.number), [1], 'kept the matching-author number')
  assert.deepEqual(result.dropped.map((p) => p.number), [2], 'dropped the non-author number')
})

test('open PRs exist but none are the author\'s: clean empty success, not a throw', async () => {
  const gather = {
    repo: 'o/r', viewer: 'alice', prs: [
      { number: 5, author: 'bob', state: 'OPEN' },
      { number: 6, author: 'app/dependabot', state: 'OPEN' },
    ],
  }
  const { result } = await runScript({ args: {}, gather })
  assert.equal(result.triaged.length, 0, 'nothing triaged')
  assert.equal(result.author_filter, 'alice', 'author still reported for the caller')
  assert.equal(result.dropped.length, 2, 'both non-author PRs recorded as dropped')
})

test('baseline: gather + triage schemas used during a run are satisfiable', async () => {
  // assertSatisfiable runs inside agent(); a run that reaches triage exercises both schemas.
  const gather = { repo: 'o/r', viewer: 'alice', prs: [{ number: 1, author: 'alice', state: 'OPEN' }] }
  const { result } = await runScript({ args: {}, gather })
  assert.equal(result.triaged.length, 1)
})

// ---- runner ----
let failed = 0
for (const [name, fn] of tests) {
  try { await fn(); console.log('PASS', name) }
  catch (e) { failed++; console.error('FAIL', name, '\n  ', e.message) }
}
console.log(failed ? `\n${failed}/${tests.length} FAILED` : `\nall ${tests.length} passed`)
process.exit(failed ? 1 : 0)
