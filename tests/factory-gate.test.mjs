// Unit tests for the deterministic factory merge gate (packages/factory-gate).
//
// Unlike the workflow sims, there is nothing to simulate here — the gate is pure, model-free
// code, so these are ordinary unit tests. The bar they enforce: every condition FAILS CLOSED.
// For each condition there is a test proving that missing/ambiguous/unknown input is a FAIL,
// because that is the property an auto-merge gate lives or dies by.
// Run:  node tests/factory-gate.test.mjs
import assert from 'node:assert/strict'
import { globToRegExp, matches, firstMatch } from '../packages/factory-gate/src/glob.mjs'
import { stripNonSemantic, extractCloses, extractScopeGlobs } from '../packages/factory-gate/src/extract.mjs'
import { normalizeConfig, MANDATORY_DENYLIST, DEFAULTS } from '../packages/factory-gate/src/config.mjs'
import { evaluate, renderVerdict, CONDITION_ORDER } from '../packages/factory-gate/src/gate-core.mjs'
import { buildGateInput, normalizeChecks, resolveLinkedIssue, requiredContextsPath } from '../packages/factory-gate/src/build-input.mjs'

const tests = []
const test = (name, fn) => tests.push([name, fn])

// ---------- glob ----------

test('glob: * stays within one path segment', () => {
  assert.ok(matches('src/index.ts', 'src/*.ts'))
  assert.ok(!matches('src/db/index.ts', 'src/*.ts'), '* must not cross a /')
})

test('glob: **/ is an optional any-depth prefix', () => {
  assert.ok(matches('a.ts', '**/*.ts'))
  assert.ok(matches('src/db/a.ts', '**/*.ts'))
})

test('glob: trailing /** matches everything below', () => {
  assert.ok(matches('src/auth/jwt.ts', 'src/auth/**'))
  assert.ok(matches('src/auth/deep/nested/x.ts', 'src/auth/**'))
  assert.ok(!matches('src/authz/x.ts', 'src/auth/**'), 'must not prefix-match a sibling directory')
})

test('glob: patterns are anchored at both ends', () => {
  assert.ok(!matches('vendor/src/auth/x.ts', 'src/auth/**'), 'no accidental substring match')
  assert.ok(!matches('src/index.ts.bak', 'src/*.ts'))
})

test('glob: brace alternation works, and a literal comma outside braces stays literal', () => {
  assert.ok(matches('a.ts', '*.{ts,js}'))
  assert.ok(matches('a.js', '*.{ts,js}'))
  assert.ok(!matches('a.md', '*.{ts,js}'))
  assert.ok(matches('we,ird.ts', 'we,ird.ts'), 'a comma outside braces is literal')
})

test('glob: regex metacharacters in a pattern are escaped, not interpreted', () => {
  assert.ok(matches('a+b.ts', 'a+b.ts'))
  assert.ok(!matches('aab.ts', 'a+b.ts'), '+ must not act as a regex quantifier')
  assert.ok(!matches('aXb.ts', 'a.b.ts'), '. must not act as a regex wildcard')
})

test('glob: an unbalanced brace is unmatchable rather than a crash (fail-closed)', () => {
  assert.doesNotThrow(() => globToRegExp('src/{a,b'))
  assert.ok(!matches('src/a', 'src/{a,b'))
})

test('glob: firstMatch reports which pattern matched, and ignores junk entries', () => {
  assert.equal(firstMatch('src/db/x.ts', ['src/auth/**', 'src/db/**']), 'src/db/**')
  assert.equal(firstMatch('src/x.ts', []), null)
  assert.equal(firstMatch('src/x.ts', ['', '   ', null]), null)
})

// ---------- extract ----------

test('extract: a Closes inside a code fence does NOT count', () => {
  const body = 'Fix it.\n\n```\nCloses #99\n```\n'
  assert.deepEqual(extractCloses(body), { number: null, found: [] })
})

test('extract: a Closes in an inline code span, HTML comment, or blockquote does NOT count', () => {
  assert.equal(extractCloses('use `Closes #1` in your PR').number, null)
  assert.equal(extractCloses('<!-- Closes #2 -->').number, null)
  assert.equal(extractCloses('> Closes #3').number, null)
})

test('extract: a real Closes counts, and the keyword set matches GitHub', () => {
  assert.equal(extractCloses('Closes #12').number, 12)
  assert.equal(extractCloses('fixes #12').number, 12)
  assert.equal(extractCloses('Resolved #12').number, 12)
  assert.equal(extractCloses('Closes: #12').number, 12)
})

test('extract: ambiguous (two distinct issues) is null — the gate never guesses', () => {
  const r = extractCloses('Closes #1 and closes #2')
  assert.equal(r.number, null)
  assert.deepEqual(r.found, [1, 2])
})

test('extract: the same issue referenced twice is not ambiguous', () => {
  assert.equal(extractCloses('Closes #7. Really, closes #7.').number, 7)
})

test('extract: an UNCLOSED code fence swallows the rest of the body (fail-closed)', () => {
  assert.equal(extractCloses('intro\n```\nCloses #5').number, null)
})

test('extract: scope globs are read from a ```scope block, tolerating list markers and comments', () => {
  const body = 'Bug.\n\n```scope\n# only these\nsrc/analyzers/**\n- test/**\n\n```\n'
  assert.deepEqual(extractScopeGlobs(body), ['src/analyzers/**', 'test/**'])
})

test('extract: no scope block yields an empty list (which callers treat as total drift)', () => {
  assert.deepEqual(extractScopeGlobs('no block here'), [])
})

test('extract: stripNonSemantic leaves ordinary prose intact', () => {
  assert.match(stripNonSemantic('the analyzer returns B'), /analyzer returns B/)
})

// ---------- config ----------

test('config: defaults are the SAFE values', () => {
  const { config } = normalizeConfig({})
  assert.deepEqual(config.requiredLabels, ['fix-verified'])
  assert.equal(config.requireScopeBlock, true)
  assert.equal(config.requireGreenCI, true)
  assert.equal(config.maxChangedFiles, DEFAULTS.maxChangedFiles)
})

test('config: an empty allowlist trusts NOBODY and says so', () => {
  const { config, warnings } = normalizeConfig({})
  assert.deepEqual(config.allowlistAuthors, [])
  assert.ok(warnings.some((w) => /NO author is trusted/.test(w)))
})

test('config: a repo can ADD to the mandatory denylist but never shrink it', () => {
  const { config } = normalizeConfig({ riskPathDenylist: ['src/auth/**'] })
  for (const m of MANDATORY_DENYLIST) assert.ok(config.riskPathDenylist.includes(m), `${m} survives`)
  assert.ok(config.riskPathDenylist.includes('src/auth/**'))
})

test('config: even an explicitly empty denylist keeps the mandatory entries', () => {
  const { config } = normalizeConfig({ riskPathDenylist: [] })
  assert.ok(config.riskPathDenylist.includes('.factory/**'), 'a PR can never un-gate its own gate config')
  assert.ok(config.riskPathDenylist.includes('.github/workflows/**'))
})

test('config: malformed values fall back to safe defaults with a warning, never throw', () => {
  const { config, warnings } = normalizeConfig({ maxChangedFiles: -3, requireGreenCI: 'yes', allowlistAuthors: 'schmug' })
  assert.equal(config.maxChangedFiles, DEFAULTS.maxChangedFiles)
  assert.equal(config.requireGreenCI, true)
  assert.deepEqual(config.allowlistAuthors, [])
  assert.ok(warnings.length >= 3)
})

test('config: a non-object config is rejected wholesale, not partially trusted', () => {
  const { config, warnings } = normalizeConfig(['nope'])
  assert.equal(config.requireGreenCI, true)
  assert.ok(warnings.some((w) => /must be a JSON object/.test(w)))
})

// ---------- evaluate ----------

const CONFIG = {
  allowlistAuthors: ['schmug'],
  riskPathDenylist: ['src/analyzers/**', 'src/db/**'],
  maxChangedLines: 250,
  maxChangedFiles: 8,
}

const okInput = (over = {}) => ({
  issue: {
    number: 42,
    author: 'schmug',
    labels: ['auto-impl'],
    body: 'Grade is wrong.\n\n```scope\nsrc/views/**\ntest/**\n```\n',
  },
  pr: {
    number: 101,
    labels: ['fix-verified'],
    body: 'Closes #42',
    changedFiles: ['src/views/report.ts', 'test/report.test.ts'],
    additions: 20,
    deletions: 4,
    mergeStateStatus: 'CLEAN',
    checks: [{ name: 'check', conclusion: 'success' }],
  },
  requiredContexts: ['check'],
  ...over,
})

const failedIds = (v) => v.failed.slice().sort()

test('evaluate: a fully clean PR passes and reports outcome merge', () => {
  const v = evaluate(okInput(), CONFIG, { configSource: 'main@abc123' })
  assert.equal(v.pass, true, JSON.stringify(v.failed))
  assert.equal(v.outcome, 'merge')
  assert.equal(v.configSource, 'main@abc123', 'provenance is stamped into the verdict')
})

test('evaluate: every condition is evaluated even after a failure (one-pass feedback)', () => {
  const v = evaluate({ issue: {}, pr: {} }, CONFIG)
  assert.equal(v.conditions.length, CONDITION_ORDER.length)
  assert.deepEqual(v.conditions.map((c) => c.id), CONDITION_ORDER)
})

test('evaluate: an un-allowlisted issue author escalates', () => {
  const v = evaluate(okInput({ issue: { ...okInput().issue, author: 'stranger' } }), CONFIG)
  assert.ok(v.failed.includes('author_allowlisted'))
  assert.equal(v.outcome, 'escalate')
})

test('evaluate: a missing fix-verified label escalates', () => {
  const i = okInput(); i.pr.labels = []
  assert.ok(evaluate(i, CONFIG).failed.includes('required_labels'))
})

test('evaluate: the label check is case-insensitive', () => {
  const i = okInput(); i.pr.labels = ['Fix-Verified']
  assert.ok(!evaluate(i, CONFIG).failed.includes('required_labels'))
})

test('evaluate: pipeline-paused on the issue is the kill switch', () => {
  const i = okInput(); i.issue.labels = ['pipeline-paused']
  const v = evaluate(i, CONFIG)
  assert.ok(v.failed.includes('no_blocking_labels'))
})

test('evaluate: needs-you on the PR blocks it', () => {
  const i = okInput(); i.pr.labels = ['fix-verified', 'needs-you']
  assert.ok(evaluate(i, CONFIG).failed.includes('no_blocking_labels'))
})

test('evaluate: a PR closing a different issue than the one gated escalates', () => {
  const i = okInput(); i.pr.body = 'Closes #999'
  assert.ok(evaluate(i, CONFIG).failed.includes('single_closes'))
})

test('evaluate: a risk-path file escalates', () => {
  const i = okInput()
  i.issue.body = 'x\n\n```scope\nsrc/**\ntest/**\n```\n'
  i.pr.changedFiles = ['src/analyzers/dmarc.ts']
  const v = evaluate(i, CONFIG)
  assert.ok(v.failed.includes('no_risk_paths'))
  assert.match(v.conditions.find((c) => c.id === 'no_risk_paths').reason, /src\/analyzers/)
})

test('evaluate: a PR editing .factory/ escalates even though config never listed it', () => {
  const i = okInput()
  i.issue.body = 'x\n\n```scope\n**\n```\n'
  i.pr.changedFiles = ['.factory/gate.json']
  assert.ok(evaluate(i, CONFIG).failed.includes('no_risk_paths'), 'a PR cannot widen its own gate')
})

test('evaluate: oversized changes escalate on both files and lines', () => {
  const many = okInput()
  many.issue.body = 'x\n\n```scope\nsrc/views/**\n```\n'
  many.pr.changedFiles = Array.from({ length: 9 }, (_, n) => `src/views/f${n}.ts`)
  assert.ok(evaluate(many, CONFIG).failed.includes('within_size_limits'))

  const big = okInput(); big.pr.additions = 300
  assert.ok(evaluate(big, CONFIG).failed.includes('within_size_limits'))
})

test('evaluate: an issue with NO scope block means every file is drift', () => {
  const i = okInput(); i.issue.body = 'Just a description, no scope block.'
  const v = evaluate(i, CONFIG)
  assert.ok(v.failed.includes('no_scope_drift'))
  assert.match(v.conditions.find((c) => c.id === 'no_scope_drift').reason, /fail-closed/)
})

test('evaluate: a file outside the declared scope is drift', () => {
  const i = okInput(); i.pr.changedFiles = ['src/views/report.ts', 'src/billing/stripe.ts']
  assert.ok(evaluate(i, CONFIG).failed.includes('no_scope_drift'))
})

test('evaluate: an unavailable CI status is UNKNOWN and never a pass', () => {
  const i = okInput(); delete i.pr.checks
  assert.ok(evaluate(i, CONFIG).failed.includes('ci_green'))
})

test('evaluate: a required check that never reported fails', () => {
  const i = okInput(); i.requiredContexts = ['check', 'codeql']
  const v = evaluate(i, CONFIG)
  assert.ok(v.failed.includes('ci_green'))
  assert.match(v.conditions.find((c) => c.id === 'ci_green').reason, /codeql: missing/)
})

test('evaluate: a required check still running fails', () => {
  const i = okInput(); i.pr.checks = [{ name: 'check', conclusion: '' }]
  assert.ok(evaluate(i, CONFIG).failed.includes('ci_green'))
})

test('evaluate: no resolved required contexts fails (cannot prove green)', () => {
  const i = okInput(); i.requiredContexts = []
  assert.ok(evaluate(i, CONFIG).failed.includes('ci_green'))
})

test('evaluate: a DIRTY or BEHIND mergeStateStatus fails', () => {
  for (const s of ['DIRTY', 'BEHIND', 'BLOCKED']) {
    const i = okInput(); i.pr.mergeStateStatus = s
    assert.ok(evaluate(i, CONFIG).failed.includes('ci_green'), `${s} must fail`)
  }
})

test('evaluate: an empty changed-file list cannot prove safety', () => {
  const i = okInput(); i.pr.changedFiles = []
  const v = evaluate(i, CONFIG)
  assert.ok(v.failed.includes('no_risk_paths'))
  assert.ok(v.failed.includes('no_scope_drift'))
})

test('evaluate: fixture evidence is skipped unless required', () => {
  assert.ok(!evaluate(okInput(), CONFIG).failed.includes('fixture_evidence'))
})

test('evaluate: when required, fixture evidence must be red-on-base AND green-on-head', () => {
  const c = { ...CONFIG, requireFixtureEvidence: true }
  assert.ok(evaluate(okInput(), c).failed.includes('fixture_evidence'), 'absent evidence fails')

  const partial = okInput({ evidence: { fixtureTest: 'test/fixtures/foo.test.ts', greenOnHead: true } })
  assert.ok(evaluate(partial, c).failed.includes('fixture_evidence'), 'green-only is not proof')

  const full = okInput({ evidence: { fixtureTest: 'test/fixtures/foo.test.ts', redOnBase: true, greenOnHead: true } })
  assert.ok(!evaluate(full, c).failed.includes('fixture_evidence'))
})

test('evaluate: a wholly empty input fails EVERY substantive condition', () => {
  const v = evaluate({}, CONFIG)
  assert.equal(v.pass, false)
  for (const id of ['author_allowlisted', 'required_labels', 'single_closes', 'no_risk_paths', 'within_size_limits', 'no_scope_drift', 'ci_green']) {
    assert.ok(v.failed.includes(id), `${id} must fail on empty input`)
  }
})

test('evaluate: with no config at all, nothing merges', () => {
  assert.equal(evaluate(okInput(), undefined).pass, false, 'absent config must not be permissive')
})

test('renderVerdict: emits one table row per condition and states the provenance', () => {
  const md = renderVerdict(evaluate(okInput(), CONFIG, { configSource: 'main@deadbee' }))
  assert.match(md, /Factory gate — ✅ merge/)
  assert.match(md, /main@deadbee/)
  for (const id of CONDITION_ORDER) assert.ok(md.includes(`\`${id}\``), `${id} appears in the audit comment`)
})

test('renderVerdict: escapes pipes so a hostile filename cannot break the table', () => {
  const i = okInput(); i.pr.changedFiles = ['src/views/a|b.ts']
  const md = renderVerdict(evaluate(i, CONFIG))
  assert.ok(!/\| src\/views\/a\|b\.ts/.test(md), 'raw pipes must be escaped')
})

// ---------- build-input (the gate-input shape contract) ----------
// The shape of gate-input.json is a contract between four callers: the Action's land job,
// factory-land, factory-issue-fix's evidence block, and gate-core's nine conditions. A silent
// shape drift would DISABLE a condition rather than fail it, so the shaping is pure and tested.

const ghPr = (over = {}) => ({
  number: 900,
  body: 'Closes #417\n\n```scope\nsrc/a.ts\n```',
  labels: [{ name: 'fix-verified' }],
  files: [{ path: 'src/a.ts' }],
  additions: 10,
  deletions: 2,
  mergeStateStatus: 'CLEAN',
  baseRefName: 'main',
  statusCheckRollup: [{ name: 'check', conclusion: 'SUCCESS' }],
  ...over,
})
const ghIssue = (over = {}) => ({
  number: 417, author: { login: 'schmug' }, body: '```scope\nsrc/a.ts\n```', labels: [{ name: 'factory' }], ...over,
})

test('build-input: shapes gh JSON into an input the gate accepts end to end', () => {
  const input = buildGateInput({ pr: ghPr(), issue: ghIssue(), requiredContexts: ['check'] })
  const v = evaluate(input, CONFIG)
  assert.equal(v.pass, true, 'a clean PR shaped by build-input passes all nine conditions')
  assert.deepEqual(v.failed, [])
})

test('build-input: emits exactly the keys gate-core reads', () => {
  const input = buildGateInput({ pr: ghPr(), issue: ghIssue(), requiredContexts: ['check'] })
  assert.deepEqual(Object.keys(input).sort(), ['evidence', 'issue', 'pr', 'requiredContexts'])
  assert.deepEqual(Object.keys(input.issue).sort(), ['author', 'body', 'labels', 'number'])
  assert.deepEqual(Object.keys(input.pr).sort(),
    ['additions', 'body', 'changedFiles', 'checks', 'deletions', 'labels', 'mergeStateStatus', 'number'])
})

test('build-input: labels are unwrapped from {name} and from bare strings alike', () => {
  const a = buildGateInput({ pr: ghPr({ labels: [{ name: 'x' }] }) })
  const b = buildGateInput({ pr: ghPr({ labels: ['x'] }) })
  assert.deepEqual(a.pr.labels, ['x'])
  assert.deepEqual(b.pr.labels, ['x'])
})

test('build-input: an absent issue fails closed rather than inventing an author', () => {
  const input = buildGateInput({ pr: ghPr(), issue: null, requiredContexts: ['check'] })
  assert.equal(input.issue.author, null, 'no author is invented')
  assert.equal(input.issue.body, '', 'no scope block is invented')
  const v = evaluate(input, CONFIG)
  assert.equal(v.pass, false)
  assert.ok(v.failed.includes('author_allowlisted'), 'an unknown author cannot be allowlisted')
  assert.ok(v.failed.includes('no_scope_drift'), 'no scope block means every file is drift')
})

test('build-input: missing size data becomes null, and null fails within_size_limits', () => {
  const input = buildGateInput({ pr: ghPr({ additions: undefined, deletions: undefined }), issue: ghIssue(), requiredContexts: ['check'] })
  assert.equal(input.pr.additions, null)
  assert.ok(evaluate(input, CONFIG).failed.includes('within_size_limits'), 'unprovable size is a FAIL')
})

test('build-input: an absent file list becomes null, not an empty allow-everything list', () => {
  const input = buildGateInput({ pr: ghPr({ files: undefined }), issue: ghIssue(), requiredContexts: ['check'] })
  assert.equal(input.pr.changedFiles, null, 'null, never []')
  assert.ok(evaluate(input, CONFIG).failed.includes('no_risk_paths'), 'an unknown file list cannot be proven safe')
})

test('normalizeChecks: an absent rollup is null (UNKNOWN), never an empty green list', () => {
  assert.equal(normalizeChecks(undefined), null)
  assert.equal(normalizeChecks(null), null)
  const input = buildGateInput({ pr: ghPr({ statusCheckRollup: undefined }), issue: ghIssue(), requiredContexts: ['check'] })
  assert.ok(evaluate(input, CONFIG).failed.includes('ci_green'), 'UNKNOWN CI is never a pass')
})

test('normalizeChecks: conclusions are lowercased and `context`/`state` aliases are accepted', () => {
  assert.deepEqual(normalizeChecks([{ name: 'a', conclusion: 'SUCCESS' }]), [{ name: 'a', conclusion: 'success' }])
  assert.deepEqual(normalizeChecks([{ context: 'b', state: 'FAILURE' }]), [{ name: 'b', conclusion: 'failure' }])
})

test('build-input: no required contexts resolved means ci_green FAILS', () => {
  const input = buildGateInput({ pr: ghPr(), issue: ghIssue(), requiredContexts: [] })
  assert.ok(evaluate(input, CONFIG).failed.includes('ci_green'), 'a repo whose required checks are undiscoverable proves nothing')
})

test('resolveLinkedIssue: routing matches the gate, and ambiguity routes nowhere', () => {
  assert.equal(resolveLinkedIssue('Closes #417'), 417)
  assert.equal(resolveLinkedIssue('Closes #417\nCloses #418'), null, 'ambiguous references route nowhere')
  assert.equal(resolveLinkedIssue('`Closes #417`'), null, 'an example in a code span is not a declaration')
  assert.equal(resolveLinkedIssue(''), null)
})

test('build-input: the evidence block passes through untouched for the opt-in condition', () => {
  const evidence = { fixtureTest: 'test/a.test.ts::x', redOnBase: true, greenOnHead: true }
  const input = buildGateInput({ pr: ghPr(), issue: ghIssue(), requiredContexts: ['check'], evidence })
  assert.deepEqual(input.evidence, evidence)
  assert.equal(evaluate(input, { ...CONFIG, requireFixtureEvidence: true }).pass, true)
  const bare = buildGateInput({ pr: ghPr(), issue: ghIssue(), requiredContexts: ['check'] })
  assert.equal(bare.evidence, null, 'absent evidence is null, never a permissive default')
  assert.ok(evaluate(bare, { ...CONFIG, requireFixtureEvidence: true }).failed.includes('fixture_evidence'))
})

test('requiredContextsPath: the repo goes in the PATH — `gh api` takes no -R', () => {
  // Regression: passing `-R owner/name` to `gh api` makes the call FAIL, which yields zero
  // required contexts, which fails ci_green on EVERY PR forever. Caught by a live dry run
  // against schmug/dmarcheck, whose main branch is governed by a ruleset (classic protection 404s).
  assert.equal(requiredContextsPath('schmug/dmarcheck', 'main', 'protection'), 'repos/schmug/dmarcheck/branches/main/protection')
  assert.equal(requiredContextsPath('schmug/dmarcheck', 'main', 'rules'), 'repos/schmug/dmarcheck/rules/branches/main')
})

test('requiredContextsPath: falls back to the {owner}/{repo} placeholders when no repo is named', () => {
  assert.equal(requiredContextsPath(null, 'main', 'rules'), 'repos/{owner}/{repo}/rules/branches/main')
  assert.equal(requiredContextsPath(undefined, 'main', 'protection'), 'repos/{owner}/{repo}/branches/main/protection')
  assert.equal(requiredContextsPath(true, 'main', 'rules'), 'repos/{owner}/{repo}/rules/branches/main', 'a bare --repo flag is not a slug')
  assert.equal(requiredContextsPath('not-a-slug', 'main', 'rules'), 'repos/{owner}/{repo}/rules/branches/main')
})

test('requiredContextsPath: a branch name with a slash is encoded, not injected into the path', () => {
  const p = requiredContextsPath('o/r', 'release/v2', 'rules')
  assert.equal(p, 'repos/o/r/rules/branches/release%2Fv2')
  assert.ok(!p.endsWith('/v2'), 'the slash must not create an extra path segment')
})

test('build-input: NULL size data fails closed — Number(null) is 0, which must not read as "0 lines"', () => {
  // `Number(null) === 0` and 0 is finite, so a naive Number.isFinite() guard turns "size
  // unavailable" into a real, passing 0-line change.
  for (const bad of [null, undefined, '', 'abc', NaN]) {
    const input = buildGateInput({ pr: ghPr({ additions: bad, deletions: bad }), issue: ghIssue(), requiredContexts: ['check'] })
    assert.equal(input.pr.additions, null, `additions=${JSON.stringify(bad)} must become null`)
    assert.ok(evaluate(input, CONFIG).failed.includes('within_size_limits'), `additions=${JSON.stringify(bad)} must FAIL the size condition`)
  }
})

test('build-input: a genuine zero-line change is still reported as 0, not conflated with null', () => {
  const input = buildGateInput({ pr: ghPr({ additions: 0, deletions: 0 }), issue: ghIssue(), requiredContexts: ['check'] })
  assert.equal(input.pr.additions, 0, 'a real 0 survives')
  assert.equal(evaluate(input, CONFIG).pass, true, 'and it is within limits')
})

// ---- runner ----
let failed = 0
for (const [name, fn] of tests) {
  try { await fn(); console.log('PASS', name) }
  catch (e) { failed++; console.error('FAIL', name, '\n  ', e.message) }
}
console.log(failed ? `\n${failed}/${tests.length} FAILED` : `\nall ${tests.length} passed`)
process.exit(failed ? 1 : 0)
