// Offline simulator tests for ~/.claude/workflows/deep-security-scan.js.
// Stubs agent()/parallel()/phase()/log() so orchestration logic (dedup
// precedence, fail-open, chunked validation, coverage wiring) is testable in
// milliseconds with zero token spend.  Run:
//   node ~/.claude/workflows/tests/dss-sim.test.mjs
import { readFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
import { validateSarif } from './lib/sarif-2_1_0.mjs'

const SRC_PATH = new URL('../.claude/workflows/deep-security-scan.js', import.meta.url)
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

async function runScript({ args, stubs, budget }) {
  const src = (await readFile(SRC_PATH, 'utf8')).replace('export const meta', 'const meta')
  const calls = { phases: [], logs: [], agents: [] }
  let validateInFlight = 0
  let maxValidateInFlight = 0
  let verifyInFlight = 0
  let maxVerifyInFlight = 0
  const agent = async (prompt, opts = {}) => {
    calls.agents.push({ prompt, opts })
    if (opts.schema) assertSatisfiable(opts.schema, opts.label || '?')
    const isValidate = (opts.label || '').startsWith('validate:')
    const isVerify = (opts.label || '').startsWith('verify:')
    if (isValidate) { validateInFlight++; maxValidateInFlight = Math.max(maxValidateInFlight, validateInFlight) }
    if (isVerify) { verifyInFlight++; maxVerifyInFlight = Math.max(maxVerifyInFlight, verifyInFlight) }
    await new Promise((r) => setTimeout(r, 2)) // let concurrency overlap
    try { return await stubs(prompt, opts) } finally { if (isValidate) validateInFlight--; if (isVerify) verifyInFlight-- }
  }
  const parallel = (thunks) => Promise.all(thunks.map((t) => Promise.resolve().then(t).catch(() => null)))
  const phase = (t) => calls.phases.push(t)
  const log = (m) => calls.logs.push(m)
  const fn = new AsyncFunction('args', 'budget', 'agent', 'parallel', 'pipeline', 'phase', 'log', 'workflow', src)
  const result = await fn(args, budget, agent, parallel, null, phase, log, null)
  return { result, calls, maxValidateInFlight: () => maxValidateInFlight, maxVerifyInFlight: () => maxVerifyInFlight }
}

// ---- canned data ----
// NOTE: the validator no longer calibrates severity (split out into the Severity stage).
// severity/reportable here are legacy fields the new flow ignores — harmless to keep.
const verdict = {
  disposition: 'confirmed', severity: 'high', reportable: true, rationale: 'traced',
  attacker_story: 'a', evidence: 'e', proof_gap: '', fix: 'f', cvss_vector: '',
}
// Default Severity-stage verdict: facts justify HIGH and the policy pass keeps it.
const severityKeepHigh = {
  facts: { exposure: 'internet-facing', identities: 'anonymous -> user', reachability: 'direct from a route', controls: 'none primary', boundary_crossed: true },
  calibrated_severity: 'high', final_severity: 'high', policy_decision: 'keep', anti_pattern: '', cvss_vector: 'CVSS:3.1/AV:N', rationale: 'facts justify high',
}
// Severity verdict that DOWNGRADES a self-XSS from HIGH to LOW (anti-pattern: self-xss).
const severitySelfXss = {
  facts: { exposure: 'authenticated self only', identities: 'attacker == victim (same principal)', reachability: 'requires victim to paste into their own session', controls: 'session-scoped', boundary_crossed: false },
  calibrated_severity: 'high', final_severity: 'low', policy_decision: 'downgrade', anti_pattern: 'self-xss', cvss_vector: '', rationale: 'self-inflicted, no other principal harmed',
}
// Severity verdict that DROPS a theoretical-only memory-corruption finding.
const severityTheoreticalDrop = {
  facts: { exposure: 'internal', identities: 'n/a', reachability: 'no demonstrated reachable path', controls: 'n/a', boundary_crossed: false },
  calibrated_severity: 'info', final_severity: 'info', policy_decision: 'drop', anti_pattern: 'theoretical-memory-corruption', cvss_vector: '', rationale: 'no reachable path proven',
}
// Route a Severity-stage call to the right verdict by the CANDIDATE's class line only — NOT the
// whole prompt (the policy instructions themselves enumerate "self-xss", "theoretical
// memory-corruption", etc., so matching the full prompt would route everything to one bucket).
const severityByClass = (prompt) => {
  const cls = (prompt.match(/- class:\s*(\S+)/) || [])[1] || ''
  return /self-?xss/i.test(cls) ? severitySelfXss
    : /memory/i.test(cls) ? severityTheoreticalDrop
    : severityKeepHigh
}
const discoverySelfXssAndSqli = {
  threat_model: 'tm', files_reviewed: 4,
  candidates: [
    { title: 'self-xss via reflected debug echo', file: 'src/dbg.ts', line: 5, vuln_class: 'self-xss', source: 'own input', sink: 'innerHTML', why: 'user can xss their own session' },
    { title: 'possible sqli in db layer', file: 'src/db.ts', line: 42, vuln_class: 'sql-injection', source: 'user input', sink: 'db.raw', why: 'agent guess' },
  ],
}
const discoveryTwo = {
  threat_model: 'tm', files_reviewed: 5,
  candidates: [
    { title: 'possible sqli in db layer', file: 'src/db.ts', line: 42, vuln_class: 'sql-injection', source: 'user input', sink: 'db.raw', why: 'agent guess' },
    { title: 'idor on /api/items', file: 'src/api.ts', line: 10, vuln_class: 'idor', source: 'id param', sink: 'db.get', why: 'no owner check' },
  ],
}
const emptyDiscovery = { threat_model: 'tm', files_reviewed: 1, candidates: [] }
const toolOk = {
  ran: true, tool_version: '0.8.1', files_scanned: 12, note: 'ok',
  candidates: [
    // line 40 lands in the same dedup bucket as the agent's line 42 (round(40/8)=round(42/8)=5)
    { title: 'SQL injection via raw query', file: 'src/db.ts', line: 40, vuln_class: 'sql-injection', source: 'foxguard:rs-sqli-001', sink: 'db.raw', why: 'tool match' },
  ],
}
const toolMissing = { ran: false, tool_version: '', files_scanned: 0, note: 'foxguard not installed', candidates: [] }
const toolOkNoCount = { ...toolOk, files_scanned: 0 }

// ---- canned factual-verification verdicts (Verify phase grounds each reportable finding) ----
const verifyOk = {
  outcome: 'verified',
  grounding: { file_exists: true, line_matches: true, root_cause_present: true, payload_reaches_sink: true, fix_closes_hole: true },
  revalidated: true, rationale: 'every cited fact checks out against the source', evidence: 'lines match the described sink',
}
const verifyCorrected = {
  outcome: 'corrected',
  grounding: { file_exists: true, line_matches: false, root_cause_present: true, payload_reaches_sink: true, fix_closes_hole: true },
  corrected_fields: { line: 99 },
  revalidated: true, rationale: 'line was off; re-traced the corrected source->sink, still holds', evidence: 'real sink at line 99',
}
const verifyRejected = {
  outcome: 'rejected',
  grounding: { file_exists: true, line_matches: false, root_cause_present: false, payload_reaches_sink: false, fix_closes_hole: false },
  revalidated: false, rationale: 'cited sink does not exist at that location — confidently-wrong citation', evidence: 'no such call in the file',
}

function stubsFor(map) {
  return (prompt, opts) => {
    const l = opts.label || ''
    if (l.startsWith('prior-bundle')) { map.sawPriorLoader = true; map.priorLoaderPrompt = prompt; return map.priorLoaded ?? { ok: false, content: '', note: 'no stub' } }
    if (l.startsWith('tools:')) { map.sawTool = true; return map.tool }
    if (l.startsWith('discover:')) return map.discovery(prompt, opts)
    if (l.startsWith('validate:')) { (map.validatePrompts ||= []).push(prompt); return map.verdict ?? verdict }
    if (l.startsWith('verify:')) {
      ;(map.verifyPrompts ||= []).push(prompt)
      ;(map.verifyOpts ||= []).push(opts)
      if (typeof map.verify === 'function') return map.verify(prompt)
      if ('verify' in map) return map.verify // explicit value (incl. null = agent died)
      return verifyOk
    }
    if (l.startsWith('severity:')) {
      (map.severityPrompts ||= []).push(prompt); (map.severityOpts ||= []).push(opts)
      if ('severity' in map) return typeof map.severity === 'function' ? map.severity(prompt, opts) : map.severity
      return severityKeepHigh
    }
    if (l === 'report') {
      map.reportPrompt = prompt; map.reportOpts = opts
      // 'report' in map lets a test force an explicit null (agent-died case); otherwise default.
      if ('report' in map) return map.report
      return {
        output_dir: '/tmp/x/.security-scans/T-deep',
        report_html_path: '/tmp/x/.security-scans/T-deep/report.html',
        report_md: '# Deep Security Audit — merged md\n\ncoverage + findings here',
        html_written: true,
      }
    }
    throw new Error('unexpected agent label: ' + l)
  }
}

const tests = []
const test = (name, fn) => tests.push([name, fn])

// ================= BASELINE (must pass before AND after the v2 edits) =================

test('baseline: schemas used during a run are satisfiable', async () => {
  const map = { tool: toolMissing, discovery: () => discoveryTwo }
  await runScript({ args: { target: '/tmp/fake', rounds: 2 }, stubs: stubsFor(map) })
  // assertSatisfiable throws inside agent() if any schema is broken
})

test('baseline: identical candidates from multiple workers dedup to one', async () => {
  const map = { tool: toolMissing, discovery: () => discoveryTwo }
  const { result } = await runScript({ args: { target: '/tmp/fake', rounds: 3 }, stubs: stubsFor(map) })
  assert.equal(result.candidates, 2, `expected 2 unique candidates, got ${result.candidates}`)
})

test('baseline: zero candidates -> early return with note, no report agent', async () => {
  const map = { tool: toolMissing, discovery: () => emptyDiscovery }
  const { result, calls } = await runScript({ args: { target: '/tmp/fake', rounds: 2 }, stubs: stubsFor(map) })
  assert.ok(result.note, 'early return should carry a note')
  assert.ok(!calls.agents.some((a) => a.opts.label === 'report'), 'report agent must not run')
})

test('baseline: reportable + appendix accounts for every unique candidate', async () => {
  const map = { tool: toolMissing, discovery: () => discoveryTwo }
  const { result } = await runScript({ args: { target: '/tmp/fake', rounds: 2 }, stubs: stubsFor(map) })
  assert.equal(result.reportable.length + result.appendix_count, result.candidates)
})

// ================= V2 BEHAVIOR (added in Task 3; FAIL until Task 4 implements) =================

test('v2: tool candidates win dedup ties (foxguard source survives the merge)', async () => {
  const map = { tool: toolOk, discovery: () => discoveryTwo }
  const { result } = await runScript({ args: { target: '/tmp/fake', rounds: 2 }, stubs: stubsFor(map) })
  assert.ok(map.sawTool, 'Phase 0 tools agent must run by default')
  assert.equal(result.candidates, 2, 'tool sqli + agent sqli collapse; idor stays')
  const sqli = result.reportable.find((c) => c.vuln_class === 'sql-injection')
  assert.ok(sqli, 'sqli finding present')
  assert.equal(sqli.source, 'foxguard:rs-sqli-001', 'deterministic finding must win the dedup tie')
})

test('v2: discovery lenses are re-aimed only when the tool ran', async () => {
  const calls1 = []
  const map1 = { tool: toolOk, discovery: (p) => { calls1.push(p); return discoveryTwo } }
  await runScript({ args: { target: '/tmp/fake', rounds: 2 }, stubs: stubsFor(map1) })
  assert.ok(calls1.length > 0 && calls1.every((p) => p.includes('already swept')), 'lens prompts must carry the re-aim note when tool ran')
  const calls2 = []
  const map2 = { tool: toolMissing, discovery: (p) => { calls2.push(p); return discoveryTwo } }
  await runScript({ args: { target: '/tmp/fake', rounds: 2 }, stubs: stubsFor(map2) })
  assert.ok(calls2.length > 0 && calls2.every((p) => !p.includes('already swept')), 'no re-aim note when tool skipped')
})

test('v2: fail-open — tool missing still produces a full agentic run + SKIPPED coverage', async () => {
  const map = { tool: toolMissing, discovery: () => discoveryTwo }
  const { result } = await runScript({ args: { target: '/tmp/fake', rounds: 2 }, stubs: stubsFor(map) })
  assert.equal(result.candidates, 2)
  assert.ok(map.reportPrompt.includes('SKIPPED'), 'report coverage must record the skip')
  assert.ok(map.reportPrompt.includes('foxguard not installed'), 'and the reason')
})

test('v2: report coverage names tool version and ingested count when it ran', async () => {
  const map = { tool: toolOk, discovery: () => discoveryTwo }
  await runScript({ args: { target: '/tmp/fake', rounds: 2 }, stubs: stubsFor(map) })
  assert.ok(map.reportPrompt.includes('foxguard 0.8.1'), 'tool version in coverage facts')
  assert.ok(map.reportPrompt.includes('12 files scanned'), 'real scan count rendered when > 0')
})

test('v2: coverage does not misreport "~0 files scanned" when the tool gives no count', async () => {
  const map = { tool: toolOkNoCount, discovery: () => discoveryTwo }
  await runScript({ args: { target: '/tmp/fake', rounds: 2 }, stubs: stubsFor(map) })
  assert.ok(!/~?0 files scanned/.test(map.reportPrompt), 'must not read as scanned-nothing')
  assert.ok(map.reportPrompt.includes('files-scanned count not reported by tool'), 'honest fallback wording present')
})

test('v2: args.tools=[] disables Phase 0 entirely', async () => {
  const map = { tool: toolOk, discovery: () => discoveryTwo }
  const { calls } = await runScript({ args: { target: '/tmp/fake', rounds: 2, tools: [] }, stubs: stubsFor(map) })
  assert.ok(!map.sawTool && !calls.agents.some((a) => (a.opts.label || '').startsWith('tools:')), 'no tools agent when disabled')
  assert.ok(map.reportPrompt.includes('disabled'), 'coverage records that the prefilter was disabled')
})

test('v2: validation runs in chunks of <=8 concurrent validators', async () => {
  const many = {
    threat_model: 'tm', files_reviewed: 5,
    candidates: Array.from({ length: 20 }, (_, i) => ({
      title: `finding ${i}`, file: `src/f${i}.ts`, line: 10, vuln_class: 'xss', source: 's', sink: 'k', why: 'w',
    })),
  }
  const map = { tool: toolMissing, discovery: () => many }
  const { maxValidateInFlight } = await runScript({ args: { target: '/tmp/fake', rounds: 1 }, stubs: stubsFor(map) })
  assert.ok(maxValidateInFlight() <= 8, `max concurrent validators was ${maxValidateInFlight()}, want <=8`)
})

test('v2: validator prompt is trace-only with >80% confidence floor', async () => {
  const prompts = []
  const map = { tool: toolMissing, discovery: () => discoveryTwo, verdict }
  const baseStubs = stubsFor(map)
  const stubs = (p, o) => { if ((o.label || '').startsWith('validate:')) prompts.push(p); return baseStubs(p, o) }
  await runScript({ args: { target: '/tmp/fake', rounds: 1 }, stubs })
  assert.ok(prompts.length > 0)
  assert.ok(prompts.every((p) => p.includes('do NOT build')), 'trace-only rule present')
  assert.ok(prompts.every((p) => p.includes('80%')), 'confidence floor present')
})

// ================= REPORT-MD HARDENING (workflow-subagent guardrail) =================
// The workflow runtime blocks subagents from WRITING report.md ("return findings as text,
// not write report files") while allowing report.html. The report agent must return the
// markdown as STRUCTURED text and the orchestrator must surface it for the caller to persist.

test('v2: report agent uses a satisfiable schema capturing report_md + paths', async () => {
  const map = { tool: toolMissing, discovery: () => discoveryTwo }
  await runScript({ args: { target: '/tmp/fake', rounds: 2 }, stubs: stubsFor(map) })
  assert.ok(map.reportOpts && map.reportOpts.schema, 'report agent uses structured output')
  const req = map.reportOpts.schema.required || []
  for (const k of ['output_dir', 'report_html_path', 'report_md']) {
    assert.ok(req.includes(k), `report schema requires ${k}`)
    assert.ok(map.reportOpts.schema.properties[k], `report schema defines ${k}`)
  }
})

test('v2: orchestrator surfaces report_dir / report_html / report_md from the structured result', async () => {
  const map = {
    tool: toolMissing, discovery: () => discoveryTwo,
    report: {
      output_dir: '/repo/.security-scans/Z-deep',
      report_html_path: '/repo/.security-scans/Z-deep/report.html',
      report_md: '# deep report\n\n## Coverage\nfoxguard...',
      html_written: true,
    },
  }
  const { result } = await runScript({ args: { target: '/repo', rounds: 2 }, stubs: stubsFor(map) })
  assert.equal(result.report_dir, '/repo/.security-scans/Z-deep', 'report_dir surfaced')
  assert.equal(result.report_html, '/repo/.security-scans/Z-deep/report.html', 'report_html surfaced')
  assert.ok(result.report_md && result.report_md.includes('# deep report'), 'report_md surfaced for the caller')
})

test('v2: existing return contract preserved (reportable / appendix_count / counts / tool_coverage)', async () => {
  const map = { tool: toolMissing, discovery: () => discoveryTwo }
  const { result } = await runScript({ args: { target: '/tmp/fake', rounds: 2 }, stubs: stubsFor(map) })
  assert.ok(Array.isArray(result.reportable), 'reportable still an array')
  assert.equal(typeof result.appendix_count, 'number', 'appendix_count still a number')
  assert.ok(result.counts && typeof result.counts === 'object', 'counts still present')
  assert.ok(typeof result.tool_coverage === 'string', 'tool_coverage still present')
  assert.equal(result.reportable.length + result.appendix_count, result.candidates, 'invariant intact')
})

test('v2: report prompt — do NOT write report.md, return it as text, embed base64 in html', async () => {
  const map = { tool: toolMissing, discovery: () => discoveryTwo }
  await runScript({ args: { target: '/tmp/fake', rounds: 2 }, stubs: stubsFor(map) })
  assert.ok(/do NOT write report\.md/i.test(map.reportPrompt), 'aligns with guardrail, does not fight it')
  assert.ok(map.reportPrompt.includes('report_md'), 'returns markdown in report_md')
  assert.ok(/base64/i.test(map.reportPrompt), 'embeds markdown base64 (no breakout)')
  assert.ok(map.reportPrompt.includes('Download report.md'), 'html carries a download affordance')
})

// ============= SEALED FINGERPRINTED BUNDLE + COVERAGE SCHEMA + SARIF (issue #21) =============
// A persisted, content-addressed findings artifact alongside the HTML+md report: each finding
// carries a stable fingerprint (file + class + normalized root-cause — NOT line numbers), and a
// coverage doc carries a schema-level completeness + explicit exclusions. Unlocks cross-run
// incremental dedup (args.priorBundle) and a SARIF 2.1.0 projection for external-tool interop.

test('bundle: emits a sealed manifest/findings/coverage doc for persistence', async () => {
  const map = { tool: toolMissing, discovery: () => discoveryTwo }
  const { result } = await runScript({ args: { target: '/tmp/fake', rounds: 2 }, stubs: stubsFor(map) })
  const b = result.bundle
  assert.ok(b, 'a bundle is returned for the caller to persist')
  assert.ok(typeof b.schema_version === 'string' && /security-bundle/.test(b.schema_version), 'bundle carries a schema_version')
  assert.ok(b.manifest && b.manifest.tool === 'deep-security-scan', 'manifest names the tool')
  assert.ok(Array.isArray(b.findings) && b.findings.length === 2, 'findings doc holds the confirmed findings')
  assert.ok(b.coverage && typeof b.coverage === 'object', 'coverage doc present')
})

test('bundle: every finding carries a stable, content-addressed fingerprint', async () => {
  const a = await runScript({ args: { target: '/tmp/fake', rounds: 2 }, stubs: stubsFor({ tool: toolMissing, discovery: () => discoveryTwo }) })
  const b = await runScript({ args: { target: '/tmp/fake', rounds: 2 }, stubs: stubsFor({ tool: toolMissing, discovery: () => discoveryTwo }) })
  const fpsA = a.result.bundle.findings.map((f) => f.fingerprint)
  const fpsB = b.result.bundle.findings.map((f) => f.fingerprint)
  assert.ok(fpsA.every((fp) => typeof fp === 'string' && fp.length > 0), 'fingerprints are non-empty strings')
  assert.deepEqual([...fpsA].sort(), [...fpsB].sort(), 'same findings -> identical fingerprints across runs (stable)')
})

test('fingerprints are line-independent (line drift does not change the id)', async () => {
  const drifted = {
    threat_model: 'tm', files_reviewed: 5,
    candidates: discoveryTwo.candidates.map((c) => ({ ...c, line: c.line + 957 })), // same issue, drifted lines
  }
  const r1 = await runScript({ args: { target: '/tmp/fake', rounds: 1 }, stubs: stubsFor({ tool: toolMissing, discovery: () => discoveryTwo }) })
  const r2 = await runScript({ args: { target: '/tmp/fake', rounds: 1 }, stubs: stubsFor({ tool: toolMissing, discovery: () => drifted }) })
  const fp = (r) => r.result.bundle.findings.find((f) => f.vuln_class === 'sql-injection').fingerprint
  assert.equal(fp(r1), fp(r2), 'fingerprint must not depend on line number (lines drift)')
})

test('coverage doc carries completeness + distinguishes "not observed" from "not scanned"', async () => {
  const map = { tool: toolMissing, discovery: () => discoveryTwo }
  const { result } = await runScript({ args: { target: '/tmp/fake', rounds: 2 }, stubs: stubsFor(map) })
  const c = result.bundle.coverage
  assert.ok(['complete', 'partial', 'unknown'].includes(c.completeness), 'schema-level completeness enum')
  assert.ok(Array.isArray(c.reviewed_surfaces), 'reviewed_surfaces present')
  assert.ok(Array.isArray(c.not_observed), 'not_observed (looked-for, none confirmed) present')
  assert.ok(Array.isArray(c.exclusions), 'exclusions (NOT scanned) present')
  assert.ok(c.not_observed.length > 0, 'classes reviewed-but-not-confirmed are listed as not-observed')
  assert.notDeepEqual(c.not_observed, c.exclusions, '"not observed" and "not scanned" are distinct fields')
})

test('sarif: the findings doc projects to a valid SARIF 2.1.0 log carrying fingerprints', async () => {
  const map = { tool: toolMissing, discovery: () => discoveryTwo }
  const { result } = await runScript({ args: { target: '/tmp/fake', rounds: 2 }, stubs: stubsFor(map) })
  const v = validateSarif(result.sarif)
  assert.ok(v.valid, `SARIF projection must validate against 2.1.0; errors: ${v.errors.join('; ')}`)
  const fps = new Set(result.bundle.findings.map((f) => f.fingerprint))
  assert.equal(result.sarif.runs[0].results.length, 2, 'one SARIF result per finding')
  for (const res of result.sarif.runs[0].results) {
    const fp = res.partialFingerprints && res.partialFingerprints['shipFingerprint/v1']
    assert.ok(fps.has(fp), 'every SARIF result carries a bundle fingerprint in partialFingerprints')
  }
})

test('sarif: a zero-finding run still projects to a valid (empty-results) SARIF log', async () => {
  const map = { tool: toolMissing, discovery: () => emptyDiscovery }
  const { result } = await runScript({ args: { target: '/tmp/fake', rounds: 2 }, stubs: stubsFor(map) })
  assert.ok(result.bundle && Array.isArray(result.bundle.findings) && result.bundle.findings.length === 0, 'empty findings doc')
  const v = validateSarif(result.sarif)
  assert.ok(v.valid, `empty SARIF must still validate; errors: ${v.errors.join('; ')}`)
})

test('priorBundle absent: no delta, no is_new, no loader agent (full run, no behavior change)', async () => {
  const map = { tool: toolMissing, discovery: () => discoveryTwo }
  const { result, calls } = await runScript({ args: { target: '/tmp/fake', rounds: 2 }, stubs: stubsFor(map) })
  assert.ok(result.bundle.coverage.delta == null, 'no delta without a prior bundle')
  assert.ok(result.bundle.findings.every((f) => !('is_new' in f)), 'no is_new tag without a baseline')
  assert.ok(result.new_findings == null, 'new_findings absent without a baseline')
  assert.ok(!calls.agents.some((a) => (a.opts.label || '').startsWith('prior-bundle')), 'no prior-bundle loader agent when none provided')
})

test('priorBundle (object): an identical re-run carries everything over, surfaces nothing new, reports a delta', async () => {
  const first = await runScript({ args: { target: '/tmp/fake', rounds: 2 }, stubs: stubsFor({ tool: toolMissing, discovery: () => discoveryTwo }) })
  const prior = first.result.bundle // feed the previous bundle back in
  const { result } = await runScript({ args: { target: '/tmp/fake', rounds: 2, priorBundle: prior }, stubs: stubsFor({ tool: toolMissing, discovery: () => discoveryTwo }) })
  const b = result.bundle
  assert.ok(b.findings.every((f) => f.is_new === false), 'identical re-run: every finding is carried-over (none new)')
  assert.equal(result.new_findings.length, 0, 'surfaces ONLY new findings -> none on an identical re-run')
  assert.ok(b.coverage.delta, 'coverage reports a delta vs the prior run')
  assert.equal(b.coverage.delta.new, 0)
  assert.equal(b.coverage.delta.carried_over, 2)
  assert.equal(b.coverage.delta.prior_total, 2)
})

test('priorBundle: only the fingerprint absent from the prior bundle is surfaced as new', async () => {
  // Prior run knew only the idor; the sqli is new this run.
  const onlyIdor = await runScript({ args: { target: '/tmp/fake', rounds: 1 }, stubs: stubsFor({ tool: toolMissing, discovery: () => ({ threat_model: 't', files_reviewed: 1, candidates: [discoveryTwo.candidates[1]] }) }) })
  const prior = onlyIdor.result.bundle
  assert.equal(prior.findings.length, 1, 'prior bundle has exactly the idor')
  const { result } = await runScript({ args: { target: '/tmp/fake', rounds: 2, priorBundle: prior }, stubs: stubsFor({ tool: toolMissing, discovery: () => discoveryTwo }) })
  assert.equal(result.new_findings.length, 1, 'only the fingerprint absent from prior is surfaced as new')
  assert.equal(result.new_findings[0].vuln_class, 'sql-injection', 'the sqli is the new one')
  assert.equal(result.bundle.coverage.delta.new, 1)
  assert.equal(result.bundle.coverage.delta.carried_over, 1)
})

test('priorBundle as a JSON string is parsed inline (no loader agent needed)', async () => {
  const first = await runScript({ args: { target: '/tmp/fake', rounds: 2 }, stubs: stubsFor({ tool: toolMissing, discovery: () => discoveryTwo }) })
  const priorStr = JSON.stringify(first.result.bundle)
  const { result, calls } = await runScript({ args: { target: '/tmp/fake', rounds: 2, priorBundle: priorStr }, stubs: stubsFor({ tool: toolMissing, discovery: () => discoveryTwo }) })
  assert.ok(result.bundle.coverage.delta, 'JSON-string prior bundle still yields a delta')
  assert.equal(result.bundle.coverage.delta.carried_over, 2)
  assert.ok(!calls.agents.some((a) => (a.opts.label || '').startsWith('prior-bundle')), 'no loader agent for an inline JSON prior bundle')
})

test('priorBundle as a path triggers a read-only loader relay; load failure is fail-open', async () => {
  // Loader stub returns ok:false -> the run must proceed as a full (no-prior) run, not crash.
  const map = { tool: toolMissing, discovery: () => discoveryTwo, priorLoaded: { ok: false, content: '', note: 'file not found' } }
  const { result } = await runScript({ args: { target: '/tmp/fake', rounds: 2, priorBundle: '/tmp/prior/bundle.json' }, stubs: stubsFor(map) })
  assert.ok(map.sawPriorLoader, 'a path prior bundle is loaded via a read-only relay agent')
  assert.ok(/cat|read/i.test(map.priorLoaderPrompt) && map.priorLoaderPrompt.includes('/tmp/prior/bundle.json'), 'loader relay reads the given path')
  assert.ok(result.bundle.coverage.delta == null, 'a failed load is fail-open: full run, no delta (never fatal)')
  assert.equal(result.candidates, 2, 'the scan still completes normally')
})

test('priorBundle path: a successful load dedups by fingerprint', async () => {
  const seed = await runScript({ args: { target: '/tmp/fake', rounds: 2 }, stubs: stubsFor({ tool: toolMissing, discovery: () => discoveryTwo }) })
  const map = { tool: toolMissing, discovery: () => discoveryTwo, priorLoaded: { ok: true, content: JSON.stringify(seed.result.bundle), note: 'ok' } }
  const { result } = await runScript({ args: { target: '/tmp/fake', rounds: 2, priorBundle: '/tmp/prior/bundle.json' }, stubs: stubsFor(map) })
  assert.ok(map.sawPriorLoader, 'loader ran')
  assert.equal(result.new_findings.length, 0, 'loaded prior bundle dedups the re-run')
  assert.equal(result.bundle.coverage.delta.carried_over, 2)
})

test('report prompt carries the bundle + SARIF for base64 embedding, and the delta when incremental', async () => {
  const first = await runScript({ args: { target: '/tmp/fake', rounds: 2 }, stubs: stubsFor({ tool: toolMissing, discovery: () => discoveryTwo }) })
  const map = { tool: toolMissing, discovery: () => discoveryTwo }
  await runScript({ args: { target: '/tmp/fake', rounds: 2, priorBundle: first.result.bundle }, stubs: stubsFor(map) })
  assert.ok(/bundle\.json/i.test(map.reportPrompt), 'report embeds the machine-readable bundle')
  assert.ok(/sarif/i.test(map.reportPrompt), 'report embeds the SARIF projection')
  assert.ok(/fingerprint/i.test(map.reportPrompt), 'report explains the fingerprints')
  assert.ok(/delta/i.test(map.reportPrompt) && /new finding/i.test(map.reportPrompt), 'incremental run leads with new findings + delta')
})

// ================= VERIFY (independent factual-grounding gate: after Validate, before Report) =================
// Distinct from the disprove-first validator: validation asks "is it exploitable?", verification
// asks "is this finding factually true about the code?" — grounding file/line/root-cause/payload/fix.

test('verify: one Verify agent grounds each reportable finding, AFTER Validate and BEFORE Report', async () => {
  const map = { tool: toolMissing, discovery: () => discoveryTwo }
  const { result, calls } = await runScript({ args: { target: '/tmp/fake', rounds: 2 }, stubs: stubsFor(map) })
  const verifyCalls = calls.agents.filter((a) => (a.opts.label || '').startsWith('verify:'))
  assert.equal(verifyCalls.length, result.reportable.length, 'one verify agent per reportable finding')
  assert.ok(calls.phases.indexOf('Verify') > calls.phases.indexOf('Validate'), 'Verify runs after Validate')
  assert.ok(calls.phases.indexOf('Report') > calls.phases.indexOf('Verify'), 'Verify runs before Report')
})

test('verify: schema returns verified|corrected|rejected with per-fact grounding evidence', async () => {
  const map = { tool: toolMissing, discovery: () => discoveryTwo }
  await runScript({ args: { target: '/tmp/fake', rounds: 1 }, stubs: stubsFor(map) })
  assert.ok(map.verifyOpts && map.verifyOpts[0] && map.verifyOpts[0].schema, 'verify agent uses structured output')
  const schema = map.verifyOpts[0].schema
  assert.deepEqual(schema.properties.outcome.enum, ['verified', 'corrected', 'rejected'], 'outcome trichotomy')
  const g = schema.properties.grounding.properties
  for (const k of ['file_exists', 'line_matches', 'root_cause_present', 'payload_reaches_sink', 'fix_closes_hole']) {
    assert.ok(g[k], `grounding schema checks ${k}`)
  }
})

test('verify: a verified finding is reported as-is in the reconciled set, carrying its grounding verdict', async () => {
  const map = { tool: toolMissing, discovery: () => discoveryTwo, verify: verifyOk }
  const { result } = await runScript({ args: { target: '/tmp/fake', rounds: 1 }, stubs: stubsFor(map) })
  assert.equal(result.reportable.length, 2, 'both verified findings stay reportable')
  assert.ok(result.reportable.every((f) => f.verify && f.verify.outcome === 'verified'), 'each reportable finding carries its grounding verdict')
})

test('verify: a non-existent sink is REJECTED — dropped from reportable, kept in the appendix (invariant intact)', async () => {
  const map = {
    tool: toolMissing, discovery: () => discoveryTwo,
    verify: (p) => (p.includes('sqli') ? verifyRejected : verifyOk),
  }
  const { result } = await runScript({ args: { target: '/tmp/fake', rounds: 1 }, stubs: stubsFor(map) })
  assert.ok(!result.reportable.some((f) => f.vuln_class === 'sql-injection'), 'the factually-wrong finding is NOT reported as-is')
  assert.equal(result.reportable.length, 1, 'only the grounded finding remains reportable')
  assert.equal(result.reportable.length + result.appendix_count, result.candidates, 'rejected moved to appendix — no candidate lost')
})

test('verify: a wrong-line finding is CORRECTED — reported with patched fields, re-validated, not as-is', async () => {
  const corrected = { ...verifyCorrected, corrected_fields: { line: 99, sink: 'db.exec' } }
  const map = {
    tool: toolMissing, discovery: () => discoveryTwo,
    verify: (p) => (p.includes('sqli') ? corrected : verifyOk),
  }
  const { result } = await runScript({ args: { target: '/tmp/fake', rounds: 1 }, stubs: stubsFor(map) })
  const sqli = result.reportable.find((f) => f.vuln_class === 'sql-injection')
  assert.ok(sqli, 'corrected finding is still reported (real vuln, fixed citation)')
  assert.equal(sqli.line, 99, 'the corrected line overwrites the original')
  assert.equal(sqli.sink, 'db.exec', 'the corrected sink overwrites the original')
  assert.equal(sqli.verify.outcome, 'corrected', 'the correction is auditable on the finding')
  assert.ok(sqli.verify.revalidated, 'corrected fields were re-validated, not just edited')
})

test('verify: prompt grounds facts (file/line/root-cause/sink/fix), trace-only, with mandatory re-validation', async () => {
  const map = { tool: toolMissing, discovery: () => discoveryTwo }
  await runScript({ args: { target: '/tmp/fake', rounds: 1 }, stubs: stubsFor(map) })
  const prompts = map.verifyPrompts || []
  assert.ok(prompts.length > 0)
  assert.ok(prompts.every((p) => /do NOT build/i.test(p)), 'trace-only / read-only posture')
  assert.ok(prompts.every((p) => /factual/i.test(p)), 'grounds facts, not exploitability')
  assert.ok(prompts.every((p) => /re-?validate|re-?trace/i.test(p)), 'corrected must be re-validated')
  for (const fact of ['file', 'line', 'root cause', 'sink', 'fix']) {
    assert.ok(prompts.every((p) => p.toLowerCase().includes(fact)), `grounds the ${fact}`)
  }
})

test('verify: is distinct from the exploitability validator — it does not re-decide exploitability', async () => {
  const map = { tool: toolMissing, discovery: () => discoveryTwo }
  await runScript({ args: { target: '/tmp/fake', rounds: 1 }, stubs: stubsFor(map) })
  const prompts = map.verifyPrompts || []
  assert.ok(prompts.length > 0)
  assert.ok(prompts.every((p) => /NOT the exploitability validator|already (judged|validated)/i.test(p)), 'verify grounds facts; exploitability was decided in Validate')
})

test('verify: runs in chunks of <=8 concurrent verifiers', async () => {
  const many = {
    threat_model: 'tm', files_reviewed: 5,
    candidates: Array.from({ length: 20 }, (_, i) => ({
      title: `finding ${i}`, file: `src/f${i}.ts`, line: 10, vuln_class: 'xss', source: 's', sink: 'k', why: 'w',
    })),
  }
  const map = { tool: toolMissing, discovery: () => many }
  const { maxVerifyInFlight } = await runScript({ args: { target: '/tmp/fake', rounds: 1 }, stubs: stubsFor(map) })
  assert.ok(maxVerifyInFlight() <= 8, `max concurrent verifiers was ${maxVerifyInFlight()}, want <=8`)
})

test('verify: report consumes the reconciled set; rejected appears in the appendix with a verification reason', async () => {
  const map = {
    tool: toolMissing, discovery: () => discoveryTwo,
    verify: (p) => (p.includes('idor') ? verifyRejected : verifyOk),
  }
  await runScript({ args: { target: '/tmp/fake', rounds: 1 }, stubs: stubsFor(map) })
  assert.ok(/idor on \/api\/items/.test(map.reportPrompt), 'rejected finding visible in the report appendix input')
  assert.ok(/verification-rejected/i.test(map.reportPrompt), 'tagged verification-rejected so suppression is auditable')
})

test('verify: report prompt states the findings are factually grounded and corrected items are an audit trail', async () => {
  const map = { tool: toolMissing, discovery: () => discoveryTwo }
  await runScript({ args: { target: '/tmp/fake', rounds: 2 }, stubs: stubsFor(map) })
  assert.ok(/factual/i.test(map.reportPrompt) && /verif/i.test(map.reportPrompt), 'report told the findings are factually grounded')
  assert.ok(/corrected/i.test(map.reportPrompt), 'report told to note corrected findings (audit trail)')
})

test('verify: additive return key verify_counts tallies verified/corrected/rejected', async () => {
  const map = {
    tool: toolMissing, discovery: () => discoveryTwo,
    verify: (p) => (p.includes('sqli') ? verifyRejected : verifyOk),
  }
  const { result } = await runScript({ args: { target: '/tmp/fake', rounds: 1 }, stubs: stubsFor(map) })
  assert.ok(result.verify_counts, 'verify_counts present (additive return key)')
  assert.equal(result.verify_counts.rejected, 1, 'one rejected')
  assert.equal(result.verify_counts.verified, 1, 'one verified')
})

test('verify: fail-safe — a dead verify agent keeps the finding reportable (flagged unverified), never silently dropped', async () => {
  const map = { tool: toolMissing, discovery: () => discoveryTwo, verify: null }
  const { result } = await runScript({ args: { target: '/tmp/fake', rounds: 1 }, stubs: stubsFor(map) })
  assert.equal(result.reportable.length, 2, 'a verify agent that dies must not suppress a real finding')
  assert.ok(result.reportable.every((f) => f.verify && f.verify.outcome === 'unverified'), 'flagged unverified for transparency')
})

// ============== RICHER PER-CLASS LENSES + BUSINESS-LOGIC / WILDCARD (issue #25) ==============
// The default lens set deepens to 5 (the 4 standard lenses + a business-logic / feature-abuse /
// chaining lens), each lens carries class-specific hunt checklists, and the generalist
// fresh-pass builder makes its first pass an explicit "wildcard / creative" angle.

test('#25: default lens set is 5 and carries a business-logic / feature-abuse / chaining lens', async () => {
  const prompts = []
  const map = { tool: toolMissing, discovery: (p) => { prompts.push(p); return discoveryTwo } }
  await runScript({ args: { target: '/tmp/fake', maxRounds: 1 }, stubs: stubsFor(map) }) // one round -> the default per-round lens set
  assert.equal(prompts.length, 5, `default run should fan out 5 named lenses per round, got ${prompts.length}`)
  const bl = prompts.find((p) => /business[- ]logic/i.test(p) && /feature[- ]abuse/i.test(p) && /chain/i.test(p))
  assert.ok(bl, 'a business-logic / feature-abuse / chaining lens runs by default')
})

test('#25: lenses carry class-specific hunt checklists for the named high-miss classes', async () => {
  const prompts = []
  const map = { tool: toolMissing, discovery: (p) => { prompts.push(p); return discoveryTwo } }
  await runScript({ args: { target: '/tmp/fake' }, stubs: stubsFor(map) })
  const all = prompts.join('\n---\n')
  assert.match(all, /deserializ/i, 'deserialization checklist present')
  assert.match(all, /pickle|ObjectInputStream|Marshal|BinaryFormatter|TypeNameHandling/i, 'names concrete deserialization codecs')
  assert.match(all, /SAML|SSO|assertion/i, 'SAML/SSO assertion-selection checklist present')
  assert.match(all, /zip[- ]?slip|archive|tar/i, 'archive-member path-traversal checklist present')
  assert.match(all, /169\.254\.169\.254|metadata|link-local|destination class/i, 'SSRF destination-classes checklist present')
  assert.match(all, /shell|argv|argument/i, 'command-runner argument-type checklist present')
  assert.match(all, /XXE|external entit|DTD/i, 'XXE feature-setup checklist present')
})

test('#25: a wildcard / creative generalist pass is produced beyond the named lenses', async () => {
  const prompts = []
  const map = { tool: toolMissing, discovery: (p) => { prompts.push(p); return discoveryTwo } }
  await runScript({ args: { target: '/tmp/fake', rounds: 7, maxRounds: 1 }, stubs: stubsFor(map) })
  assert.equal(prompts.length, 7, '5 named lenses + 2 generalist passes (one round)')
  const wild = prompts.find((p) => /wildcard/i.test(p) && /creativ/i.test(p))
  assert.ok(wild, 'the first generalist fresh pass is an explicit wildcard / creative angle')
})

// ================= SATURATION LOOP (loop-until-dry discovery rounds) =================
// Discovery is wrapped in a budget-bounded loop: re-run the lensed fan-out and
// accumulate into ONE cumulative `seen` map until a full round adds zero new
// unique candidates (saturated), the round cap is hit (capped), or the budget
// floor is reached (budget). Each round's "new" is measured against ALL prior rounds.

// Parse the round index out of a round-aware discover label ("discover:r2-lens-0").
const roundOf = (opts) => Number((opts.label || '').match(/discover:r(\d+)-/)?.[1] || 0)
const discoverCalls = (calls) => calls.agents.filter((a) => (a.opts.label || '').startsWith('discover:'))

// A budget.spent() stub that climbs by `perRound` between the before/after readings the loop
// takes each round, so the workflow MEASURES a per-round cost of exactly `perRound`. The loop
// calls spent() exactly twice per round (once before the fan-out, once after) and nowhere else,
// so odd calls are the "before" reading (k rounds done) and even calls the "after" (k+1 done) —
// making each round's measured delta a clean `perRound`.
const spentStub = (perRound) => { let n = 0; return () => { n++; return Math.floor(n / 2) * perRound } }

test('saturation: stops after the first round that adds zero new candidates', async () => {
  // Same candidates every round => round 2 adds nothing new => saturated.
  const map = { tool: toolMissing, discovery: () => discoveryTwo }
  const { result, calls } = await runScript({ args: { target: '/tmp/fake', rounds: 2, maxRounds: 6 }, stubs: stubsFor(map) })
  assert.equal(result.terminal_state, 'saturated', 'a zero-new round => saturated')
  assert.equal(result.rounds_run, 2, 'round 1 finds 2, round 2 adds nothing => stop at round 2')
  assert.equal(discoverCalls(calls).length, 4, 'exactly two rounds of two workers ran')
  assert.equal(result.candidates, 2, 'cumulative unique stays 2 across rounds')
})

test('saturation: honors args.maxRounds when rounds never go dry', async () => {
  // Each round surfaces a brand-new candidate => never saturates => capped at maxRounds.
  const discovery = (_p, opts) => {
    const r = roundOf(opts)
    return {
      threat_model: 'tm', files_reviewed: 1,
      candidates: [{ title: `finding round ${r}`, file: `src/r${r}.ts`, line: 1, vuln_class: 'xss', source: 's', sink: 'k', why: 'w' }],
    }
  }
  const map = { tool: toolMissing, discovery }
  const { result, calls } = await runScript({ args: { target: '/tmp/fake', rounds: 1, maxRounds: 3 }, stubs: stubsFor(map) })
  assert.equal(result.terminal_state, 'capped', 'never dry => capped at the round cap')
  assert.equal(result.rounds_run, 3, 'ran exactly maxRounds rounds')
  assert.equal(discoverCalls(calls).length, 3, 'one worker per round, three rounds')
  assert.equal(result.candidates, 3, 'three distinct findings accumulated')
})

test('saturation: a round-1 candidate is not re-counted as new in round 2 (cumulative dedup)', async () => {
  const A = { title: 'idor on items', file: 'src/api.ts', line: 10, vuln_class: 'idor', source: 'id', sink: 'db.get', why: 'no check' }
  const B = { title: 'sqli in db', file: 'src/db.ts', line: 42, vuln_class: 'sql-injection', source: 'q', sink: 'db.raw', why: 'concat' }
  // Round 1 finds A+B; every later round re-finds only A (a prior-round dup).
  const discovery = (_p, opts) => ({
    threat_model: 'tm', files_reviewed: 1, candidates: roundOf(opts) === 1 ? [A, B] : [A],
  })
  const map = { tool: toolMissing, discovery }
  const { result } = await runScript({ args: { target: '/tmp/fake', rounds: 1, maxRounds: 6 }, stubs: stubsFor(map) })
  assert.equal(result.candidates, 2, 'A+B once; round-2 re-finding of A adds nothing new')
  assert.equal(result.terminal_state, 'saturated', 'round 2 adds zero new => saturated')
  assert.equal(result.rounds_run, 2, 'stops the round after the dry one')
})

test('saturation: terminal_state and rounds_run appear in the return and the report coverage', async () => {
  const map = { tool: toolMissing, discovery: () => discoveryTwo }
  const { result } = await runScript({ args: { target: '/tmp/fake', rounds: 2 }, stubs: stubsFor(map) })
  assert.ok(['saturated', 'capped', 'budget'].includes(result.terminal_state), 'terminal_state in return')
  assert.equal(typeof result.rounds_run, 'number', 'rounds_run is a number in the return')
  assert.ok(result.rounds_run >= 1, 'at least one round ran')
  assert.ok(map.reportPrompt.includes(result.terminal_state), 'coverage statement names the terminal state')
  assert.ok(/round/i.test(map.reportPrompt), 'coverage statement mentions discovery rounds')
})

test('saturation: stops with terminal_state=budget when the MEASURED floor cannot fund another round + tail', async () => {
  // Discovery never goes dry, so only the budget gate can stop it before maxRounds. Each round
  // MEASURES a cost of 500k (budget.spent() delta); the measured floor reserves that round PLUS
  // an equal tail for validation/report = ~1M.
  const discovery = (_p, opts) => {
    const r = roundOf(opts)
    return { threat_model: 'tm', files_reviewed: 1, candidates: [{ title: `f${r}`, file: `src/r${r}.ts`, line: 1, vuln_class: 'xss', source: 's', sink: 'k', why: 'w' }] }
  }
  // remaining (800k) is MORE than one measured round (500k) but LESS than round + tail (~1M):
  // the headroom reserve for the downstream validation/report phases is what trips the gate.
  // The old flat estimate (WORKERS.length*60000 = 60k here) would NOT have stopped — a measured
  // floor is what makes this a true "can't finish" stop.
  const budget = { total: 2_000_000, spent: spentStub(500_000), remaining: () => 800_000 }
  const map = { tool: toolMissing, discovery }
  const { result } = await runScript({ args: { target: '/tmp/fake', rounds: 1, maxRounds: 6 }, stubs: stubsFor(map), budget })
  assert.equal(result.terminal_state, 'budget', 'measured floor (round + validation/report tail) stops the loop before the cap')
  assert.equal(result.rounds_run, 1, 'only the first round completed before the measured gate tripped')
})

test('saturation: measured floor does NOT stop early where the flat estimate would have (no false budget trip)', async () => {
  // 8 workers => the OLD flat estimate would reserve 8*60000 = 480k per round. But each round
  // actually MEASURES cheap (50k), so the measured floor is only ~100k (round + tail). With
  // remaining = 200k — BELOW the flat estimate but ABOVE the measured floor — the loop must keep
  // going and stop on saturation, not falsely as 'budget'. This is the recall win of #38.
  const budget = { total: 5_000_000, spent: spentStub(50_000), remaining: () => 200_000 }
  const map = { tool: toolMissing, discovery: () => discoveryTwo }
  const { result } = await runScript({ args: { target: '/tmp/fake', rounds: 8, maxRounds: 6 }, stubs: stubsFor(map), budget })
  assert.equal(result.terminal_state, 'saturated', 'measured floor permits the round the flat estimate would have refused')
  assert.equal(result.rounds_run, 2, 'round 1 productive, round 2 dry => saturated (not a premature budget stop)')
})

test('saturation: ample budget does not trip the budget gate', async () => {
  const budget = { total: 10_000_000, spent: spentStub(100_000), remaining: () => 10_000_000 }
  const map = { tool: toolMissing, discovery: () => discoveryTwo }
  const { result } = await runScript({ args: { target: '/tmp/fake', rounds: 2 }, stubs: stubsFor(map), budget })
  assert.equal(result.terminal_state, 'saturated', 'with budget to spare it runs to saturation')
  assert.equal(result.rounds_run, 2, 'two rounds: one productive, one dry')
})

test('saturation: no budget target => measured floor is inert (loop bounded only by saturation/cap)', async () => {
  // No budget => HAS_BUDGET false => the budget gate never fires regardless of measured cost.
  // Backward-compat: the no-target path is unchanged by the measured-floor work.
  const discovery = (_p, opts) => {
    const r = roundOf(opts)
    return { threat_model: 'tm', files_reviewed: 1, candidates: [{ title: `f${r}`, file: `src/r${r}.ts`, line: 1, vuln_class: 'xss', source: 's', sink: 'k', why: 'w' }] }
  }
  const map = { tool: toolMissing, discovery }
  const { result } = await runScript({ args: { target: '/tmp/fake', rounds: 1, maxRounds: 3 }, stubs: stubsFor(map) })
  assert.notEqual(result.terminal_state, 'budget', 'budget gate inert without a target')
  assert.equal(result.terminal_state, 'capped', 'no budget => capped by maxRounds, never budget')
  assert.equal(result.rounds_run, 3, 'ran to the round cap, unaffected by any budget floor')
})

// ================= SEVERITY / ATTACK-PATH STAGE (issue #22) =================
// Severity is split OUT of the validator into a dedicated post-validation stage that
// derives an attacker-path FACTS record, calibrates severity, then runs a mechanical
// POLICY pass with an anti-pattern "should-not-be-high/critical" list.

test('sev: a distinct Severity phase runs after Validate, only on confirmed candidates', async () => {
  const map = { tool: toolMissing, discovery: () => discoveryTwo }
  const { calls } = await runScript({ args: { target: '/tmp/fake', rounds: 2 }, stubs: stubsFor(map) })
  assert.ok(calls.phases.includes('Severity'), 'a Severity phase fires')
  const order = calls.phases
  assert.ok(order.indexOf('Severity') > order.indexOf('Validate'), 'Severity runs AFTER Validate')
  assert.ok(order.indexOf('Severity') < order.indexOf('Report'), 'Severity runs BEFORE Report')
  // both candidates are confirmed -> two severity calls (one per confirmed finding)
  assert.equal((map.severityPrompts || []).length, 2, 'one severity call per confirmed candidate')
})

test('sev: Severity stage does NOT run for refuted / needs-info candidates', async () => {
  const map = { tool: toolMissing, discovery: () => discoveryTwo, verdict: { disposition: 'refuted', rationale: 'guarded', attacker_story: '', evidence: 'prepared stmt', proof_gap: '', fix: '' } }
  const { result } = await runScript({ args: { target: '/tmp/fake', rounds: 2 }, stubs: stubsFor(map) })
  assert.equal((map.severityPrompts || []).length, 0, 'no severity calls when nothing is confirmed')
  assert.equal(result.reportable.length, 0, 'refuted candidates are not reportable')
  assert.equal(result.appendix_count, result.candidates, 'they still appear in the appendix (suppression visible)')
})

test('sev: severity comes from the new stage — keep@high flows through to the report', async () => {
  const map = { tool: toolMissing, discovery: () => discoveryTwo }
  const { result } = await runScript({ args: { target: '/tmp/fake', rounds: 2 }, stubs: stubsFor(map) })
  assert.equal(result.reportable.length, 2, 'both confirmed + kept findings reported')
  assert.ok(result.reportable.every((f) => f.severity === 'high'), 'final severity is the stage-calibrated value')
  assert.ok(result.counts.high >= 2, 'severity counts come from the calibrated severity')
})

test('sev: self-XSS cannot remain HIGH — policy downgrades it (anti-pattern fires)', async () => {
  const map = { tool: toolMissing, discovery: () => discoverySelfXssAndSqli, severity: severityByClass }
  const { result } = await runScript({ args: { target: '/tmp/fake', rounds: 2 }, stubs: stubsFor(map) })
  const selfxss = result.reportable.find((f) => f.vuln_class === 'self-xss')
  assert.ok(selfxss, 'self-xss still surfaces (downgraded, not silently dropped) at low threshold')
  assert.notEqual(selfxss.severity, 'high', 'self-xss must NOT remain HIGH')
  assert.notEqual(selfxss.severity, 'critical', 'nor critical')
  assert.equal(selfxss.severity, 'low', 'downgraded to the calibrated low severity')
  assert.equal(selfxss.policy_decision, 'downgrade', 'policy pass recorded a downgrade')
  assert.equal(selfxss.anti_pattern, 'self-xss', 'the firing anti-pattern is named')
  // the genuine sqli is untouched by the policy pass
  const sqli = result.reportable.find((f) => f.vuln_class === 'sql-injection')
  assert.ok(sqli && sqli.severity === 'high', 'a real high-severity finding is not downgraded')
})

test('sev: policy DROP removes a theoretical-only finding from the report but keeps it in the appendix', async () => {
  const discovery = () => ({
    threat_model: 'tm', files_reviewed: 2,
    candidates: [
      { title: 'theoretical memory corruption', file: 'src/mem.c', line: 9, vuln_class: 'memory-corruption', source: 'n/a', sink: 'memcpy', why: 'no proven path' },
      { title: 'idor on /api/items', file: 'src/api.ts', line: 10, vuln_class: 'idor', source: 'id', sink: 'db.get', why: 'no owner check' },
    ],
  })
  const map = { tool: toolMissing, discovery, severity: severityByClass }
  const { result } = await runScript({ args: { target: '/tmp/fake', rounds: 2 }, stubs: stubsFor(map) })
  assert.ok(!result.reportable.some((f) => f.vuln_class === 'memory-corruption'), 'dropped finding is NOT reported')
  assert.equal(result.reportable.length, 1, 'only the real idor remains reportable')
  assert.equal(result.reportable.length + result.appendix_count, result.candidates, 'dropped item still counted in the appendix')
})

test('sev: a downgrade BELOW threshold is suppressed to the appendix, not reported', async () => {
  // threshold=medium: self-xss downgraded to low falls below it -> appendix.
  const map = { tool: toolMissing, discovery: () => discoverySelfXssAndSqli, severity: severityByClass }
  const { result } = await runScript({ args: { target: '/tmp/fake', rounds: 2, threshold: 'medium' }, stubs: stubsFor(map) })
  assert.ok(!result.reportable.some((f) => f.vuln_class === 'self-xss'), 'self-xss (low) is below the medium threshold')
  assert.equal(result.reportable.length + result.appendix_count, result.candidates, 'still accounted for in the appendix')
})

test('sev: return carries an additive severity_policy tally (kept/downgraded/dropped)', async () => {
  const map = { tool: toolMissing, discovery: () => discoverySelfXssAndSqli, severity: severityByClass }
  const { result } = await runScript({ args: { target: '/tmp/fake', rounds: 2 }, stubs: stubsFor(map) })
  assert.ok(result.severity_policy && typeof result.severity_policy === 'object', 'severity_policy present')
  assert.equal(result.severity_policy.downgraded, 1, 'one downgrade (self-xss)')
  assert.equal(result.severity_policy.kept, 1, 'one kept (sqli)')
  assert.equal(result.severity_policy.dropped, 0, 'none dropped here')
})

test('sev: Severity stage runs in chunks of <=8 concurrent agents', async () => {
  const many = {
    threat_model: 'tm', files_reviewed: 5,
    candidates: Array.from({ length: 20 }, (_, i) => ({
      title: `finding ${i}`, file: `src/f${i}.ts`, line: 10, vuln_class: 'xss', source: 's', sink: 'k', why: 'w',
    })),
  }
  const map = { tool: toolMissing, discovery: () => many }
  const { calls } = await runScript({ args: { target: '/tmp/fake', rounds: 1 }, stubs: stubsFor(map) })
  // severity agents were all invoked (20), proving the stage iterated the full confirmed set
  assert.equal((map.severityPrompts || []).length, 20, 'every confirmed candidate is calibrated')
  void calls
})

test('sev: severity prompt names the over-rating anti-patterns + the dynamic-baseline principle', async () => {
  const map = { tool: toolMissing, discovery: () => discoveryTwo }
  await runScript({ args: { target: '/tmp/fake', rounds: 2 }, stubs: stubsFor(map) })
  const p = (map.severityPrompts || [])[0] || ''
  assert.ok(/self-?xss/i.test(p), 'self-XSS anti-pattern named')
  assert.ok(/theoretical/i.test(p) && /memory/i.test(p), 'theoretical memory-corruption named')
  assert.ok(/defense-in-depth|second.*(layer|defense)/i.test(p), 'missing second defense-in-depth layer named')
  assert.ok(/chain/i.test(p), '"could matter if chained" named')
  assert.ok(/owasp|checklist/i.test(p), 'bare checklist deviation named')
  assert.ok(/boundary/i.test(p), 'internal-no-boundary covered')
  assert.ok(/dynamic baseline/i.test(p), 'dynamic-baseline principle present')
  assert.ok(/facts/i.test(p) && /policy/i.test(p), 'facts -> severity -> policy structure present')
})

test('sev: severity schema is satisfiable and returns facts + calibrated severity + policy', async () => {
  const map = { tool: toolMissing, discovery: () => discoveryTwo }
  await runScript({ args: { target: '/tmp/fake', rounds: 2 }, stubs: stubsFor(map) })
  const opts = (map.severityOpts || [])[0]
  assert.ok(opts && opts.schema, 'severity agent uses structured output')
  const req = opts.schema.required || []
  for (const k of ['facts', 'calibrated_severity', 'final_severity', 'policy_decision']) {
    assert.ok(req.includes(k), `severity schema requires ${k}`)
  }
})

test('sev: validator no longer calibrates severity (schema drops severity/reportable)', async () => {
  // The validator schema should NOT carry severity/reportable any more — exploitability only.
  const map = { tool: toolMissing, discovery: () => discoveryTwo }
  const { calls } = await runScript({ args: { target: '/tmp/fake', rounds: 2 }, stubs: stubsFor(map) })
  const v = calls.agents.find((a) => (a.opts.label || '').startsWith('validate:'))
  assert.ok(v && v.opts.schema, 'validator uses structured output')
  const props = v.opts.schema.properties || {}
  assert.ok(!('severity' in props), 'validator schema no longer has a severity field')
  assert.ok(!('reportable' in props), 'validator schema no longer has a reportable field')
  assert.ok('disposition' in props, 'validator still decides disposition (exploitability)')
})

test('sev: validator prompt names the five disprove tests + the dynamic-baseline principle', async () => {
  const map = { tool: toolMissing, discovery: () => discoveryTwo }
  await runScript({ args: { target: '/tmp/fake', rounds: 2 }, stubs: stubsFor(map) })
  const p = (map.validatePrompts || [])[0] || ''
  assert.ok(/exploitation/i.test(p), 'exploitation test named')
  assert.ok(/impact/i.test(p), 'impact test named')
  assert.ok(/baseline/i.test(p), 'baseline test named')
  assert.ok(/mitigation/i.test(p), 'mitigation test named')
  assert.ok(/parser|runtime/i.test(p), 'parser/runtime-behavior test named')
  assert.ok(/dynamic baseline/i.test(p), 'dynamic-baseline principle present')
})

test('sev: report consumes calibrated severity + shows suppressed items with their anti-pattern', async () => {
  const map = { tool: toolMissing, discovery: () => discoverySelfXssAndSqli, severity: severityByClass }
  await runScript({ args: { target: '/tmp/fake', rounds: 2, threshold: 'medium' }, stubs: stubsFor(map) })
  // self-xss downgraded to low is below the medium threshold -> appears in the appendix block with its reason
  assert.ok(/self-xss/i.test(map.reportPrompt), 'suppressed self-xss reaches the report appendix')
  assert.ok(/calibrated|attack-path|severity stage/i.test(map.reportPrompt), 'report told severity comes from the calibration stage')
})

// ---- model independence (#92) ----
// Validate exists to disagree with Discovery. If both inherit the session model, the model that
// FOUND a candidate is the model that decides it is real, and "confirmed" reflects one opinion
// twice. Mirrors the factory guard (factory-issue-fix.js MODEL INDEPENDENCE + its sim tests).

const byLabel = (calls, prefix) => calls.agents.filter((a) => (a.opts.label || "").startsWith(prefix))

test("models: Validate runs on a DIFFERENT model family from Discovery", async () => {
  const map = { tool: toolMissing, discovery: () => discoveryTwo }
  const { calls } = await runScript({ args: { target: "/tmp/fake", rounds: 2 }, stubs: stubsFor(map) })
  const d = byLabel(calls, "discover:")[0]
  const v = byLabel(calls, "validate:")[0]
  assert.ok(d.opts.model, "discovery is pinned to an explicit model")
  assert.ok(v.opts.model, "validation is pinned to an explicit model")
  assert.notEqual(v.opts.model, d.opts.model, "a same-model validator agrees with itself — the models must differ")
})

test("models: both are overridable, and a caller that collapses them is rejected", async () => {
  const { calls } = await runScript({
    args: { target: "/tmp/fake", rounds: 2, discoveryModel: "opus", validateModel: "haiku" },
    stubs: stubsFor({ tool: toolMissing, discovery: () => discoveryTwo }),
  })
  assert.equal(byLabel(calls, "discover:")[0].opts.model, "opus", "discoveryModel is honoured")
  assert.equal(byLabel(calls, "validate:")[0].opts.model, "haiku", "validateModel is honoured")
  await assert.rejects(
    () => runScript({
      args: { target: "/tmp/fake", rounds: 2, discoveryModel: "opus", validateModel: "opus" },
      stubs: stubsFor({ tool: toolMissing, discovery: () => discoveryTwo }),
    }),
    (e) => /DIFFERENT model family/i.test(e.message) && /opus/.test(e.message),
    "collapsing the two must THROW and name both values, not silently degrade"
  )
})

// ---- runner ----
let failed = 0
for (const [name, fn] of tests) {
  try { await fn(); console.log('PASS', name) }
  catch (e) { failed++; console.error('FAIL', name, '\n  ', e.message) }
}
console.log(failed ? `\n${failed}/${tests.length} FAILED` : `\nall ${tests.length} passed`)
process.exit(failed ? 1 : 0)
