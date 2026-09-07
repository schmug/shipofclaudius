// Static checks on the factory-intake process skill and its scaffold template set.
// Model-free, built-ins only. The scaffold is copied into every project the factory creates,
// so a drift here ships into every new repo — pin the load-bearing properties.
// Run:  node tests/factory-intake.test.mjs
import { readFile, stat } from 'node:fs/promises'
import assert from 'node:assert/strict'

const ROOT = new URL('../', import.meta.url)
const read = (rel) => readFile(new URL(rel, ROOT), 'utf8')
const exists = async (rel) => { try { await stat(new URL(rel, ROOT)); return true } catch { return false } }
const S = 'skills/factory-intake/scaffold/'

const tests = []
const test = (name, fn) => tests.push([name, fn])

// ---------- scaffold ----------

test('scaffold: every file the spec §7 lists exists', async () => {
  for (const f of ['README.md', 'package.json', 'wrangler.jsonc', 'wrangler.preview.template.jsonc', 'src/index.js', 'public/index.html',
    'test/health.test.mjs', '.github/workflows/ci.yml', 'ruleset.json', 'scripts/smoke.mjs', 'scripts/critic.mjs', 'scripts/critic-prompt.md', 'factory-reports/.gitkeep']) {
    assert.ok(await exists(S + f), `missing ${S}${f}`)
  }
})

test('scaffold: the preview template names the Worker and hostname from {{SLUG}}/{{KEY}} with a custom domain and no workers.dev', async () => {
  const t = await read(S + 'wrangler.preview.template.jsonc')
  assert.ok(/"name":\s*"factory-\{\{SLUG\}\}-\{\{KEY\}\}"/.test(t))
  assert.ok(/"pattern":\s*"\{\{SLUG\}\}-\{\{KEY\}\}\.\{\{PREVIEW_DOMAIN\}\}"/.test(t))
  assert.ok(/"custom_domain":\s*true/.test(t))
  assert.ok(/"workers_dev":\s*false/.test(t) && /"preview_urls":\s*false/.test(t))
})

test('scaffold: the production config has no {{KEY}} and routes to {{SLUG}}.{{PROD_DOMAIN}}', async () => {
  const p = await read(S + 'wrangler.jsonc')
  assert.ok(!p.includes('{{KEY}}'))
  assert.ok(/"pattern":\s*"\{\{SLUG\}\}\.\{\{PROD_DOMAIN\}\}"/.test(p))
  assert.ok(!/d1_databases|kv_namespaces|durable_objects|queues/.test(p), 'stateless: no storage bindings')
})

test('scaffold: CI pins every action by 40-char SHA, sets timeout-minutes, and its job id is `test` (the ruleset context)', async () => {
  const ci = await read(S + '.github/workflows/ci.yml')
  for (const m of ci.matchAll(/uses:\s*(\S+)/g)) assert.ok(/@[0-9a-f]{40}\b/.test(m[1]), `unpinned action: ${m[1]}`)
  assert.ok(/timeout-minutes:\s*\d+/.test(ci))
  assert.ok(/^\s{2}test:\s*$/m.test(ci), 'the job id is `test`')
  const rs = JSON.parse(await read(S + 'ruleset.json'))
  const rsc = rs.rules.find((r) => r.type === 'required_status_checks')
  assert.deepEqual(rsc.parameters.required_status_checks.map((c) => c.context), ['test'])
  assert.ok(rs.rules.some((r) => r.type === 'non_fast_forward') && rs.rules.some((r) => r.type === 'deletion'))
  assert.deepEqual(rs.conditions.ref_name.include, ['~DEFAULT_BRANCH'])
})

test('scaffold: smoke.mjs and critic.mjs read the service token from process.env only and never print it', async () => {
  for (const f of ['scripts/smoke.mjs', 'scripts/critic.mjs']) {
    const src = await read(S + f)
    assert.ok(src.includes('process.env.CF_ACCESS_CLIENT_ID') && src.includes('process.env.CF_ACCESS_CLIENT_SECRET'), `${f}: reads both from process.env`)
    for (const line of src.split('\n')) {
      if (/console\.(log|error)|writeFileSync|process\.stdout/.test(line)) assert.ok(!/CF_ACCESS_CLIENT_SECRET/.test(line), `${f}: a print/write line names the secret: ${line.trim()}`)
    }
  }
})

test('scaffold: package.json pins no devDependency versions itself (the skill installs latest at scaffold time) and the test script is node --test', async () => {
  const p = JSON.parse(await read(S + 'package.json'))
  assert.equal(p.devDependencies, undefined, 'devDependencies are added by `npm install --save-dev` during scaffold')
  // Bare `node --test`: its default patterns match test/*.test.mjs on Node 20 and 22. A
  // directory positional (`node --test test/`) is a module path on Node >= 21 and fails
  // with MODULE_NOT_FOUND — verified on v22.22.3, the version the scaffold's CI pins.
  assert.equal(p.scripts.test, 'node --test')
  assert.equal(p.type, 'module')
})

test('scaffold: src/index.js is stateless and never fetches a request-derived URL', async () => {
  const src = await read(S + 'src/index.js')
  assert.ok(!/fetch\(\s*(url|request\.url|new URL\(request)/.test(src))
  assert.ok(/env\.ASSETS\.fetch\(request\)/.test(src), 'static assets served via the ASSETS binding')
})

test('scaffold: the critic prompt keeps the five factory categories and leaves {{LIVE_URL}} for run time', async () => {
  const p = await read(S + 'scripts/critic-prompt.md')
  for (const k of ['design', 'mobile_ux', 'completeness', 'performance', 'code_quality']) assert.ok(p.includes(`"${k}"`), `category key ${k}`)
  assert.ok(p.includes('{{LIVE_URL}}'))
  assert.ok(/Score what EXISTS, not what is promised/.test(p))
})

// ---------- the process skill ----------

test('factory-intake: exists as a process skill with the required frontmatter and no scriptPath', async () => {
  const md = await read('skills/factory-intake/SKILL.md')
  assert.ok(/^name: factory-intake$/m.test(md))
  assert.ok(/^workflow:\s*none$/m.test(md))
  const line = md.match(/^description:[ \t]*(\S.*)$/m)
  assert.ok(line && line[1].length > 80, 'single-line, substantive description')
  assert.ok(!md.includes('scriptPath'))
})

test('factory-intake: carries the autonomy sentence, names its four check-ins, and ends with the last-paragraph rule', async () => {
  const md = await read('skills/factory-intake/SKILL.md')
  assert.ok(md.includes('You are operating autonomously from this point'))
  for (const c of ['refine', 'spec review', 'approval', 'iterate feedback']) assert.ok(new RegExp(c, 'i').test(md), `names the ${c} check-in`)
  assert.ok(/Before ending your turn, check your last paragraph\./.test(md))
  assert.ok(md.indexOf('You are operating autonomously') < md.indexOf('Before ending your turn'))
})

test('factory-intake: invokes factory-build and merge-pr-with-gate by skill name, and reads domains from the environment', async () => {
  const md = await read('skills/factory-intake/SKILL.md')
  assert.ok(/`factory-build`/.test(md) && /`merge-pr-with-gate`/.test(md))
  for (const v of ['FACTORY_PREVIEW_DOMAIN', 'FACTORY_PROD_DOMAIN', 'CF_ACCESS_CLIENT_ID', 'CF_ACCESS_CLIENT_SECRET']) assert.ok(md.includes(v), `names ${v}`)
  assert.ok(!/cortech|schmug|coryrank/i.test(md), 'no personal domain or account in a public skill')
})

test('factory-intake: the write ladder is draft PR → human approval → gated merge → production deploy, and nothing is deleted on stop', async () => {
  const md = await read('skills/factory-intake/SKILL.md')
  assert.ok(/gh pr ready/.test(md))
  assert.ok(/execute:\s*true/.test(md))
  assert.ok(/--admin/.test(md) && /never/i.test(md.slice(md.indexOf('--admin') - 80, md.indexOf('--admin'))), 'names --admin only to forbid it')
  assert.ok(/wrangler delete --name factory-/.test(md))
  assert.ok(/Stop[^\n]*deletes? nothing|nothing is deleted/i.test(md))
})

test('factory-intake: every referenced references/ file exists and the scaffold directory is named without the references/ prefix', async () => {
  const md = await read('skills/factory-intake/SKILL.md')
  for (const m of md.matchAll(/references\/([\w.-]+)/g)) assert.ok(await exists(`skills/factory-intake/references/${m[1]}`), m[1])
  assert.ok(md.includes('scaffold/') && !md.includes('references/scaffold'))
})

// ---- runner ----
let failed = 0
for (const [name, fn] of tests) {
  try { await fn(); console.log('PASS', name) }
  catch (e) { failed++; console.error('FAIL', name, '\n  ', e.message) }
}
console.log(failed ? `\n${failed}/${tests.length} FAILED` : `\nall ${tests.length} passed`)
process.exit(failed ? 1 : 0)
