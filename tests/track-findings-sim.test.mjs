// Offline simulator tests for ~/.claude/workflows/track-findings.js.
// Stubs agent()/parallel()/phase()/log() so the bridge's orchestration logic
// (fingerprint dedup, visibility routing, stage-vs-execute gating, exact-payload
// previews, untrusted-string escaping, serial file + readback) is testable in
// milliseconds with zero token spend and ZERO outward writes.  Run:
//   node tests/track-findings-sim.test.mjs
import { readFile } from 'node:fs/promises'
import assert from 'node:assert/strict'

const SRC_PATH = new URL('../.claude/workflows/track-findings.js', import.meta.url)
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
  let fileInFlight = 0
  let maxFileInFlight = 0
  const agent = async (prompt, opts = {}) => {
    calls.agents.push({ prompt, opts })
    if (opts.schema) assertSatisfiable(opts.schema, opts.label || '?')
    const isFile = (opts.label || '').startsWith('file:')
    if (isFile) { fileInFlight++; maxFileInFlight = Math.max(maxFileInFlight, fileInFlight) }
    await new Promise((r) => setTimeout(r, 2)) // let any concurrency overlap
    try { return await stubs(prompt, opts) } finally { if (isFile) fileInFlight-- }
  }
  const parallel = (thunks) => Promise.all(thunks.map((t) => Promise.resolve().then(t).catch(() => null)))
  const phase = (t) => calls.phases.push(t)
  const log = (m) => calls.logs.push(m)
  const fn = new AsyncFunction('args', 'budget', 'agent', 'parallel', 'pipeline', 'phase', 'log', 'workflow', src)
  const result = await fn(args, undefined, agent, parallel, null, phase, log, null)
  return { result, calls, maxFileInFlight: () => maxFileInFlight }
}

// ---- canned data ----
// A fingerprinted bundle in #21's documented shape: findings[] each carry a stable `fingerprint`.
const bundleFp = {
  findings: [
    { id: 'f1', fingerprint: 'fp-AAAA', title: 'SQL injection in db layer', file: 'src/db.ts', line: 42, vuln_class: 'sql-injection', severity: 'high', evidence: 'user input -> db.raw', fix: 'parameterize', cvss_vector: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:N' },
    { id: 'f2', fingerprint: 'fp-BBBB', title: 'IDOR on /api/items', file: 'src/api.ts', line: 10, vuln_class: 'idor', severity: 'medium', evidence: 'no owner check', fix: 'check ownership' },
    { id: 'f3', fingerprint: 'fp-CCCC', title: 'XSS in template', file: 'src/view.ts', line: 7, vuln_class: 'xss', severity: 'low', evidence: 'unescaped', fix: 'escape' },
  ],
  coverage: { completeness: 'partial' },
}

// Existing tracker items: fp-BBBB already filed and OPEN (=> reuse), fp-CCCC filed but CLOSED (=> skip).
const existingPrivate = [
  { fingerprint: 'fp-BBBB', ref: '#101', url: 'https://github.com/o/r/issues/101', state: 'open', title: 'IDOR on /api/items' },
  { fingerprint: 'fp-CCCC', ref: '#88', url: 'https://github.com/o/r/issues/88', state: 'closed', title: 'XSS in template' },
]

function ctx(visibility, existing) {
  const destination = visibility === 'PUBLIC' ? 'ghsa' : 'issue'
  return { repo: 'o/r', visibility, destination, existing: existing || [] }
}

// stub builder. map controls visibility/existing and records file payloads.
function stubsFor(map) {
  map.fileCalls = []
  return (prompt, opts) => {
    const l = opts.label || ''
    if (l.startsWith('context:')) { map.sawContext = true; map.contextPrompt = prompt; return map.context }
    if (l.startsWith('load:')) { map.sawLoad = true; return map.loaded }
    if (l.startsWith('file:')) {
      map.fileCalls.push({ prompt, opts })
      const id = l.slice('file:'.length)
      if (map.fileResult) return map.fileResult(id, prompt)
      return { id, filed: true, ref: '#200', url: 'https://github.com/o/r/issues/200', state: map.context.destination === 'ghsa' ? 'draft' : 'open', readback_ok: true, fingerprint_present: true }
    }
    throw new Error('unexpected agent label: ' + l)
  }
}

const tests = []
const test = (name, fn) => tests.push([name, fn])

// ===================== STAGE MODE: PREVIEW, NO WRITES =====================

test('stage (default): produces previews and makes ZERO file: agent calls (no auto-file)', async () => {
  const map = { context: ctx('PRIVATE', existingPrivate) }
  const { result, calls } = await runScript({ args: { bundle: bundleFp, repo: 'o/r' }, stubs: stubsFor(map) })
  assert.equal(result.mode, 'stage', 'default run is stage mode')
  assert.ok(Array.isArray(result.previews) && result.previews.length >= 1, 'stage emits payload previews')
  assert.ok(!calls.agents.some((a) => (a.opts.label || '').startsWith('file:')), 'stage mode must NOT file anything')
  assert.equal(map.fileCalls.length, 0, 'no write agents ran in stage mode')
})

test('stage: every create preview carries an EXACT payload (title + body) for the human to review', async () => {
  const map = { context: ctx('PRIVATE', existingPrivate) }
  const { result } = await runScript({ args: { bundle: bundleFp, repo: 'o/r' }, stubs: stubsFor(map) })
  const creates = result.previews.filter((p) => p.outcome === 'create')
  assert.ok(creates.length >= 1, 'at least one create preview')
  for (const p of creates) {
    assert.ok(p.payload, `preview ${p.id} has a payload`)
    assert.ok(p.payload.title && p.payload.title.length > 0, 'payload has a title')
    assert.ok(p.payload.body && p.payload.body.length > 0, 'payload has a body')
  }
})

// ===================== DEDUP BY FINGERPRINT (create / reuse / skip) =====================

test('dedup: new fp -> create, open existing fp -> reuse, closed existing fp -> skip', async () => {
  const map = { context: ctx('PRIVATE', existingPrivate) }
  const { result } = await runScript({ args: { bundle: bundleFp, repo: 'o/r' }, stubs: stubsFor(map) })
  const byId = Object.fromEntries(result.plan.map((p) => [p.id, p]))
  assert.equal(byId.f1.outcome, 'create', 'fp-AAAA is new -> create')
  assert.equal(byId.f2.outcome, 'reuse', 'fp-BBBB open -> reuse')
  assert.equal(byId.f3.outcome, 'skip', 'fp-CCCC closed -> skip')
  assert.equal(result.counts.create, 1)
  assert.equal(result.counts.reuse, 1)
  assert.equal(result.counts.skip, 1)
})

test('dedup: reuse carries the existing tracker ref so the human can find it', async () => {
  const map = { context: ctx('PRIVATE', existingPrivate) }
  const { result } = await runScript({ args: { bundle: bundleFp, repo: 'o/r' }, stubs: stubsFor(map) })
  const reuse = result.plan.find((p) => p.outcome === 'reuse')
  assert.ok(reuse.existing_ref === '#101' || (reuse.existing && reuse.existing.ref === '#101'), 'reuse points at the open item')
})

// ===================== VISIBILITY ROUTING =====================

test('routing: PUBLIC repo routes creates to a draft GHSA', async () => {
  const map = { context: ctx('PUBLIC', []) }
  const { result } = await runScript({ args: { bundle: bundleFp, repo: 'o/r' }, stubs: stubsFor(map) })
  assert.equal(result.destination, 'ghsa', 'public -> ghsa')
  assert.ok(result.previews.every((p) => p.destination === 'ghsa'), 'every preview targets ghsa')
})

test('routing: PRIVATE repo routes creates to a security-labeled issue', async () => {
  const map = { context: ctx('PRIVATE', []) }
  const { result } = await runScript({ args: { bundle: bundleFp, repo: 'o/r' }, stubs: stubsFor(map) })
  assert.equal(result.destination, 'issue', 'private -> issue')
  const create = result.previews.find((p) => p.outcome === 'create')
  const labels = create.payload.labels || []
  assert.ok(labels.includes('security'), 'issue payload is labeled security')
})

test('routing: INTERNAL repo also routes to an issue, never a public issue for a vuln', async () => {
  const map = { context: ctx('INTERNAL', []) }
  const { result } = await runScript({ args: { bundle: bundleFp, repo: 'o/r' }, stubs: stubsFor(map) })
  assert.equal(result.destination, 'issue', 'internal -> issue')
  // never an unlabeled / public-style issue: security label is the marker
  const create = result.previews.find((p) => p.outcome === 'create')
  assert.ok((create.payload.labels || []).includes('security'))
})

// ===================== FINGERPRINT CARRIED FOR FUTURE DEDUP =====================

test('payload embeds the canonical fingerprint so future runs can dedup against it', async () => {
  const map = { context: ctx('PRIVATE', []) }
  const { result } = await runScript({ args: { bundle: bundleFp, repo: 'o/r' }, stubs: stubsFor(map) })
  const create = result.previews.find((p) => p.id === 'f1')
  assert.ok(create.payload.body.includes('fp-AAAA'), 'body carries the fingerprint marker')
  assert.ok(create.fingerprint === 'fp-AAAA', 'plan/preview records the fingerprint')
})

// ===================== UNTRUSTED-STRING ESCAPING =====================

test('untrusted bundle strings are escaped in the payload body (no raw <script>)', async () => {
  const evil = {
    findings: [
      { id: 'x1', fingerprint: 'fp-EVIL', title: '<script>alert(1)</script>\nsecond line', file: 'a&b/<x>.ts', line: 1, vuln_class: 'xss', severity: 'high', evidence: '</textarea><img src=x onerror=alert(1)>', fix: 'f' },
    ],
  }
  const map = { context: ctx('PRIVATE', []) }
  const { result } = await runScript({ args: { bundle: evil, repo: 'o/r' }, stubs: stubsFor(map) })
  const p = result.previews.find((pp) => pp.id === 'x1')
  assert.ok(!/<script>/.test(p.payload.body), 'raw <script> must be escaped out of the body')
  assert.ok(!/onerror=/.test(p.payload.body) || /&lt;img/.test(p.payload.body), 'raw event-handler HTML must be neutralized')
  assert.ok(!/\n.*\n/.test(p.payload.title) && !p.payload.title.includes('\n'), 'title is sanitized to a single line')
})

test('the file-agent prompt never shell-concats the body — it instructs --body-file / --rawfile', async () => {
  const map = { context: ctx('PRIVATE', []) }
  await runScript({ args: { bundle: bundleFp, repo: 'o/r', execute: true }, stubs: stubsFor(map) })
  assert.ok(map.fileCalls.length >= 1, 'execute mode runs file agents')
  for (const fc of map.fileCalls) {
    assert.ok(/body-file|rawfile|--body-file|--rawfile/i.test(fc.prompt), 'write must go through a file, not inline shell concat')
  }
})

// ===================== EXECUTE GATE: SERIAL FILE + READBACK =====================

test('execute: files ONLY the creates, not the reuse/skip', async () => {
  const map = { context: ctx('PRIVATE', existingPrivate) }
  const { result } = await runScript({ args: { bundle: bundleFp, repo: 'o/r', execute: true }, stubs: stubsFor(map) })
  assert.equal(result.mode, 'execute', 'execute mode')
  assert.equal(map.fileCalls.length, 1, 'only the single create is filed (reuse + skip are not)')
  const filedIds = map.fileCalls.map((fc) => (fc.opts.label || '').slice('file:'.length))
  assert.deepEqual(filedIds, ['f1'], 'the create (f1) is the only thing filed')
})

test('execute: filing is SERIAL (max one file agent in flight)', async () => {
  // bundle of 3 creates, no existing items
  const many = { findings: Array.from({ length: 3 }, (_, i) => ({ id: `n${i}`, fingerprint: `fp-N${i}`, title: `finding ${i}`, file: `src/f${i}.ts`, line: 1, vuln_class: 'xss', severity: 'high', evidence: 'e', fix: 'f' })) }
  const map = { context: ctx('PRIVATE', []) }
  const { maxFileInFlight } = await runScript({ args: { bundle: many, repo: 'o/r', execute: true }, stubs: stubsFor(map) })
  assert.equal(maxFileInFlight(), 1, `filing must be serial; saw ${maxFileInFlight()} concurrent`)
})

test('execute: each filed item is read back and only counted filed when readback confirms', async () => {
  const map = { context: ctx('PRIVATE', []) }
  const { result } = await runScript({ args: { bundle: bundleFp, repo: 'o/r', execute: true }, stubs: stubsFor(map) })
  assert.ok(Array.isArray(result.filed) && result.filed.length >= 1, 'filed list present')
  for (const f of result.filed) {
    assert.equal(f.readback_ok, true, 'filed items confirmed via readback')
    assert.ok(f.ref || f.url, 'filed item carries a tracker ref/url')
  }
})

test('execute: an uncertain write is reported as uncertain and NOT retried', async () => {
  const oneNew = { findings: [bundleFp.findings[0]] } // single create (fp-AAAA), no existing items
  const map = {
    context: ctx('PRIVATE', []),
    fileResult: (id) => ({ id, filed: 'uncertain', ref: null, url: null, state: 'unknown', readback_ok: false, note: 'create returned non-zero but item may exist' }),
  }
  const { result } = await runScript({ args: { bundle: oneNew, repo: 'o/r', execute: true }, stubs: stubsFor(map) })
  // exactly one create -> exactly one file attempt, no retry
  assert.equal(map.fileCalls.length, 1, 'no retry on uncertain write')
  assert.ok(Array.isArray(result.uncertain) && result.uncertain.length === 1, 'uncertain write surfaced')
  assert.ok(!result.filed || result.filed.length === 0, 'uncertain write is not counted as filed')
})

test('execute: re-checks existing items before writing (recheck-after-approval)', async () => {
  const map = { context: ctx('PRIVATE', existingPrivate) }
  const { calls } = await runScript({ args: { bundle: bundleFp, repo: 'o/r', execute: true }, stubs: stubsFor(map) })
  assert.ok(calls.agents.some((a) => (a.opts.label || '').startsWith('context:')), 'execute mode re-derives context before filing')
})

// ===================== GRACEFUL DEGRADATION (no fingerprints) =====================

test('degraded: bundle without fingerprints -> dedup_mode degraded, still previews, all create', async () => {
  const noFp = {
    reportable: [
      { id: 'r1', title: 'sqli', file: 'src/db.ts', line: 42, vuln_class: 'sql-injection', severity: 'high', evidence: 'e', fix: 'f' },
      { id: 'r2', title: 'idor', file: 'src/api.ts', line: 10, vuln_class: 'idor', severity: 'medium', evidence: 'e', fix: 'f' },
    ],
  }
  const map = { context: ctx('PRIVATE', []) }
  const { result } = await runScript({ args: { bundle: noFp, repo: 'o/r' }, stubs: stubsFor(map) })
  assert.equal(result.dedup_mode, 'degraded', 'no bundle fingerprints -> degraded dedup')
  assert.equal(result.previews.filter((p) => p.outcome === 'create').length, 2, 'all findings create when no prior dedup data')
  assert.ok(/degrad|no.*cross-run|fingerprint/i.test(result.coverage || ''), 'coverage states dedup is degraded')
})

test('degraded: a deterministic local fallback id is still embedded for future runs', async () => {
  const noFp = { reportable: [{ id: 'r1', title: 'sqli', file: 'src/db.ts', line: 42, vuln_class: 'sql-injection', severity: 'high', evidence: 'e', fix: 'f' }] }
  const map = { context: ctx('PRIVATE', []) }
  const { result } = await runScript({ args: { bundle: noFp, repo: 'o/r' }, stubs: stubsFor(map) })
  const p = result.previews[0]
  assert.ok(p.fingerprint && p.fingerprint.length > 0, 'a fallback fingerprint exists')
  assert.equal(p.fingerprint_source, 'local', 'and is marked as a local fallback (not bundle-provided)')
  assert.ok(p.payload.body.includes(p.fingerprint), 'fallback id embedded for future dedup')
})

// ===================== BUNDLE LOADING (path) =====================

test('args.bundlePath: a load agent reads + parses the bundle file', async () => {
  const map = { context: ctx('PRIVATE', []), loaded: { raw: JSON.stringify(bundleFp) } }
  const { result, calls } = await runScript({ args: { bundlePath: '/tmp/bundle.json', repo: 'o/r' }, stubs: stubsFor(map) })
  assert.ok(calls.agents.some((a) => (a.opts.label || '').startsWith('load:')), 'load agent ran for a path bundle')
  assert.equal(result.previews.filter((p) => p.outcome === 'create').length, 3, 'loaded findings flow through to previews')
})

// ===================== EMPTY / EDGE =====================

test('empty bundle -> no previews, no writes, explanatory note', async () => {
  const map = { context: ctx('PRIVATE', []) }
  const { result, calls } = await runScript({ args: { bundle: { findings: [] }, repo: 'o/r' }, stubs: stubsFor(map) })
  assert.ok(!calls.agents.some((a) => (a.opts.label || '').startsWith('file:')), 'no writes for an empty bundle')
  assert.ok(result.note || (result.previews && result.previews.length === 0), 'empty bundle is reported, not crashed')
})

test('all-reuse/skip bundle in execute mode files nothing', async () => {
  const onlyDup = { findings: [bundleFp.findings[1], bundleFp.findings[2]] } // fp-BBBB(open)->reuse, fp-CCCC(closed)->skip
  const map = { context: ctx('PRIVATE', existingPrivate) }
  const { result } = await runScript({ args: { bundle: onlyDup, repo: 'o/r', execute: true }, stubs: stubsFor(map) })
  assert.equal(map.fileCalls.length, 0, 'nothing to create -> nothing filed')
  assert.ok((result.filed || []).length === 0)
})

// ---- runner ----
let failed = 0
for (const [name, fn] of tests) {
  try { await fn(); console.log('PASS', name) }
  catch (e) { failed++; console.error('FAIL', name, '\n  ', e.message) }
}
console.log(failed ? `\n${failed}/${tests.length} FAILED` : `\nall ${tests.length} passed`)
process.exit(failed ? 1 : 0)
