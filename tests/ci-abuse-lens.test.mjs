// Content-contract + gating tests for the CI/CD pipeline-abuse lens in security-diff-scan.
//
// PORTED from the retired hand-rolled `security-diff-scan` skill
// (`~/.claude/retired-skills/security-diff-scan/tests/ci-abuse-lens.test.mjs`, 2026-06-19),
// which asserted the lens against a PROSE skill's SKILL.md + references/methodology.md.
// The plugin's canonical implementation is a Workflow script, so the same seven content
// assertions now run against `.claude/workflows/security-diff-scan.js` — the instruction text
// the discovery/severity agents actually receive. The contract is unchanged: pin the lens so a
// future careless edit cannot silently drop it.
//
// The port also adds what the prose skill could not test — the lens is GATED IN CODE on the diff
// touching CI/CD config, so the "diff-anchored, not a whole-repo CI sweep" design boundary is now
// an executable assertion rather than a sentence. Those tests wrap the workflow body in an
// AsyncFunction with stubbed runtime globals, exactly like tests/security-diff-sim.test.mjs.
//
// Node built-ins only. Run:  node tests/ci-abuse-lens.test.mjs
import { readFile } from 'node:fs/promises'
import assert from 'node:assert/strict'

const SRC_PATH = new URL('../.claude/workflows/security-diff-scan.js', import.meta.url)
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const src = await readFile(SRC_PATH, 'utf8')

const tests = []
const test = (name, fn) => tests.push([name, fn])

// ============================ content contract (the ported seven) ============================
// `has` matches against the workflow SOURCE: the lens lives in the agent prompt text, so the
// source is the instruction text. Same shape as the original's SKILL.md+methodology concat.
const has = (re, label) => assert.ok(re.test(src), `missing: ${label}`)

test('a named CI/CD pipeline-abuse lens exists', () => {
  has(/CI\/CD pipeline[- ]abuse/i, 'a "CI/CD pipeline-abuse" lens heading/label')
})

test('it names the attack chain: compromised credential -> workflow modification -> secret harvest', () => {
  has(/compromis|stolen/i, 'compromised/stolen credential')
  has(/workflow (modif|edit|injection|change)/i, 'workflow modification')
  has(/secret[s]?[^.\n]{0,40}(harvest|exfil|steal|theft)|(harvest|exfil)[^.\n]{0,20}secret/i, 'secret harvesting/exfiltration')
})

test('it names the CI config file targets across platforms (diff-anchored)', () => {
  has(/\.github\/workflows/i, 'GitHub Actions workflows path')
  has(/gitlab-?ci|\.gitlab-ci/i, 'GitLab CI config')
  has(/azure[^.\n]{0,20}pipeline/i, 'Azure DevOps pipelines')
})

test('it enumerates the specific abuse vectors', () => {
  has(/workflow injection/i, 'workflow injection')
  has(/self-hosted runner/i, 'self-hosted runner abuse')
  has(/cache poisoning/i, 'cache poisoning')
  has(/pwn request|pull_request_target/i, 'pwn request / pull_request_target')
  has(/exfil/i, 'secret exfiltration to attacker infra')
})

test('the lens is gated on the diff touching CI/CD config (not a whole-repo sweep)', () => {
  has(/when (a |the )?(diff|change|pr)[^.\n]{0,60}(workflow|ci\/cd|pipeline)|diff touches[^.\n]{0,40}(ci\/cd|workflow|pipeline)/i,
    'a trigger tying the lens to diffs that touch CI/CD config')
})

test('severity guidance: secret exfiltration from CI is high/critical', () => {
  has(/secret[^.\n]{0,60}(high|critical)|(high|critical)[^.\n]{0,60}(secret|exfil)/i,
    'CI secret exfil calibrated to high/critical')
})

test('provenance: credits the Elastic cicd-abuse-detector taxonomy', () => {
  has(/elastic|cicd-abuse-detector|security labs/i, 'attribution to the source taxonomy')
})

// ---- additions beyond the original seven: the remaining named vectors + license note ----

test('it names trigger/permission widening incl. OIDC id-token and unpinned uses:', () => {
  has(/trigger *\/? *(and|permission)|permission widening/i, 'trigger / permission widening')
  has(/id-token: ?write/i, 'OIDC id-token: write escalation')
  has(/unpinned `?uses:/i, 'unpinned uses: action reference')
  has(/workflow_run/i, 'workflow_run pwn-request trigger')
})

test('provenance preserves the Apache-2.0 license note', () => {
  has(/Apache-2\.0/, 'Apache-2.0 attribution for the Elastic-derived taxonomy')
})

// ============================ gating behaviour (new: the lens is code-gated) ============================

const NONCE = 'deadbeefcafe'
const filesFor = (paths) => paths.map((p) => ({ path: p, status: 'M', additions: 3, deletions: 1, hunk_headers: ['@@ -1,2 +1,3 @@'] }))
const resolveFor = (paths) => ({
  ok: true, mode: 'worktree', base_ref: 'main', head_ref: '(working tree)', nonce: NONCE,
  diff: 'diff --git a/x b/x\n@@ -1,1 +1,2 @@\n+changed\n',
  pr_title: '', pr_body: '', files_count: paths.length, additions: 3, deletions: 1,
  changed_files: filesFor(paths), note: 'resolved working tree vs main',
})
const oneCandidate = {
  threat_model: 'tm', hunks_reviewed: 1,
  candidates: [{ title: 'secrets piped to curl', file: '.github/workflows/ci.yml', line: 12, vuln_class: 'ci-secret-exfiltration', change_ref: '.github/workflows/ci.yml:+12', introduced: 'added', source: 'secrets.NPM_TOKEN', sink: 'curl', why: 'added step posts the token to an added host' }],
}
const verdict = {
  disposition: 'confirmed', severity: 'high', in_change_scope: true, reportable: true, rationale: 'traced',
  attacker_story: 'a', evidence: 'e', proof_gap: '', fix: 'f', cvss_vector: '',
}
const verifyOk = {
  outcome: 'verified',
  grounding: { file_exists: true, line_matches: true, root_cause_present: true, payload_reaches_sink: true, fix_closes_hole: true },
  revalidated: true, rationale: 'grounded', evidence: 'in the diff',
}
const severityHigh = {
  facts: { exposure: 'CI runner', identities: 'fork PR author -> repo secrets', reachability: 'on PR', controls: 'none', boundary_crossed: true },
  calibrated_severity: 'high', final_severity: 'high', policy_decision: 'keep', anti_pattern: '', cvss_vector: '', rationale: 'creds compound beyond the repo',
}

async function run({ paths, args = {} }) {
  const seen = { discover: [], severity: [], validate: [], verify: [] }
  const agent = async (prompt, opts = {}) => {
    const l = opts.label || ''
    if (l.startsWith('prior-bundle')) return { ok: false, content: '', note: 'none' }
    if (l === 'resolve') return resolveFor(paths)
    if (l.startsWith('discover:')) { seen.discover.push({ prompt, opts }); return oneCandidate }
    if (l.startsWith('validate:')) { seen.validate.push({ prompt, opts }); return verdict }
    if (l.startsWith('verify:')) { seen.verify.push({ prompt, opts }); return verifyOk }
    if (l.startsWith('severity:')) { seen.severity.push({ prompt, opts }); return severityHigh }
    if (l === 'report') return { output_dir: '/tmp/o', report_html_path: '/tmp/o/report.html', report_md: '# md', html_written: true }
    throw new Error('unexpected agent label: ' + l)
  }
  const parallel = (thunks) => Promise.all(thunks.map((t) => Promise.resolve().then(t).catch(() => null)))
  const logs = []
  const fn = new AsyncFunction('args', 'budget', 'agent', 'parallel', 'pipeline', 'phase', 'log', 'workflow',
    src.replace('export const meta', 'const meta'))
  const result = await fn({ target: '/tmp/fake', ...args }, undefined, agent, parallel, null, () => {}, (m) => logs.push(m), async () => { throw new Error('no compose') })
  return { result, seen, logs }
}

// Identify the DEDICATED CI worker by the lens sitting in its assigned-lens slot. A looser
// "mentions CI/CD pipeline-abuse" match would hit every worker, because the trust-boundary
// threat-model note (correctly) reaches all of them via CHANGE_BLOCK.
const LENS_MARK = /Your assigned threat-model LENS:\nCI\/CD pipeline-abuse lens \(apply this lens when/
const lensWorkers = (seen) => seen.discover.filter((d) => LENS_MARK.test(d.prompt))

test('a diff touching .github/workflows/** activates the lens as an extra discovery worker', async () => {
  const { result, seen } = await run({ paths: ['.github/workflows/release.yml', 'src/app.ts'] })
  assert.equal(result.cicd_lens.active, true, 'the lens reports itself active')
  assert.deepEqual(result.cicd_lens.files, ['.github/workflows/release.yml'], 'only the CI paths are listed as the trigger')
  assert.equal(lensWorkers(seen).length, 1, 'exactly one dedicated CI/CD-abuse discovery worker ran')
})

test('the activated lens carries every named abuse vector into the worker prompt', async () => {
  const { seen } = await run({ paths: ['.github/workflows/ci.yml'] })
  const p = lensWorkers(seen)[0].prompt
  for (const [re, label] of [
    [/workflow injection/i, 'workflow injection'],
    [/exfiltration/i, 'secret exfiltration'],
    [/self-hosted runner/i, 'self-hosted runner abuse'],
    [/pull_request_target/i, 'pwn requests'],
    [/workflow_run/i, 'workflow_run'],
    [/cache poisoning/i, 'cache poisoning'],
    [/id-token: ?write/i, 'OIDC permission widening'],
    [/unpinned/i, 'unpinned uses:'],
    [/Apache-2\.0/, 'Elastic provenance'],
  ]) assert.ok(re.test(p), `the CI/CD worker prompt must carry ${label}`)
})

test('a diff touching NO CI/CD config does not trigger the lens', async () => {
  const { result, seen } = await run({ paths: ['src/db.ts', 'README.md', 'package.json'] })
  assert.equal(result.cicd_lens.active, false, 'lens stays off for an app-code-only diff')
  assert.equal(lensWorkers(seen).length, 0, 'no CI/CD-abuse discovery worker is spawned')
  assert.equal(result.rounds, 5, 'worker count is unchanged (the default five lenses)')
})

test('the lens adds exactly one worker on top of the default five', async () => {
  const { result } = await run({ paths: ['.github/workflows/ci.yml'] })
  assert.equal(result.rounds, 6, 'five default lenses + one gated CI/CD lens')
})

test('GitLab, Azure, and other build/release automation paths also trigger it', async () => {
  for (const p of [
    '.gitlab-ci.yml', '.gitlab/ci/build.yml', 'azure-pipelines.yml', '.azure/deploy.yml',
    '.github/actions/setup/action.yml', 'Jenkinsfile', '.circleci/config.yml',
    'bitbucket-pipelines.yml', '.buildkite/pipeline.yml', '.drone.yml', 'appveyor.yml',
  ]) {
    const { result } = await run({ paths: [p, 'src/app.ts'] })
    assert.equal(result.cicd_lens.active, true, `${p} must be recognised as CI/CD config`)
    assert.deepEqual(result.cicd_lens.files, [p], `${p} must be the recorded trigger path`)
  }
})

test('look-alike paths that are NOT pipeline config stay out of the gate', async () => {
  for (const p of [
    'docs/github/workflows.md', 'src/gitlab-ci-parser.ts', 'tests/azure-pipelines.test.ts',
    '.github/ISSUE_TEMPLATE/bug.md', '.github/CODEOWNERS', 'src/jenkins/client.ts',
    // `.gitlab/**` also holds issue/MR templates — no more pipeline config than `.github/ISSUE_TEMPLATE/`.
    '.gitlab/issue_templates/bug.md', '.gitlab/merge_request_templates/default.md',
  ]) {
    const { result } = await run({ paths: [p] })
    assert.equal(result.cicd_lens.active, false, `${p} must NOT be treated as CI/CD pipeline config`)
  }
})

test('the lens stays DIFF-ANCHORED — its worker gets the same scope rule as every other', async () => {
  const { seen } = await run({ paths: ['.github/workflows/ci.yml'] })
  const p = lensWorkers(seen)[0].prompt
  assert.match(p, /SCOPE RULE \(critical\): review ONLY this change/, 'the CI worker is bound by the change-scope rule')
  assert.match(p, /TRACE TO A CHANGED HUNK/, 'every CI candidate must trace to a changed hunk')
  assert.ok(!/whole[- ]repo (ci|sweep|audit) of/i.test(p), 'it must not instruct a whole-repo CI sweep')
})

test('the CI/CD trust-boundary threat-model note reaches every reasoning stage when active', async () => {
  const { seen } = await run({ paths: ['.github/workflows/ci.yml'] })
  const NOTE = /CI\/CD config is itself a TRUST BOUNDARY/i
  for (const d of seen.discover) assert.match(d.prompt, NOTE, 'every discovery worker sees the trust-boundary note')
  for (const v of seen.validate) assert.match(v.prompt, NOTE, 'validators see it')
  for (const s of seen.severity) assert.match(s.prompt, NOTE, 'the severity stage sees it')
})

test('severity calibration gets the CI-secret-exfil = high/critical rule only when active', async () => {
  const RULE = /(secret exfiltration|runner-takeover)[^.\n]{0,80}(high|critical)/i
  const on = await run({ paths: ['.github/workflows/ci.yml'] })
  assert.ok(on.seen.severity.length > 0, 'the severity stage ran')
  for (const s of on.seen.severity) assert.match(s.prompt, RULE, 'CI exfil is calibrated high/critical')

  const off = await run({ paths: ['src/db.ts'] })
  assert.ok(off.seen.severity.length > 0, 'the severity stage ran on the non-CI diff too')
  for (const s of off.seen.severity) assert.ok(!RULE.test(s.prompt), 'no CI severity rule on a non-CI diff')
})

test('args.cicdLens forces the gate in both directions', async () => {
  const forcedOff = await run({ paths: ['.github/workflows/ci.yml'], args: { cicdLens: false } })
  assert.equal(forcedOff.result.cicd_lens.active, false, 'cicdLens:false suppresses it on a CI diff')
  assert.equal(forcedOff.result.cicd_lens.reason, 'forced-off', 'the override is recorded')
  assert.equal(lensWorkers(forcedOff.seen).length, 0, 'no CI worker spawned when forced off')

  const forcedOn = await run({ paths: ['src/db.ts'], args: { cicdLens: true } })
  assert.equal(forcedOn.result.cicd_lens.active, true, 'cicdLens:true forces it on a non-CI diff')
  assert.equal(forcedOn.result.cicd_lens.reason, 'forced-on', 'the override is recorded')
  assert.equal(lensWorkers(forcedOn.seen).length, 1, 'the CI worker spawns when forced on')
})

test('the CI/CD lens survives a custom args.lenses override (it is a gate, not a default lens)', async () => {
  const { result, seen } = await run({ paths: ['.github/workflows/ci.yml'], args: { lenses: ['only my lens'], rounds: 1 } })
  assert.equal(result.cicd_lens.active, true, 'a custom lens list does not disable the gated lens')
  assert.equal(lensWorkers(seen).length, 1, 'the CI worker still runs alongside the custom lens')
  assert.equal(result.rounds, 2, 'one custom lens + the gated CI lens')
})

test('activation is auditable: coverage surfaces + the run log say the lens fired', async () => {
  const { result, logs } = await run({ paths: ['.github/workflows/ci.yml'] })
  assert.equal(result.cicd_lens.reason, 'auto', 'path-gated activation is recorded as auto')
  const surfaces = result.bundle.coverage.reviewed_surfaces.join(' | ')
  assert.match(surfaces, /CI\/CD pipeline-abuse lens/i, 'the coverage doc records that the lens ran')
  assert.match(surfaces, /\.github\/workflows\/ci\.yml/, 'and which CI path triggered it')
  assert.ok(logs.some((m) => /CI\/CD pipeline-abuse lens/i.test(m)), 'the run log announces the activation')
})

let failed = 0
for (const [name, fn] of tests) {
  try { await fn(); console.log('PASS', name) }
  catch (e) { failed++; console.error('FAIL', name, '\n  ', e.message) }
}
console.log(failed ? `\n${failed}/${tests.length} FAILED` : `\nall ${tests.length} passed`)
process.exit(failed ? 1 : 0)
