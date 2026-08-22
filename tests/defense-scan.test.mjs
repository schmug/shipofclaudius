// Offline simulator tests for ~/.claude/workflows/defense-scan.js (Phase B).
// Mirrors dss-sim.test.mjs: wraps the workflow source in an AsyncFunction with
// stubbed agent()/parallel()/phase()/log()/workflow() globals so the layer
// gating + merge + per-layer coverage logic is testable in milliseconds at zero
// token cost. Layer 1 composes deep-security-scan via workflow(); layers 2-4 are
// fail-open / opt-in / authorization-gated. Run:
//   node ~/.claude/workflows/tests/defense-scan.test.mjs
import { readFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
import { validateSarif } from './lib/sarif-2_1_0.mjs'

const SRC_PATH = new URL('../.claude/workflows/defense-scan.js', import.meta.url)
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

// ---- canned data ----
// Shape returned by deep-security-scan (the Layer-1 sub-workflow).
const L1_RESULT = {
  target: '/tmp/fake', scope: 'the entire repository at /tmp/fake', rounds: 4, files_reviewed: 20,
  tool_coverage: 'Deterministic prefilter: foxguard 0.8.1, severity floor low, 12 files scanned, 5 findings ingested as candidates.',
  candidates: 7,
  confirmed: 2,
  severity_policy: { kept: 2, downgraded: 1, dropped: 1 },
  counts: { high: 1, low: 1 },
  reportable: [
    { id: 'f1', title: 'SQLi in db layer', file: 'src/db.ts', line: 42, vuln_class: 'sql-injection', severity: 'high', source: 'foxguard:rs-sqli-001', sink: 'db.raw', why: 'unparameterized query', rationale: 'traced', attacker_story: 'a', evidence: 'e', fix: 'parameterize' },
    { id: 'f2', title: 'weak crypto MD5', file: 'src/c.ts', line: 5, vuln_class: 'weak-crypto', severity: 'low', source: 'agent', why: 'md5 for tokens', rationale: 'r', fix: 'use sha-256' },
  ],
  appendix_count: 5,
  // deep-security-scan's hardened return shape (report.md not written by the subagent):
  report_dir: '/tmp/fake/.security-scans/X-deep',
  report_html: '/tmp/fake/.security-scans/X-deep/report.html',
  report_md: '# Deep sub-report md',
  report: { output_dir: '/tmp/fake/.security-scans/X-deep', report_html_path: '/tmp/fake/.security-scans/X-deep/report.html', report_md: '# Deep sub-report md', html_written: true },
}
// Zero-candidate early-return shape (deep-security-scan omits report/counts/appendix_count).
const L1_EMPTY = {
  target: '/tmp/fake', scope: 'repo', rounds: 2, files_reviewed: 4, candidates: 0,
  reportable: [], tool_coverage: 'Deterministic prefilter SKIPPED: foxguard not installed.',
  note: 'No candidate vulnerabilities surfaced across the independent discovery workers.',
}

const L2_RAN = {
  ran: true, status: 'ran', tool_version: '0.1.1', target: '/tmp/fake', note: 'scanned project profile',
  findings: [
    { title: 'Vulnerable dependency lodash', severity: 'medium', location: 'lodash@4.0.0', vuln_class: 'vulnerable-dependency', source: 'bumblebee:osv-GHSA-x', why: 'known prototype-pollution CVE', fix: 'upgrade to 4.17.21' },
  ],
  inventory: ['MCP config: ~/.cursor/mcp.json (3 servers)', 'agent skill: untrusted-skill', 'editor extension: foo.bar'],
}
const L2_MISSING = { ran: false, status: 'not-installed', tool_version: '', target: '/tmp/fake', note: 'bumblebee not installed', findings: [] }
const L3_RAN = {
  ran: true, status: 'ran', tool_version: '0.1.4', target: 'https://staging.example.com', note: 'native scan complete',
  findings: [{ title: 'Reflected XSS on /search', severity: 'high', location: 'https://staging.example.com/search?q=', vuln_class: 'xss', source: 'vigolium:xss-reflected', why: 'q param reflected unencoded', fix: 'encode output' }],
}
const L4_RAN = {
  ran: true, status: 'ran', tool_version: '0.10.0', target: 'https://llm.example.com/v1/chat', note: 'probes complete',
  findings: [{ title: 'Prompt injection bypasses system prompt', severity: 'high', location: 'https://llm.example.com/v1/chat (promptinject)', vuln_class: 'prompt-injection', source: 'garak:promptinject/promptinject.AttackRogueString', why: 'detector flagged hit', fix: 'add input/output guardrails' }],
}
const L5_RAN = {
  ran: true, status: 'ran', tool_version: '3.3.0', target: 'https://staging.example.com', note: 'template scan complete',
  findings: [{ title: 'Exposed .git directory', severity: 'medium', location: 'https://staging.example.com/.git/config', vuln_class: 'exposure/git-config', source: 'nuclei:git-config', why: 'nuclei matcher confirmed an accessible .git/config', fix: 'block access to /.git in the web server config' }],
}
const L5_MISSING = { ran: false, status: 'not-installed', tool_version: '', target: 'https://staging.example.com', note: 'nuclei not installed', findings: [] }
const L6_RAN = {
  ran: true, status: 'ran', tool_version: '5.5.0', target: 'github.com/acme/widget', note: 'Scorecard aggregate 6.2/10; 3 checks below threshold',
  findings: [{ title: 'Branch-Protection not enabled on default branch', severity: 'medium', location: 'github.com/acme/widget (Branch-Protection)', vuln_class: 'posture/access-control', source: 'scorecard:Branch-Protection', why: 'Scorecard scored Branch-Protection 0/10', fix: 'require reviews + status checks on the default branch' }],
}
const L6_MISSING = { ran: false, status: 'not-installed', tool_version: '', target: 'github.com/acme/widget', note: 'scorecard not installed', findings: [] }

const L2_RAN_EMPTY = { ran: true, status: 'ran', tool_version: '0.1.1', target: '/tmp/fake', note: 'scanned, nothing found', findings: [], inventory: [] }

function stubsFor(map) {
  return (prompt, opts) => {
    const l = opts.label || ''
    if (l.startsWith('prior-bundle')) { map.sawPriorLoader = true; map.priorLoaderPrompt = prompt; return map.priorLoaded ?? { ok: false, content: '', note: 'no stub' } }
    if (l.startsWith('layer2')) { map.sawL2 = true; map.l2Prompt = prompt; if (map.l2Throws) throw new Error('bumblebee blew up'); return map.l2 ?? L2_MISSING }
    if (l.startsWith('layer3')) { map.sawL3 = true; map.l3Prompt = prompt; return map.l3 ?? L3_RAN }
    if (l.startsWith('layer4')) { map.sawL4 = true; map.l4Prompt = prompt; return map.l4 ?? L4_RAN }
    if (l.startsWith('layer5')) { map.sawL5 = true; map.l5Prompt = prompt; return map.l5 ?? L5_RAN }
    if (l.startsWith('layer6')) { map.sawL6 = true; map.l6Prompt = prompt; return map.l6 ?? L6_RAN }
    if (l === 'report') {
      map.sawReport = true; map.reportPrompt = prompt; map.reportOpts = opts
      // 'report' in map lets a test force an explicit null (agent-died case); otherwise default.
      if ('report' in map) return map.report
      return {
        output_dir: '/tmp/fake/.security-scans/T-defense',
        report_html_path: '/tmp/fake/.security-scans/T-defense/report.html',
        report_md: '# Defense-in-Depth Security Review — merged md\n\ncoverage + findings here',
        html_written: true,
      }
    }
    throw new Error('unexpected agent label: ' + l)
  }
}

async function runScript({ args, map }) {
  const src = (await readFile(SRC_PATH, 'utf8')).replace('export const meta', 'const meta')
  const calls = { phases: [], logs: [], agents: [], workflows: [] }
  const stubs = stubsFor(map)
  const agent = async (prompt, opts = {}) => {
    calls.agents.push({ prompt, opts })
    if (opts.schema) assertSatisfiable(opts.schema, opts.label || '?')
    await new Promise((r) => setTimeout(r, 1))
    return stubs(prompt, opts)
  }
  const parallel = (thunks) => Promise.all(thunks.map((t) => Promise.resolve().then(t).catch(() => null)))
  const phase = (t) => calls.phases.push(t)
  const log = (m) => calls.logs.push(m)
  const workflow = async (name, wargs) => {
    calls.workflows.push({ name, args: wargs })
    if (map.l1Throws) throw new Error('layer 1 workflow crashed')
    return map.l1 ?? L1_RESULT
  }
  const fn = new AsyncFunction('args', 'budget', 'agent', 'parallel', 'pipeline', 'phase', 'log', 'workflow', src)
  const result = await fn(args, undefined, agent, parallel, null, phase, log, workflow)
  return { result, calls }
}

const tests = []
const test = (name, fn) => tests.push([name, fn])

// ===================== STRUCTURE / PARSE =====================

test('script parses, meta is loadable, and a default run completes', async () => {
  const map = {}
  const { result } = await runScript({ args: { target: '/tmp/fake' }, map })
  assert.ok(result, 'orchestrator returns a result object')
})

test('layer schemas used during a run are satisfiable', async () => {
  // assertSatisfiable throws inside agent() if any schema is broken
  const map = { l2: L2_RAN }
  await runScript({ args: { target: '/tmp/fake' }, map })
})

// ===================== LAYER 1 (always runs) =====================

test('layer 1 always composes deep-security-scan via workflow()', async () => {
  const map = {}
  const { calls } = await runScript({ args: { target: '/tmp/fake', scope: 'repo', rounds: 3, threshold: 'medium' }, map })
  const wf = calls.workflows.find((w) => w.name === 'deep-security-scan')
  assert.ok(wf, 'deep-security-scan must be invoked via workflow()')
  assert.equal(wf.args.target, '/tmp/fake')
  assert.equal(wf.args.rounds, 3)
  assert.equal(wf.args.threshold, 'medium')
})

test('layer 1 reportable findings flow into the merged report + counts', async () => {
  const map = {}
  const { result } = await runScript({ args: { target: '/tmp/fake' }, map })
  assert.ok(map.reportPrompt.includes('SQLi in db layer'), 'L1 finding title reaches the report')
  assert.ok(result.counts.high >= 1, 'merged counts include the high L1 finding')
  assert.ok(result.reportable.some((f) => f.title === 'SQLi in db layer'), 'merged reportable carries L1 finding')
})

test('layer 1 coverage surfaces the severity-policy tally when present', async () => {
  const map = {}
  await runScript({ args: { target: '/tmp/fake' }, map })
  const cov1 = map.reportPrompt.split('\n').find((l) => /Layer 1 \(code-at-rest/.test(l)) || map.reportPrompt
  assert.ok(/severity policy:/.test(cov1), 'L1 coverage names the severity policy')
  assert.ok(/kept 2/.test(cov1), 'kept count surfaced')
  assert.ok(/downgraded 1/.test(cov1), 'downgraded count surfaced')
  assert.ok(/dropped 1/.test(cov1), 'dropped count surfaced')
})

test('layer 1 coverage omits the tally (no undefined) when severity_policy is absent', async () => {
  const { severity_policy, ...l1NoPolicy } = L1_RESULT
  const map = { l1: l1NoPolicy }
  await runScript({ args: { target: '/tmp/fake' }, map })
  const cov1 = map.reportPrompt.split('\n').find((l) => /Layer 1 \(code-at-rest/.test(l)) || map.reportPrompt
  assert.ok(!/severity policy:/.test(cov1), 'no severity-policy clause when keys absent')
  assert.ok(!/undefined/.test(cov1), 'no undefined leaks into the coverage line')
})

test('layer 1 error is fail-open: report still emitted, coverage records the error', async () => {
  const map = { l1Throws: true }
  const { result } = await runScript({ args: { target: '/tmp/fake' }, map })
  assert.ok(map.sawReport, 'report still runs after a layer-1 crash')
  assert.ok(map.reportPrompt.includes('Layer 1') && /ERROR/.test(map.reportPrompt), 'layer-1 error recorded in coverage')
  assert.ok(result, 'orchestrator returns despite layer-1 crash')
})

test('layer 1 zero-candidate early return is handled (RAN, 0 findings, not "clean")', async () => {
  const map = { l1: L1_EMPTY }
  const { result } = await runScript({ args: { target: '/tmp/fake' }, map })
  assert.ok(map.sawReport, 'report runs even when layer 1 found nothing')
  assert.ok(map.reportPrompt.includes('Layer 1') && map.reportPrompt.includes('RAN'), 'layer 1 marked RAN')
  assert.ok(result, 'no crash on missing report/appendix_count fields')
})

// ===================== LAYER 2 (default on, fail-open) =====================

test('layer 2 runs by default (bumblebee agent invoked)', async () => {
  const map = { l2: L2_RAN }
  await runScript({ args: { target: '/tmp/fake' }, map })
  assert.ok(map.sawL2, 'supply-chain layer runs by default')
})

test('layer 2 fail-open when bumblebee absent: full run + SKIPPED coverage + reason', async () => {
  const map = { l2: L2_MISSING }
  const { result } = await runScript({ args: { target: '/tmp/fake' }, map })
  assert.ok(map.sawReport, 'report still emitted')
  assert.ok(map.reportPrompt.includes('Layer 2') && map.reportPrompt.includes('SKIPPED'), 'L2 skip recorded')
  assert.ok(map.reportPrompt.includes('bumblebee not installed'), 'and the exact reason')
  assert.ok(result.reportable.some((f) => f.title === 'SQLi in db layer'), 'layer 1 findings still reported')
})

test('layer 2 agent error is fail-open (ERROR coverage, scan continues)', async () => {
  const map = { l2Throws: true }
  const { result } = await runScript({ args: { target: '/tmp/fake' }, map })
  assert.ok(map.sawReport, 'report still emitted after layer-2 error')
  assert.ok(map.reportPrompt.includes('Layer 2') && /ERROR/.test(map.reportPrompt), 'L2 error recorded')
  assert.ok(result, 'no crash')
})

test('layer 2 can be disabled with args.supplyChain=false', async () => {
  const map = { l2: L2_RAN }
  await runScript({ args: { target: '/tmp/fake', supplyChain: false }, map })
  assert.ok(!map.sawL2, 'bumblebee agent must not run when disabled')
  assert.ok(map.reportPrompt.includes('DISABLED') && map.reportPrompt.includes('args.supplyChain=false'), 'coverage records the disable')
})

test('layer 2 install gating respects args.installMissing in the prompt', async () => {
  const off = { l2: L2_MISSING }
  await runScript({ args: { target: '/tmp/fake' }, map: off })
  assert.ok(off.l2Prompt.includes('do NOT install'), 'default: must not auto-install')
  const on = { l2: L2_MISSING }
  await runScript({ args: { target: '/tmp/fake', installMissing: true }, map: on })
  assert.ok(on.l2Prompt.includes('go install github.com/perplexityai/bumblebee'), 'installMissing=true permits the install command')
})

test('layer 2 supply-chain findings + inventory flow into the report', async () => {
  const map = { l2: L2_RAN }
  const { result } = await runScript({ args: { target: '/tmp/fake' }, map })
  assert.ok(map.reportPrompt.includes('Vulnerable dependency lodash'), 'L2 finding reaches the report')
  assert.ok(map.reportPrompt.includes('MCP config'), 'MCP/skill/extension inventory surfaced as attack surface')
  assert.ok(result.reportable.some((f) => f.title === 'Vulnerable dependency lodash'), 'merged reportable carries L2 finding')
})

test('layer 2 prompt forbids running package managers (read-only)', async () => {
  const map = { l2: L2_RAN }
  await runScript({ args: { target: '/tmp/fake' }, map })
  assert.ok(/never executes? package managers|read-only/i.test(map.l2Prompt), 'read-only / no package-manager execution stated')
})

// ===================== LAYER 3 (DAST, opt-in + authorization) =====================

test('layer 3 skips without args.url (never auto-runs)', async () => {
  const map = {}
  await runScript({ args: { target: '/tmp/fake' }, map })
  assert.ok(!map.sawL3, 'DAST agent must not run without a url')
  assert.ok(map.reportPrompt.includes('Layer 3') && map.reportPrompt.includes('no args.url'), 'skip reason recorded')
})

test('layer 3 skips when url present but args.authorized !== true', async () => {
  const map = {}
  await runScript({ args: { target: '/tmp/fake', url: 'https://staging.example.com' }, map })
  assert.ok(!map.sawL3, 'DAST must not run without authorization')
  assert.ok(map.reportPrompt.includes('args.authorized'), 'authorization reason recorded')
  const map2 = {}
  await runScript({ args: { target: '/tmp/fake', url: 'https://staging.example.com', authorized: false }, map: map2 })
  assert.ok(!map2.sawL3, 'authorized:false still must not run')
})

test('layer 3 runs only with url + authorized=true, native mode, not agentic', async () => {
  const map = { l3: L3_RAN }
  const { result } = await runScript({ args: { target: '/tmp/fake', url: 'https://staging.example.com', authorized: true }, map })
  assert.ok(map.sawL3, 'DAST runs when authorized')
  assert.ok(map.l3Prompt.includes('NATIVE scan mode'), 'native mode required')
  assert.ok(/agentic mode/i.test(map.l3Prompt), 'agentic mode mentioned (to forbid it)')
  assert.ok(result.reportable.some((f) => f.title === 'Reflected XSS on /search'), 'L3 finding merged')
})

// ===================== LAYER 4 (LLM red-team, opt-in + confirmation) =====================

test('layer 4 skips without args.llmEndpoint', async () => {
  const map = {}
  await runScript({ args: { target: '/tmp/fake' }, map })
  assert.ok(!map.sawL4, 'garak must not run without an llmEndpoint')
  assert.ok(map.reportPrompt.includes('Layer 4') && map.reportPrompt.includes('no args.llmEndpoint'), 'skip reason recorded')
})

test('layer 4 skips when llmEndpoint present but args.llmConfirmed !== true', async () => {
  const map = {}
  await runScript({ args: { target: '/tmp/fake', llmEndpoint: 'https://llm.example.com/v1/chat' }, map })
  assert.ok(!map.sawL4, 'garak must not run without confirmation')
  assert.ok(map.reportPrompt.includes('args.llmConfirmed'), 'confirmation reason recorded')
  const map2 = {}
  await runScript({ args: { target: '/tmp/fake', llmEndpoint: 'https://llm.example.com/v1/chat', llmConfirmed: false }, map: map2 })
  assert.ok(!map2.sawL4, 'llmConfirmed:false still must not run')
})

test('layer 4 runs only with llmEndpoint + llmConfirmed=true, narrow probes, cost caveat', async () => {
  const map = { l4: L4_RAN }
  const { result } = await runScript({ args: { target: '/tmp/fake', llmEndpoint: 'https://llm.example.com/v1/chat', llmConfirmed: true }, map })
  assert.ok(map.sawL4, 'garak runs when confirmed')
  assert.ok(map.l4Prompt.includes('promptinject,encoding,dan,packagehallucination'), 'narrow default probe subset')
  assert.ok(/real tokens/i.test(map.l4Prompt), 'cost caveat present')
  assert.ok(result.reportable.some((f) => f.title.includes('Prompt injection')), 'L4 finding merged')
})

// ===================== LAYER 5 (network/template, opt-in + authorization) =====================

test('layer 5 skips without args.networkTarget (never auto-runs)', async () => {
  const map = {}
  await runScript({ args: { target: '/tmp/fake' }, map })
  assert.ok(!map.sawL5, 'nuclei must not run without a networkTarget')
  assert.ok(map.reportPrompt.includes('Layer 5') && map.reportPrompt.includes('no args.networkTarget'), 'skip reason recorded')
})

test('layer 5 skips when networkTarget present but args.authorized !== true', async () => {
  const map = {}
  await runScript({ args: { target: '/tmp/fake', networkTarget: 'https://staging.example.com' }, map })
  assert.ok(!map.sawL5, 'nuclei must not run without authorization (sends real traffic)')
  assert.ok(map.reportPrompt.includes('args.authorized'), 'authorization reason recorded')
  const map2 = {}
  await runScript({ args: { target: '/tmp/fake', networkTarget: 'https://staging.example.com', authorized: false }, map: map2 })
  assert.ok(!map2.sawL5, 'authorized:false still must not run')
})

test('layer 5 runs only with networkTarget + authorized=true; prompt requires nuclei templates + -jsonl', async () => {
  const map = { l5: L5_RAN }
  const { result } = await runScript({ args: { target: '/tmp/fake', networkTarget: 'https://staging.example.com', authorized: true }, map })
  assert.ok(map.sawL5, 'nuclei runs when target + authorized')
  assert.ok(/nuclei/i.test(map.l5Prompt), 'nuclei named')
  assert.ok(/template/i.test(map.l5Prompt), 'templates referenced')
  assert.ok(map.l5Prompt.includes('-jsonl'), 'JSONL output flag required')
  assert.ok(/real traffic/i.test(map.l5Prompt), 'real-traffic caveat present')
  assert.ok(map.reportPrompt.includes('Exposed .git directory'), 'L5 finding reaches the report')
  assert.ok(result.reportable.some((f) => f.title === 'Exposed .git directory'), 'merged reportable carries L5 finding')
})

test('layer 5 fail-open when nuclei absent: SKIPPED coverage + reason, run still completes + report emitted', async () => {
  const map = { l5: L5_MISSING }
  const { result } = await runScript({ args: { target: '/tmp/fake', networkTarget: 'https://staging.example.com', authorized: true }, map })
  assert.ok(map.sawL5, 'nuclei agent invoked when target + authorized')
  assert.ok(map.sawReport, 'report still emitted')
  assert.ok(map.reportPrompt.includes('Layer 5') && map.reportPrompt.includes('SKIPPED'), 'L5 skip recorded')
  assert.ok(map.reportPrompt.includes('nuclei not installed'), 'and the exact reason')
  assert.ok(result, 'orchestrator returns despite a missing tool')
})

test('layer 5 install gating respects args.installMissing in the prompt', async () => {
  const off = { l5: L5_MISSING }
  await runScript({ args: { target: '/tmp/fake', networkTarget: 'https://staging.example.com', authorized: true }, map: off })
  assert.ok(off.l5Prompt.includes('do NOT install'), 'default: must not auto-install')
  const on = { l5: L5_MISSING }
  await runScript({ args: { target: '/tmp/fake', networkTarget: 'https://staging.example.com', authorized: true, installMissing: true }, map: on })
  assert.ok(on.l5Prompt.includes('go install github.com/projectdiscovery/nuclei'), 'installMissing=true permits the nuclei install command')
})

// ===================== LAYER 6 (posture/governance, opt-in; read-only, no auth needed) =====================

test('layer 6 skips without args.repo (never auto-runs)', async () => {
  const map = {}
  await runScript({ args: { target: '/tmp/fake' }, map })
  assert.ok(!map.sawL6, 'scorecard must not run without a repo')
  assert.ok(map.reportPrompt.includes('Layer 6') && map.reportPrompt.includes('no args.repo'), 'skip reason recorded')
})

test('layer 6 runs with args.repo (read-only, NO authorization flag needed); prompt requires Scorecard JSON + OSPS Baseline rubric', async () => {
  const map = { l6: L6_RAN }
  // Deliberately NO authorized flag — Layer 6 is read-only posture, unlike L3/L5.
  const { result } = await runScript({ args: { target: '/tmp/fake', repo: 'github.com/acme/widget' }, map })
  assert.ok(map.sawL6, 'scorecard runs on a repo without any authorized flag (read-only)')
  assert.ok(/scorecard/i.test(map.l6Prompt), 'Scorecard named as the scanner')
  assert.ok(map.l6Prompt.includes('--format=json'), 'JSON output requested')
  assert.ok(/OSPS Baseline|baseline/i.test(map.l6Prompt), 'OSPS Baseline rubric referenced')
  assert.ok(/read-only/i.test(map.l6Prompt), 'states it is read-only / needs no authorization')
  assert.ok(/attestation/i.test(map.l6Prompt), 'human-attestation controls flagged, not auto-claimed')
  assert.ok(/conservativ/i.test(map.l6Prompt), 'posture severity calibrated conservatively (gaps are not exploits)')
  assert.ok(map.reportPrompt.includes('Branch-Protection not enabled on default branch'), 'L6 finding reaches the report')
  assert.ok(result.reportable.some((f) => f.title.includes('Branch-Protection')), 'merged reportable carries L6 finding')
})

test('layer 6 fail-open when scorecard absent: SKIPPED coverage + reason, run completes + report emitted', async () => {
  const map = { l6: L6_MISSING }
  const { result } = await runScript({ args: { target: '/tmp/fake', repo: 'github.com/acme/widget' }, map })
  assert.ok(map.sawL6, 'scorecard agent invoked when repo present')
  assert.ok(map.sawReport, 'report still emitted')
  assert.ok(map.reportPrompt.includes('Layer 6') && map.reportPrompt.includes('SKIPPED'), 'L6 skip recorded')
  assert.ok(map.reportPrompt.includes('scorecard not installed'), 'and the exact reason')
  assert.ok(result, 'orchestrator returns despite a missing tool')
})

test('layer 6 install gating respects args.installMissing in the prompt', async () => {
  const off = { l6: L6_MISSING }
  await runScript({ args: { target: '/tmp/fake', repo: 'github.com/acme/widget' }, map: off })
  assert.ok(off.l6Prompt.includes('do NOT install'), 'default: must not auto-install')
  const on = { l6: L6_MISSING }
  await runScript({ args: { target: '/tmp/fake', repo: 'github.com/acme/widget', installMissing: true }, map: on })
  assert.ok(on.l6Prompt.includes('go install github.com/ossf/scorecard'), 'installMissing=true permits the scorecard install command')
})

// ===================== MERGE + COVERAGE =====================

test('coverage statement names every layer status; report always runs (skipped != clean)', async () => {
  const map = { l2: L2_MISSING }
  await runScript({ args: { target: '/tmp/fake' }, map }) // only L1 + L2(missing); L3/L4/L5/L6 skipped
  assert.ok(map.sawReport, 'report always runs to carry the coverage statement')
  for (const layer of ['Layer 1', 'Layer 2', 'Layer 3', 'Layer 4', 'Layer 5', 'Layer 6']) {
    assert.ok(map.reportPrompt.includes(layer), `${layer} named in coverage`)
  }
  assert.ok(map.reportPrompt.includes('SKIPPED'), 'skipped layers explicitly marked SKIPPED, not clean')
})

test('report prompt mandates HTML-escaping, the template, defense dir, and date -u stamping', async () => {
  const map = { l2: L2_RAN }
  await runScript({ args: { target: '/tmp/fake' }, map })
  assert.ok(/escape/i.test(map.reportPrompt), 'HTML-escaping instruction present')
  assert.ok(map.reportPrompt.includes('report-template.html'), 'reuses Phase A template')
  assert.ok(map.reportPrompt.includes('-defense'), 'output dir uses the -defense suffix')
  assert.ok(map.reportPrompt.includes('date -u'), 'dir stamped via date -u (no Date.now in scripts)')
  assert.ok(/COVERAGE/i.test(map.reportPrompt), 'mandatory coverage statement requested')
})

test('all six layers RAN: merged report carries findings from every layer', async () => {
  const map = { l2: L2_RAN, l3: L3_RAN, l4: L4_RAN, l5: L5_RAN, l6: L6_RAN }
  const { result } = await runScript({
    args: { target: '/tmp/fake', url: 'https://staging.example.com', authorized: true, llmEndpoint: 'https://llm.example.com/v1/chat', llmConfirmed: true, networkTarget: 'https://staging.example.com', repo: 'github.com/acme/widget' },
    map,
  })
  const titles = result.reportable.map((f) => f.title)
  assert.ok(titles.includes('SQLi in db layer'), 'L1')
  assert.ok(titles.includes('Vulnerable dependency lodash'), 'L2')
  assert.ok(titles.includes('Reflected XSS on /search'), 'L3')
  assert.ok(titles.some((t) => t.includes('Prompt injection')), 'L4')
  assert.ok(titles.includes('Exposed .git directory'), 'L5')
  assert.ok(titles.some((t) => t.includes('Branch-Protection')), 'L6')
  for (const layer of ['Layer 1', 'Layer 2', 'Layer 3', 'Layer 4', 'Layer 5', 'Layer 6']) {
    assert.ok(map.reportPrompt.includes(`${layer} `) && map.reportPrompt.includes('RAN'), `${layer} RAN recorded`)
  }
})

// ===================== ARGS PARSE-GUARD =====================

test('args may arrive as a JSON string (parse-guard, like Phase A)', async () => {
  const map = {}
  const { calls } = await runScript({ args: JSON.stringify({ target: '/tmp/json', rounds: 2 }), map })
  const wf = calls.workflows.find((w) => w.name === 'deep-security-scan')
  assert.ok(wf, 'workflow invoked')
  assert.equal(wf.args.target, '/tmp/json', 'string args parsed before use')
})

test('layer 1 ran with candidates but its sub-report agent died: coverage must NOT claim "no candidates"', async () => {
  // Real case from a re-run: L1 found 1 reportable + 11 appendix, but its
  // report agent hit an API socket error, so l1.report/report_html came back null.
  const map = { l1: { ...L1_RESULT, report: null, report_html: null, report_dir: null, report_md: null } }
  const { result } = await runScript({ args: { target: '/tmp/fake' }, map })
  const ref = result.layers.l1.sub_report
  assert.ok(!/no candidates|surfaced no candidates/i.test(ref), `must not claim "no candidates" when L1 found some — got: ${ref}`)
  assert.ok(/unavailable|did not return/i.test(ref), 'should say the sub-report was unavailable')
  assert.ok(map.reportPrompt.includes('Layer 1') && map.reportPrompt.includes('RAN'), 'still RAN with its finding count')
})

test('layer 1 genuinely found nothing: coverage may say "no candidates"', async () => {
  const map = { l1: L1_EMPTY } // reportable [], no report
  const { result } = await runScript({ args: { target: '/tmp/fake' }, map })
  assert.ok(/no candidates/i.test(result.layers.l1.sub_report), 'the honest "no candidates" wording is still used when truly empty')
})

// ===================== REPORT-MD HARDENING (workflow-subagent guardrail) =====================
// The workflow runtime blocks subagents from WRITING report.md ("return findings as text,
// not write report files") while allowing report.html. So the report agent must return the
// markdown as STRUCTURED text and the orchestrator must surface it for the caller to persist.

test('report agent is called with a satisfiable schema that captures report_md + paths', async () => {
  const map = {}
  await runScript({ args: { target: '/tmp/fake' }, map })
  assert.ok(map.reportOpts && map.reportOpts.schema, 'report agent uses structured output (a schema)')
  const req = map.reportOpts.schema.required || []
  for (const k of ['output_dir', 'report_html_path', 'report_md']) {
    assert.ok(req.includes(k), `report schema requires ${k}`)
    assert.ok(map.reportOpts.schema.properties[k], `report schema defines ${k}`)
  }
  // assertSatisfiable already runs inside agent(); this just pins the contract.
})

test('orchestrator surfaces report_dir / report_html / report_md from the structured result', async () => {
  const map = {
    report: {
      output_dir: '/tmp/fake/.security-scans/Z-defense',
      report_html_path: '/tmp/fake/.security-scans/Z-defense/report.html',
      report_md: '# merged report\n\n## Coverage\nLayer 1 RAN...',
      html_written: true,
    },
  }
  const { result } = await runScript({ args: { target: '/tmp/fake' }, map })
  assert.equal(result.report_dir, '/tmp/fake/.security-scans/Z-defense', 'report_dir surfaced for the caller')
  assert.equal(result.report_html, '/tmp/fake/.security-scans/Z-defense/report.html', 'report_html path surfaced')
  assert.ok(result.report_md && result.report_md.includes('# merged report'), 'full report_md text surfaced so the caller can persist it')
})

test('orchestrator is resilient when the report agent dies (null) — fields null, no crash', async () => {
  const map = { report: null }
  const { result } = await runScript({ args: { target: '/tmp/fake' }, map })
  assert.equal(result.report_dir, null)
  assert.equal(result.report_md, null)
  assert.ok(Array.isArray(result.reportable), 'findings still returned even if the report agent dies')
})

test('report prompt: subagent must NOT write report.md, returns it as text, embeds it in html', async () => {
  const map = {}
  await runScript({ args: { target: '/tmp/fake' }, map })
  assert.ok(/do NOT write report\.md/i.test(map.reportPrompt), 'must not fight the guardrail by writing report.md')
  assert.ok(map.reportPrompt.includes('report_md'), 'must return markdown in the report_md field')
  assert.ok(/base64/i.test(map.reportPrompt), 'embeds the markdown base64-encoded (no breakout)')
  assert.ok(map.reportPrompt.includes('Download report.md'), 'HTML carries a client-side download affordance')
})

// ============= SEALED FINGERPRINTED BUNDLE + COVERAGE SCHEMA + SARIF (issue #21) =============
// The defense-scan bundle AGGREGATES the merged findings across every layer. Its coverage doc
// maps RAN-with-0-findings layers to "not observed" and SKIPPED/DISABLED/ERROR layers to
// "not scanned" exclusions — the per-layer status the orchestrator already tracks. The existing
// top-level `coverage` array (per-layer strings) is preserved; the bundle's coverage doc is nested.

test('bundle: emits a sealed defense-scan manifest/findings/coverage doc (additive to coverage[])', async () => {
  const map = { l2: L2_RAN }
  const { result } = await runScript({ args: { target: '/tmp/fake' }, map })
  assert.ok(Array.isArray(result.coverage), 'existing per-layer coverage[] array preserved')
  const b = result.bundle
  assert.ok(b && /security-bundle/.test(b.schema_version), 'schema_version present')
  assert.equal(b.manifest.tool, 'defense-scan', 'manifest names the orchestrator')
  // L1 (2 reportable) + L2_RAN (1) = 3 merged findings
  assert.equal(b.findings.length, 3, 'findings doc aggregates all layers')
  assert.ok(b.findings.every((f) => typeof f.fingerprint === 'string' && f.fingerprint), 'every merged finding is fingerprinted')
  assert.ok(b.findings.every((f) => f.layer), 'each finding keeps its layer provenance')
})

test('bundle: fingerprints are stable across identical runs', async () => {
  const a = await runScript({ args: { target: '/tmp/fake' }, map: { l2: L2_RAN } })
  const b = await runScript({ args: { target: '/tmp/fake' }, map: { l2: L2_RAN } })
  assert.deepEqual(
    a.result.bundle.findings.map((f) => f.fingerprint).sort(),
    b.result.bundle.findings.map((f) => f.fingerprint).sort(),
    'same merged findings -> identical fingerprints'
  )
})

test('coverage doc: RAN-with-0-findings -> not_observed; SKIPPED/MISSING layer -> exclusions (not scanned)', async () => {
  // L2 ran but found nothing (not observed); L3/L4/L5/L6 are skipped (not scanned).
  const { result } = await runScript({ args: { target: '/tmp/fake' }, map: { l2: L2_RAN_EMPTY } })
  const c = result.bundle.coverage
  assert.ok(['complete', 'partial', 'unknown'].includes(c.completeness))
  assert.ok(c.not_observed.some((s) => /L2/.test(s)), 'a layer that ran with no findings is "not observed"')
  assert.ok(c.exclusions.some((s) => /L3|L4|L5|L6/.test(s) && /not scanned/i.test(s)), 'skipped layers are "not scanned" exclusions')
  assert.notDeepEqual(c.not_observed, c.exclusions, '"not observed" and "not scanned" are distinct fields')
})

test('sarif: the merged findings doc projects to a valid SARIF 2.1.0 log', async () => {
  const map = { l2: L2_RAN }
  const { result } = await runScript({ args: { target: '/tmp/fake' }, map })
  const v = validateSarif(result.sarif)
  assert.ok(v.valid, `SARIF must validate; errors: ${v.errors.join('; ')}`)
  const fps = new Set(result.bundle.findings.map((f) => f.fingerprint))
  for (const res of result.sarif.runs[0].results) assert.ok(fps.has(res.partialFingerprints['shipFingerprint/v1']), 'SARIF result carries the fingerprint')
})

test('priorBundle absent: no delta, no is_new, no loader agent', async () => {
  const { result, calls } = await runScript({ args: { target: '/tmp/fake' }, map: { l2: L2_RAN } })
  assert.ok(result.bundle.coverage.delta == null)
  assert.ok(result.bundle.findings.every((f) => !('is_new' in f)))
  assert.ok(result.new_findings == null)
  assert.ok(!calls.agents.some((a) => (a.opts.label || '').startsWith('prior-bundle')))
})

test('priorBundle (object): identical re-run carries over, surfaces nothing new, reports a delta', async () => {
  const first = await runScript({ args: { target: '/tmp/fake' }, map: { l2: L2_RAN } })
  const { result } = await runScript({ args: { target: '/tmp/fake', priorBundle: first.result.bundle }, map: { l2: L2_RAN } })
  assert.ok(result.bundle.findings.every((f) => f.is_new === false), 'all carried over on identical re-run')
  assert.equal(result.new_findings.length, 0)
  assert.equal(result.bundle.coverage.delta.carried_over, 3)
  assert.equal(result.bundle.coverage.delta.new, 0)
})

test('priorBundle: a new layer finding (absent from prior) is surfaced as new', async () => {
  // Prior run had only L1 (L2 missing); this run adds L2's finding -> 1 new.
  const prior = await runScript({ args: { target: '/tmp/fake' }, map: { l2: L2_MISSING } })
  const { result } = await runScript({ args: { target: '/tmp/fake', priorBundle: prior.result.bundle }, map: { l2: L2_RAN } })
  assert.equal(result.new_findings.length, 1, 'only the new L2 finding is surfaced')
  assert.ok(result.new_findings[0].title.includes('lodash'))
  assert.equal(result.bundle.coverage.delta.new, 1)
})

test('priorBundle as a path triggers a loader relay (fail-open)', async () => {
  const map = { l2: L2_RAN, priorLoaded: { ok: false, content: '', note: 'missing' } }
  const { result } = await runScript({ args: { target: '/tmp/fake', priorBundle: '/tmp/p.json' }, map })
  assert.ok(map.sawPriorLoader, 'path prior bundle loaded via a relay')
  assert.ok(result.bundle.coverage.delta == null, 'failed load is fail-open')
})

test('report prompt carries the bundle + SARIF for embedding', async () => {
  const map = { l2: L2_RAN }
  await runScript({ args: { target: '/tmp/fake' }, map })
  assert.ok(/bundle\.json/i.test(map.reportPrompt) && /sarif/i.test(map.reportPrompt))
  assert.ok(/fingerprint/i.test(map.reportPrompt))
})

// ---------- model independence forwarding (#94 criterion 4) ----------
// Once #92 gave deep-security-scan discoveryModel/validateModel, defense-scan's Layer 1
// composition call had to forward them or Layer 1 silently keeps the old inherit-everything
// behaviour — the exact "documented but not shipped" failure #70 warns about.

test('models: Layer 1 forwards the scan model args to deep-security-scan', async () => {
  const { calls } = await runScript({ args: { target: '/tmp/fake', discoveryModel: 'opus', validateModel: 'haiku' }, map: {} })
  const wf = calls.workflows.find((w) => w.name === 'deep-security-scan')
  assert.ok(wf, 'Layer 1 composes deep-security-scan')
  assert.equal(wf.args.discoveryModel, 'opus', 'discoveryModel reaches Layer 1')
  assert.equal(wf.args.validateModel, 'haiku', 'validateModel reaches Layer 1')
})

test('models: forwarding is absent-safe — an unset arg is not forwarded as undefined-ish junk', async () => {
  const { calls } = await runScript({ args: { target: '/tmp/fake' }, map: {} })
  const wf = calls.workflows.find((w) => w.name === 'deep-security-scan')
  assert.ok(wf, 'Layer 1 still composes deep-security-scan with no model args')
  for (const k of ['discoveryModel', 'validateModel']) {
    if (k in wf.args) assert.ok(typeof wf.args[k] === 'string' && wf.args[k], k + ' is either omitted or a real string')
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
