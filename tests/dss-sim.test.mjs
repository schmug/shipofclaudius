// Offline simulator tests for ~/.claude/workflows/deep-security-scan.js.
// Stubs agent()/parallel()/phase()/log() so orchestration logic (dedup
// precedence, fail-open, chunked validation, coverage wiring) is testable in
// milliseconds with zero token spend.  Run:
//   node ~/.claude/workflows/tests/dss-sim.test.mjs
import { readFile } from 'node:fs/promises'
import assert from 'node:assert/strict'

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

async function runScript({ args, stubs }) {
  const src = (await readFile(SRC_PATH, 'utf8')).replace('export const meta', 'const meta')
  const calls = { phases: [], logs: [], agents: [] }
  let validateInFlight = 0
  let maxValidateInFlight = 0
  const agent = async (prompt, opts = {}) => {
    calls.agents.push({ prompt, opts })
    if (opts.schema) assertSatisfiable(opts.schema, opts.label || '?')
    const isValidate = (opts.label || '').startsWith('validate:')
    if (isValidate) { validateInFlight++; maxValidateInFlight = Math.max(maxValidateInFlight, validateInFlight) }
    await new Promise((r) => setTimeout(r, 2)) // let concurrency overlap
    try { return await stubs(prompt, opts) } finally { if (isValidate) validateInFlight-- }
  }
  const parallel = (thunks) => Promise.all(thunks.map((t) => Promise.resolve().then(t).catch(() => null)))
  const phase = (t) => calls.phases.push(t)
  const log = (m) => calls.logs.push(m)
  const fn = new AsyncFunction('args', 'budget', 'agent', 'parallel', 'pipeline', 'phase', 'log', 'workflow', src)
  const result = await fn(args, undefined, agent, parallel, null, phase, log, null)
  return { result, calls, maxValidateInFlight: () => maxValidateInFlight }
}

// ---- canned data ----
const verdict = {
  disposition: 'confirmed', severity: 'high', reportable: true, rationale: 'traced',
  attacker_story: 'a', evidence: 'e', proof_gap: '', fix: 'f', cvss_vector: '',
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

function stubsFor(map) {
  return (prompt, opts) => {
    const l = opts.label || ''
    if (l.startsWith('tools:')) { map.sawTool = true; return map.tool }
    if (l.startsWith('discover:')) return map.discovery(prompt)
    if (l.startsWith('validate:')) return map.verdict ?? verdict
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

// ---- runner ----
let failed = 0
for (const [name, fn] of tests) {
  try { await fn(); console.log('PASS', name) }
  catch (e) { failed++; console.error('FAIL', name, '\n  ', e.message) }
}
console.log(failed ? `\n${failed}/${tests.length} FAILED` : `\nall ${tests.length} passed`)
process.exit(failed ? 1 : 0)
