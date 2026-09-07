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
  assert.ok(!/^\s{4}name:/m.test(ci), 'the test job carries no name: key (a job name would change the check context the ruleset requires)')
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
      if (/console\.(log|error|warn|info|debug)|process\.(stdout|stderr)|writeFileSync/.test(line)) assert.ok(!/CF_ACCESS_CLIENT_SECRET/.test(line), `${f}: a print/write line names the secret: ${line.trim()}`)
    }
  }
})

// B-2 (round 4): a header set on the browser context goes out with every request the page makes,
// to any host. Routing attaches the token only to same-origin requests and aborts the rest.
test('scaffold: smoke.mjs sends the service token only to the candidate origin and caps page-controlled text', async () => {
  const src = await read(S + 'scripts/smoke.mjs')
  assert.ok(!src.includes('extraHTTPHeaders'), 'no context-wide header')
  assert.ok(src.includes('page.route(') && src.includes('route.abort()'), 'same-origin routing with cross-origin abort')
  assert.ok(/new URL\(req\.url\(\)\)\.origin === origin/.test(src), 'the origin comparison is exact')
  assert.ok(src.indexOf('page.route(') < src.indexOf('page.goto('), 'the route is installed before navigation')
  // W-5 (round 4): at most 20 console/pageerror entries of 200 chars each reach smoke.json.
  assert.ok(/errors\.length < 20/.test(src) && /\.slice\(0, 200\)/.test(src), 'console/pageerror text is capped')
})

// B2/B3 (PR #203 re-review): the runner used to run `npm test` and `wrangler deploy --dry-run`,
// which execute candidate files in the session with the token present and outside the tamper
// guard's reach. Gate evidence is CI's now. THREAT_MODEL.md invariant 9.
test('scaffold: critic.mjs executes only git, gh, and the critic command — never npm, npx, wrangler, or anything candidate-authored', async () => {
  const src = await read(S + 'scripts/critic.mjs')
  assert.ok(!/\b(npm|npx|wrangler)\b/.test(src), 'no npm/npx/wrangler token anywhere in the file')
  // tryRun is the one wrapper; its body forwards its own (cmd, args) and is checked on its own.
  const wrapper = src.match(/function tryRun\(cmd, args[^\n]*\n[\s\S]*?\n\}/)
  assert.ok(wrapper && /execFileSync\(cmd, args,/.test(wrapper[0]), 'tryRun forwards (cmd, args) to execFileSync')
  const rest = src.replace(wrapper[0], '')
  const firstArgs = [...rest.matchAll(/\b(?:execFileSync|tryRun)\(\s*([^,)]+)/g)].map((m) => m[1].trim())
  assert.ok(firstArgs.length >= 4, `found the call sites (${firstArgs.length})`)
  for (const a of firstArgs) assert.ok(['"git"', '"gh"', 'CRITIC.cmd'].includes(a), `disallowed child process: ${a}`)
  for (const a of ['"git"', '"gh"', 'CRITIC.cmd']) assert.ok(firstArgs.includes(a), `${a} is still invoked`)
  assert.ok(/tryRun\("gh", \["run", "list", "--commit", sha, "--json", "name,conclusion,url"/.test(rest), 'CI evidence comes from gh run list --commit <sha>')
  assert.ok(/tryRun\("git", \["rev-parse", "HEAD"\]\)/.test(rest), 'the revision under review is still recorded')
})

// W1: the critic's own sandbox is codex's control, not ours; the scrubbed environment is what
// keeps a prompt-injected critic from holding the token at all.
test('scaffold: critic.mjs launches the critic with both Access variables deleted from its environment', async () => {
  const src = await read(S + 'scripts/critic.mjs')
  assert.ok(src.includes('delete env.CF_ACCESS_CLIENT_ID') && src.includes('delete env.CF_ACCESS_CLIENT_SECRET'), 'both halves are deleted from the env copy')
  const call = src.match(/execFileSync\(CRITIC\.cmd,[\s\S]*?\}\);/)
  assert.ok(call && /\benv\b\s*[,}]/.test(call[0]), 'the critic execFileSync options carry the scrubbed env')
  assert.ok(src.indexOf('delete env.CF_ACCESS_CLIENT_SECRET') < src.indexOf('execFileSync(CRITIC.cmd'), 'scrubbed before the critic runs')
  // B-4b (round 4): the environment is an allowlist, not a scrubbed copy of process.env.
  assert.ok(/for \(const k of \['PATH'/.test(src), 'the critic env is built from an allowlist')
  assert.ok(!src.includes('{ ...process.env }'), 'no copy of the whole session environment')
})

// B-4a/c (round 4): codex treats AGENTS.md as trusted instructions, and its verdict is model output
// over candidate-controlled evidence (it can read the disk inside its sandbox). The runner strips the
// files, disables project docs, and writes only a capped, secret-scrubbed shape.
test('scaffold: critic.mjs strips AGENTS.md from the evidence clone, disables project docs, and writes a capped, secret-scrubbed verdict', async () => {
  const src = await read(S + 'scripts/critic.mjs')
  assert.ok(/"exec", "-c", "project_doc_max_bytes=0"/.test(src), 'project_doc_max_bytes=0 right after exec')
  assert.ok(src.includes('AGENTS.md'), 'names AGENTS.md')
  assert.ok(/readdirSync\(work, \{ recursive: true \}\)/.test(src) && /rmSync\(/.test(src), 'walks the clone and removes each copy')
  assert.ok(src.indexOf('rmSync(') < src.indexOf('execFileSync(CRITIC.cmd'), 'stripped before the critic runs')
  assert.ok(/oauth_token\|refresh_token/.test(src), 'the secret-pattern scrub is present')
  assert.ok(src.includes('verdict withheld: evidence matched a secret pattern'))
  assert.ok(/title: str\(f\?\.title, 120\)/.test(src) && /detail: str\(f\?\.detail, 400\)/.test(src), 'title and detail are capped')
  assert.ok(!/\bsummary\b/.test(src), 'summary is dropped (never named)')
  const scrubAt = src.indexOf('SECRET_PATTERN.test(')
  const writeAt = src.indexOf('"critic.json"')
  assert.ok(scrubAt > -1 && writeAt > -1 && scrubAt < writeAt, 'the scrub precedes the critic.json write')
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
  // Every occurrence, not only the first: "never" within the 80 chars before it, or inside the
  // autonomy-boundary sentence that lists the forbidden actions and ends "never do it".
  const boundary = md.match(/Anything else that would need[^\n]*?never do it/)
  assert.ok(boundary, 'the autonomy boundary lists the forbidden actions and ends "never do it"')
  const inBoundary = (i) => i >= boundary.index && i < boundary.index + boundary[0].length
  for (const m of md.matchAll(/--admin/g)) {
    const before = md.slice(Math.max(0, m.index - 80), m.index)
    assert.ok(/never/i.test(before) || inBoundary(m.index), `--admin at ${m.index} is outside any prohibition: …${before.slice(-40)}--admin`)
  }
  assert.ok(/wrangler delete --name factory-/.test(md))
  assert.ok(/Stop[^\n]*deletes? nothing|nothing is deleted/i.test(md))
})

test('factory-intake: every referenced references/ file exists and the scaffold directory is named without the references/ prefix', async () => {
  const md = await read('skills/factory-intake/SKILL.md')
  for (const m of md.matchAll(/references\/([\w.-]+)/g)) assert.ok(await exists(`skills/factory-intake/references/${m[1]}`), m[1])
  assert.ok(md.includes('scaffold/') && !md.includes('references/scaffold'))
})

// The build agent is untrusted and can rewrite scripts/smoke.mjs on its branch; the skill runs
// that script in the session where CF_ACCESS_CLIENT_* live. THREAT_MODEL.md invariant 8.
test('factory-intake: runs the SCAFFOLD_SHA tamper guard before any candidate-authored file executes (Phase 7 scoring, Phase 9 deploy)', async () => {
  const md = await read('skills/factory-intake/SKILL.md')
  assert.ok(/SCAFFOLD_SHA=\$\(git rev-parse HEAD\)/.test(md), 'Phase 4 records the scaffold commit')
  const guards = [...md.matchAll(/git diff --quiet "\$SCAFFOLD_SHA"/g)]
  assert.ok(guards.length >= 2, `the guard appears at least twice (found ${guards.length})`)
  for (const g of guards) {
    const line = md.slice(g.index, md.indexOf('\n', g.index))
    // B5: npm-shrinkwrap.json overrides package-lock.json for npm ci; .npmrc sets npm's script shell
    // and registry; wrangler.json / wrangler.toml can be picked over wrangler.jsonc by config discovery.
    // B-3 (round 4): wrangler loads `.env` from the project directory, so a committed `.env*` /
    // `.dev.vars*` (or a `.gitignore` edit that lets one in) redirects every wrangler command.
    assert.ok(/ HEAD -- scripts\/ package\.json package-lock\.json npm-shrinkwrap\.json \.npmrc '\.env\*' '\.dev\.vars\*' \.gitignore wrangler\.jsonc wrangler\.json wrangler\.toml wrangler\.preview\.template\.jsonc \.github\/ \|\| echo TAMPERED/.test(line), `guard names the full path set: ${line}`)
  }
  assert.ok(md.includes('unverified: candidate modified factory scripts'), 'a tampered candidate is presented as unverified')
  // B1: Phase 7 scores in a clone the session made itself. The build agent's directory holds
  // uncommitted files, node_modules, and .git/hooks that a commit-to-commit diff cannot see.
  const p7 = md.slice(md.indexOf('## Phase 7'), md.indexOf('## Phase 8'))
  const clone = p7.indexOf('git clone --branch factory/<key> --single-branch')
  const p7guard = p7.indexOf('git diff --quiet "$SCAFFOLD_SHA"')
  assert.ok(clone > -1 && p7guard > -1 && clone < p7guard, 'Phase 7 clones the candidate branch itself before its guard')
  assert.ok(p7.includes('score-<key>'), 'the session-made clone is score-<key>')
  assert.ok(/never `cd`s into `\$\{TMPDIR:-\/tmp\}\/factory\/<slug>\/<key>`/.test(p7), 'the build agent directory is named as off-limits')
  // B3: the rendered preview config is not in the diff set (it did not exist at SCAFFOLD_SHA), so
  // it is compared against a fresh rendering, between the guard and anything that executes.
  const inst = p7.indexOf('diff <(sed "s/{{KEY}}/<key>/g" wrangler.preview.template.jsonc) "wrangler.preview.<key>.jsonc" >/dev/null || echo TAMPERED')
  const npmci = p7.indexOf('npm ci')
  const smoke = p7.indexOf('node scripts/smoke.mjs')
  assert.ok(inst > p7guard && inst < npmci && npmci < smoke, 'guard → instance check → npm ci → smoke, in that order')
  assert.ok(guards[0].index < md.indexOf('node scripts/smoke.mjs'), 'the first guard precedes the smoke run')
  const deploy = md.lastIndexOf('npm ci && npx wrangler deploy --config wrangler.jsonc')
  assert.ok(deploy > 0 && guards[guards.length - 1].index < deploy, 'the last guard precedes the production deploy, which names its config explicitly')
  // B-1 (round 4): APFS folds case and some look-alike letters, so a candidate path can overwrite a
  // guarded file on disk while the tree diff stays clean. Three checkout checks follow each guard.
  const CHECKOUT_CHECKS = [
    "git ls-tree -r --name-only -z HEAD | LC_ALL=C grep -qz '[^ -~]' && echo TAMPERED",
    "git ls-tree -r --name-only HEAD | tr 'A-Z' 'a-z' | sort | uniq -d | grep -q . && echo TAMPERED",
    'git status --porcelain | grep -q . && echo TAMPERED',
  ]
  for (const c of CHECKOUT_CHECKS) {
    const n = md.split(c).length - 1
    assert.ok(n >= 2, `checkout check appears at least twice (found ${n}): ${c}`)
    const i7 = p7.indexOf(c)
    assert.ok(i7 > p7guard && i7 < inst, `Phase 7 runs it between the tree diff and the instance check: ${c}`)
    const i9 = md.indexOf(c, guards[guards.length - 1].index)
    assert.ok(i9 > -1 && i9 < deploy, `Phase 9 runs it before the production deploy: ${c}`)
  }
})

// W2 + B4: the evidence commit is scrubbed for the token value first (naming the variable, never
// the value, so a logged command carries no secret) and only the three evidence files are
// committed; every wrangler delete runs from the release clone, whose files passed the guard.
test('factory-intake: scrubs evidence for the service token before committing, keeps the critic transcript local, and deletes previews only from the release clone', async () => {
  const md = await read('skills/factory-intake/SKILL.md')
  const p7 = md.slice(md.indexOf('## Phase 7'), md.indexOf('## Phase 8'))
  const scrub = p7.indexOf('grep -rqF -- "$CF_ACCESS_CLIENT_SECRET" factory-reports/<key>/')
  const add = p7.indexOf('git add factory-reports/<key>/')
  assert.ok(scrub > -1 && add > -1 && scrub < add, 'the scrub precedes git add')
  assert.ok(p7.includes('SECRET LEAKED into evidence; not committing'))
  const addLine = p7.slice(add, p7.indexOf('\n', add))
  assert.ok(addLine.includes('smoke.json') && addLine.includes('critic.json') && addLine.includes('screenshot-mobile.png'), `the three evidence files: ${addLine}`)
  assert.ok(!addLine.includes('critic.md') && /`critic\.md`[^\n]*stay(s)? local/.test(p7), 'the critic transcript is not committed')
  // W-4 (round 4): both halves of the token are scrubbed, each on its own line, before git add.
  const scrubId = p7.indexOf('grep -rqF -- "$CF_ACCESS_CLIENT_ID" factory-reports/<key>/')
  assert.ok(scrubId > -1 && scrubId < add, 'the client-id scrub precedes git add')
  // W-2 (round 4): the candidate may have pre-committed evidence or a symlink at factory-reports/<key>;
  // it is removed after the guard passes and before npm ci writes anything there.
  assert.ok(p7.includes('rm -rf "factory-reports/<key>"\nnpm ci\nnode scripts/smoke.mjs'), 'rm -rf, then npm ci, then smoke')
  assert.ok(p7.indexOf('rm -rf "factory-reports/<key>"') > p7.indexOf('git diff --quiet "$SCAFFOLD_SHA"'), 'the rm comes after the guard')
  // W-5 (round 4): smoke.json's free text is page-controlled; the session reads only the ok booleans.
  assert.ok(/only the `ok` booleans from `smoke\.json`/.test(p7), 'the session reads only the ok booleans')
  const p9 = md.slice(md.indexOf('## Phase 9'), md.indexOf('## Phase 10'))
  const step6 = p9.slice(p9.indexOf('6. Cleanup'), p9.indexOf('7. Report'))
  assert.ok(step6.includes('cd "${TMPDIR:-/tmp}/factory/<slug>/release"') && step6.includes('npx wrangler delete --name factory-<slug>-<key> --force'), 'step 6 deletes from the release clone')
  assert.ok(!/in its scratch clone/.test(step6), 'no delete from a candidate clone')
  const p11 = md.slice(md.indexOf('## Phase 11'))
  assert.ok(/wrangler delete --name factory-<slug>-<key> --force`, run from the release clone or any fresh clone of `main`/.test(p11), 'the Phase 11 command list says where to run the deletes')
})

// W4 + W5: the plugin-root variable is braced everywhere (the repo convention), preflight proves
// wrangler auth, and the Worker-namespace check accepts only the specific not-found outcome.
test('factory-intake: braces CLAUDE_PLUGIN_ROOT, requires wrangler whoami at preflight, and treats only a not-found Worker as free', async () => {
  const md = await read('skills/factory-intake/SKILL.md')
  assert.ok(md.includes('${CLAUDE_PLUGIN_ROOT}/skills/factory-intake/scaffold/ruleset.json'))
  assert.ok(!/\$CLAUDE_PLUGIN_ROOT\b/.test(md), 'no braceless $CLAUDE_PLUGIN_ROOT')
  const p0 = md.slice(md.indexOf('## Phase 0'), md.indexOf('## Phase 1'))
  assert.ok(p0.includes('`npx --yes wrangler@latest whoami` (must succeed'), 'preflight requires wrangler whoami')
  const p2 = md.slice(md.indexOf('## Phase 2'), md.indexOf('## Phase 3'))
  assert.ok(p2.includes("npx --yes wrangler@latest deployments list --name <slug> 2>&1 | grep -qiE 'not found|does not exist|10007' && echo FREE"), 'the Worker check requires the not-found outcome')
  assert.ok(/any other failure[^\n]*is NOT "free"/i.test(p2), 'auth/network failures are not "free"')
})

// Without a caller-minted nonce factory-build falls back to a content-derived one that whoever
// wrote the fenced text can compute (README, factory-build row).
test('factory-intake: passes the run nonce to factory-build as fenceNonce on both the build and the iterate invocation', async () => {
  const md = await read('skills/factory-intake/SKILL.md')
  const n = (md.match(/fenceNonce/g) || []).length
  assert.ok(n >= 2, `fenceNonce appears at least twice (found ${n})`)
  const p5 = md.slice(md.indexOf('## Phase 5'), md.indexOf('## Phase 6'))
  const p10 = md.slice(md.indexOf('## Phase 10'), md.indexOf('## Phase 11'))
  assert.ok(p5.includes('fenceNonce') && p10.includes('fenceNonce'), 'both factory-build invocations carry it')
  // W3: each invocation mints its own nonce; Phase 0's is for the research fence only.
  assert.ok(p5.includes('crypto.randomUUID()') && p10.includes('crypto.randomUUID()'), 'each invocation mints a fresh nonce')
  assert.ok(!md.includes('run nonce from Phase 0'), 'no invocation reuses the Phase 0 nonce')
  const p0 = md.slice(md.indexOf('## Phase 0'), md.indexOf('## Phase 1'))
  assert.ok(/research fence only/.test(p0), 'Phase 0 scopes its nonce to the research fence')
})

// ---- runner ----
let failed = 0
for (const [name, fn] of tests) {
  try { await fn(); console.log('PASS', name) }
  catch (e) { failed++; console.error('FAIL', name, '\n  ', e.message) }
}
console.log(failed ? `\n${failed}/${tests.length} FAILED` : `\nall ${tests.length} passed`)
process.exit(failed ? 1 : 0)
