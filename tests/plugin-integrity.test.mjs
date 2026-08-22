// Offline integrity test for the shipofclaudius plugin packaging.
// Node built-ins only; zero token cost. Asserts the plugin manifest is valid and
// (extended in a later task) that every workflow has a correct wrapper skill.
import { readFile } from 'node:fs/promises'
import assert from 'node:assert/strict'

const ROOT = new URL('../', import.meta.url)
const read = (rel) => readFile(new URL(rel, ROOT), 'utf8')
const readJSON = async (rel) => JSON.parse(await read(rel))

const tests = []
const test = (name, fn) => tests.push([name, fn])

test('plugin.json is valid JSON with name/description and NO pinned version', async () => {
  const m = await readJSON('.claude-plugin/plugin.json')
  assert.equal(m.name, 'shipofclaudius', 'plugin name matches the repo slug')
  assert.ok(typeof m.description === 'string' && m.description.length > 0, 'non-empty description')
  // Intentionally unversioned: Claude Code falls back to the git commit SHA so every
  // commit ships to installers. A pinned `version` here would gate updates off until
  // someone remembers to bump it (it never got bumped across many feature commits).
  // See https://code.claude.com/docs/en/plugins-reference#version-management
  assert.ok(!('version' in m), 'plugin.json must NOT pin a version (use commit-SHA delivery)')
})

test('marketplace.json is valid JSON, lists the plugin, and pins no version', async () => {
  const mk = await readJSON('.claude-plugin/marketplace.json')
  assert.ok(Array.isArray(mk.plugins) && mk.plugins.length >= 1, 'has a plugins array')
  const plugin = mk.plugins.find((p) => p && p.name === 'shipofclaudius')
  assert.ok(plugin, 'lists the shipofclaudius plugin')
  // A version in the marketplace entry would also gate updates (resolution order:
  // plugin.json version -> marketplace entry version -> git SHA). Keep both unset.
  assert.ok(!('version' in plugin), 'marketplace entry must NOT pin a version')
})

import { readdir } from 'node:fs/promises'

// The single source of truth for the bundled-script reference. If Task 4's smoke test
// forces the fallback, change ONLY this line (and re-run the suite).
const wfRef = (name) => `\${CLAUDE_PLUGIN_ROOT}/.claude/workflows/${name}.js`

const workflowNames = async () =>
  (await readdir(new URL('.claude/workflows/', ROOT)))
    .filter((f) => f.endsWith('.js'))
    .map((f) => f.slice(0, -3))
    .sort()

const skillNames = async () => {
  const entries = await readdir(new URL('skills/', ROOT), { withFileTypes: true })
  return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort()
}

// Process skills are session-long playbooks, not Workflow wrappers. They opt out
// of the 1:1 mapping EXPLICITLY via `workflow: none` in frontmatter — an absent
// workflow script alone is still an orphan and still fails the 1:1 check.
const isProcessSkill = async (name) => {
  const md = await read(`skills/${name}/SKILL.md`)
  return /^workflow:\s*none$/m.test(md)
}

const partitionedSkills = async () => {
  const wrappers = []
  const process = []
  for (const name of await skillNames()) {
    ;(await isProcessSkill(name)) ? process.push(name) : wrappers.push(name)
  }
  return { wrappers, process }
}

test('every workflow has exactly one wrapper skill, and vice versa (1:1, no orphans)', async () => {
  const { wrappers } = await partitionedSkills()
  assert.deepEqual(wrappers, await workflowNames(),
    'non-process skills/<name>/ set must equal .claude/workflows/<name>.js set')
})

test('process skills: declared explicitly, self-consistent, and never Workflow wrappers', async () => {
  const { process } = await partitionedSkills()
  for (const name of process) {
    const md = await read(`skills/${name}/SKILL.md`)
    assert.ok(/^---[\s\S]*?\ndescription:\s*\S.*\n[\s\S]*?---/m.test(md), `${name}: frontmatter has a non-empty description`)
    assert.ok(md.includes(`name: ${name}`), `${name}: frontmatter name matches the directory`)
    assert.ok(!md.includes('scriptPath'), `${name}: a process skill must not masquerade as a Workflow wrapper`)
    // every bundled reference the body mentions must exist
    for (const m of md.matchAll(/references\/([\w.-]+)/g)) {
      await read(`skills/${name}/references/${m[1]}`)
    }
  }
})

test('each wrapper targets its own bundled workflow via scriptPath + has a description', async () => {
  for (const name of await workflowNames()) {
    const md = await read(`skills/${name}/SKILL.md`)
    assert.ok(/^---[\s\S]*?\ndescription:\s*\S.*\n[\s\S]*?---/m.test(md), `${name}: frontmatter has a non-empty description`)
    assert.ok(md.includes(`name: ${name}`), `${name}: frontmatter name matches the workflow`)
    assert.ok(md.includes('Workflow({') && md.includes('scriptPath'), `${name}: instructs a Workflow scriptPath call`)
    assert.ok(md.includes(wfRef(name)), `${name}: references its own bundled script path (${wfRef(name)})`)
  }
})

// ---- the Action template ----
// The adoption kit ships a GitHub Actions workflow that no simulator covers, because it is YAML
// executed by GitHub rather than a Workflow script. These are string-shape assertions (Node
// built-ins only, no YAML parser) over the properties that are load-bearing for SAFETY or that
// have already broken once. Each one below corresponds to a real defect, not a style preference.

const factoryYml = async () => read('.factory/templates/factory.yml')
// Comments legitimately NAME the forbidden things in order to warn against them ("do NOT add
// --admin"), so a check for a dangerous string must read the executable YAML only.
const factoryCode = async () =>
  (await factoryYml()).split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')

test('factory.yml: the land job readies the draft BEFORE gating', async () => {
  const y = await factoryYml()
  // Scoped to the land job: #65's land-sweep also calls build-input.mjs, and it sits earlier in the
  // file, so a file-wide indexOf compared steps from two different jobs. The sweep deliberately does
  // NOT ready drafts — it skips them, because readying is the human's approval in the labelled path.
  const land = factoryJobs(y).land
  assert.ok(land, 'the land job exists')
  const ready = land.indexOf('gh pr ready')
  const build = land.indexOf('build-input.mjs')
  assert.ok(ready > 0, 'a `gh pr ready` step exists')
  assert.ok(build > 0 && ready < build,
    'readying must precede the gate input: factory-issue-fix opens a DRAFT, a draft reports ' +
    'mergeStateStatus=DRAFT, and gate condition 8 rejects DRAFT — so without this the factory ' +
    'can never land anything it produced')
  assert.ok(/--undo/.test(land), 'an escalated PR is converted back to a draft (the ladder still ends at a draft)')
  assert.ok(!/gh pr ready/.test(factoryJobs(y)['land-sweep'] || ''),
    'the unattended sweep never readies a draft — it skips drafts entirely (#65)')
})

test('factory.yml: the gate exit code is captured, not swallowed by the inherited `bash -e`', async () => {
  const y = await factoryYml()
  assert.ok(/\|\| code=\$\?/.test(y),
    'GitHub runs run: blocks as `bash -e {0}` and `set -uo pipefail` does not clear it — without ' +
    '`|| code=$?` the normal escalate path (exit 2) aborts the step before the code is captured')
  assert.ok(/if: always\(\)/.test(y), 'the comment/escalate steps run under always(), or they are skipped on escalate')
})

// Split the workflow into its top-level job blocks. #64 added `fixture-evidence`, which runs on the
// UNPRIVILEGED `pull_request` event and therefore MAY check out and run PR-authored code — that is
// its entire purpose. The invariant was never "this file contains no head.sha"; it is "the
// write-privileged job never touches PR code". A file-wide substring ban was a proxy for that, and
// the proxy stopped matching the property. These assertions are job-scoped and strictly stronger.
const factoryJobs = (y) => {
  const body = y.slice(y.indexOf('\njobs:'))
  const out = {}
  const re = /^ {2}([a-z][a-z0-9-]*):$/gm
  const marks = [...body.matchAll(re)]
  marks.forEach((m, i) => {
    out[m[1]] = body.slice(m.index, i + 1 < marks.length ? marks[i + 1].index : body.length)
  })
  return out
}

test('factory.yml: pull_request_target never checks out or executes PR-authored code', async () => {
  const y = await factoryCode()
  assert.ok(/pull_request_target/.test(y), 'the workflow uses pull_request_target')
  assert.ok(/ref: \$\{\{ github\.event\.pull_request\.base\.ref \}\}/.test(y), 'it checks out the BASE ref')
  const jobs = factoryJobs(y)
  const land = jobs.land
  assert.ok(land, 'the land job exists')
  assert.ok(!/ref:\s*\$\{\{\s*github\.event\.pull_request\.head\./.test(land),
    'the land job must never check out the PR head — pull_request_target runs with write access')
  assert.ok(!/git\s+checkout/.test(land), 'and never git-checkouts anything itself')
  assert.ok(!/npm ci|npm install|npm run build/.test(land),
    'no install or build step in the land job — the gate is dependency-free on purpose')
})

test('factory.yml: the job that DOES run PR code is unprivileged and secretless', async () => {
  const y = await factoryCode()
  const prod = factoryJobs(y)['fixture-evidence']
  assert.ok(prod, 'the fixture-evidence producer exists')
  assert.ok(/if: github\.event_name == 'pull_request'/.test(prod),
    "it runs ONLY on the unprivileged pull_request event, never pull_request_target")
  assert.ok(!/secrets\./.test(prod),
    'and never reads a secret — it executes PR-authored code, so a leak there is a repo compromise')
  assert.ok(/permissions:\n\s+contents: read/.test(prod), 'with a read-only token')
  assert.ok(!/gh pr merge|gh pr review|gh pr ready/.test(prod), 'and no write actions at all')
})

test('factory.yml: the unattended land trigger is killswitch-gated, default-off, and safe (#65)', async () => {
  const y = await factoryCode()
  const sweep = factoryJobs(y)['land-sweep']
  assert.ok(sweep, 'an unattended land trigger exists as its own job')
  assert.ok(/needs: killswitch/.test(sweep), 'it needs the killswitch job')
  assert.ok(/needs\.killswitch\.outputs\.paused == 'false'/.test(sweep),
    'and short-circuits on pipeline-paused exactly as the labelled path does')
  assert.ok(/vars\.FACTORY_AUTO_LAND == 'true'/.test(sweep),
    'it is OFF unless a repo variable explicitly arms it — adopting the template unchanged stays human-gated')
  assert.ok(/github\.event_name == 'schedule' \|\| github\.event_name == 'workflow_dispatch'/.test(sweep),
    'it is time-triggered, so nothing a PR author does can fire it')
  assert.ok(!/--admin/.test(sweep), 'it never bypasses branch protection')
  assert.ok(!/ref:\s*\$\{\{\s*github\.event\.pull_request\.head\./.test(sweep) && !/git\s+checkout/.test(sweep),
    'and never checks out PR-authored code — it runs with write access')
})

test('factory.yml: the gate config is read from the base ref, never the PR', async () => {
  const y = await factoryYml()
  assert.ok(/\.factory\/gate\.json/.test(y), 'it passes the repo gate config')
  assert.ok(/--config-source/.test(y), 'provenance is stamped into the verdict')
})

test('factory.yml: the merge is never forced', async () => {
  const y = await factoryCode()
  assert.ok(/gh pr merge/.test(y), 'it merges')
  assert.ok(!/--admin/.test(y), 'never --admin (it would bypass the protections the gate mirrors)')
  assert.ok(!/--delete-branch/.test(y), 'never --delete-branch')
  assert.ok(!/force/.test(y.slice(y.indexOf('  land:'))), 'never force-pushes')
})

test('factory.yml: untrusted GitHub context reaches run: blocks only via env', async () => {
  const y = await factoryYml()
  // Previously a flat "never appears" ban. #64 needs the PR body to pick the fixture test, and the
  // SAFE way to do that is exactly what this test is named for: bind it to an env var, never
  // interpolate it into the script. So the assertion now enforces the shape rather than banning the
  // field — every occurrence must be an `ENV_NAME: ${{ ... }}` binding, never inline in a run:.
  for (const field of ['issue.title', 'pull_request.title', 'pull_request.body', 'issue.body', 'head_commit.message']) {
    const needle = `github.event.${field}`
    for (const line of y.split('\n')) {
      if (!line.includes(needle)) continue
      assert.match(line, new RegExp(`^\\s+[A-Z][A-Z0-9_]*: \\$\\{\\{ \\s*github\\.event\\.${field.replace('.', '\\.')}\\s*\\}\\}$`),
        `${field} may only be bound to an env var, never interpolated into a script: ${line.trim()}`)
    }
  }
  assert.ok(/case "\$\{FACTORY_STOP_AFTER\}"/.test(y), 'dispatch inputs are allowlist-validated before reaching the driver')
})

// A suite cannot run the suites, so a hardcoded "**638 passing** (12 + 65 + ...)" total is a claim no
// check can ever enforce — and it drifted by 18 across four terms before anyone noticed. The contract
// is "the count only goes UP", which `npm test` prints; no doc may restate a number.
//
// EVERY doc that describes the gate is checked, not just README. #69 unpinned README but left
// CLAUDE.md telling readers to confirm the count against `e.g. "638 passing"` — a pin pointing at a
// pin that no longer existed. It survived the very commit that removed its counterpart precisely
// because this file only ever opened README.md. One doc guarded is not the invariant.
//
// The wrapper is not part of the invariant either: the CLAUDE.md pin was QUOTED, not bolded, so the
// original bold-only pattern read straight past it. Match the number however it is dressed up.
const assertPinsNoTotal = async (doc) => {
  const md = await read(doc)
  const hardcoded = md.match(/\d[\d,]*\s+(?:passing\b|tests?\s+pass)/i)
  assert.ok(!hardcoded, `${doc} hardcodes a test total (${hardcoded && hardcoded[0]}) — run \`npm test\` for the live number instead`)
  const tally = md.match(/\(\s*\d+(?:\s*\+\s*\d+){5,}\s*\)/)
  assert.ok(!tally, `${doc} hardcodes a per-suite tally (${tally && tally[0]}) — twenty hand-kept numbers is a drift generator`)
}

test('README pins no hardcoded test total (nothing can verify one from inside the suite)', () =>
  assertPinsNoTotal('README.md'))

test('CLAUDE.md pins no hardcoded test total either (the pin that outlived #69)', () =>
  assertPinsNoTotal('CLAUDE.md'))

// ---- dispatched agentTypes must actually ship ----
// A workflow's `agentType:` is resolved by Claude Code against its agent registry. A name no
// bundled file defines resolves to nothing the repo controls: on a fresh `claude plugin install`
// the maintainer's personal ~/.claude/agents/ copy is absent, so `security-hardening-reviewer` --
// which README's Security model cites twice as an active mitigation, and which fix-finding makes
// its ENTIRE Verify phase -- silently was not there for anyone but the maintainer (#70).

// Runtime-provided types. Not ours to ship, so exempt.
const BUILTIN_AGENTS = new Set(['Explore', 'Plan', 'general-purpose'])

// Only `//`-leading lines: workflow prose legitimately discusses "the read-only agentType", and
// these files use no /* */ blocks. Stripping inline trailing comments would corrupt prompt strings.
const stripLineComments = (src) =>
  src.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n')

// Identity comes from the frontmatter `name`, NOT the filename -- so a file named correctly but
// declaring a different `name` still registers under the wrong id and must fail here.
const shippedAgentNames = async () => {
  let files = []
  try {
    files = (await readdir(new URL('.claude/agents/', ROOT))).filter((f) => f.endsWith('.md'))
  } catch (e) {
    if (e.code !== 'ENOENT') throw e
    return new Map()
  }
  const named = new Map()
  for (const f of files) {
    const md = await read(`.claude/agents/${f}`)
    const m = md.match(/^---\n[\s\S]*?^name:\s*(\S+)\s*$/m)
    assert.ok(m, `.claude/agents/${f}: no frontmatter \`name:\` -- it registers under no id`)
    named.set(m[1], f)
  }
  return named
}

// `agentType: 'literal'` or `agentType: IDENT`. For an IDENT the repo's single shape is an
// args override with a literal ternary fallback, e.g.
//   const READONLY_AGENT = (typeof A.readonlyAgent === 'string' && ...) ? A.readonlyAgent.trim() : 'Explore'
// which is the criterion's "reachable via an args.* override" -- an operator who overrides it owns
// their own agent, so it is the DEFAULT that this repo has to ship.
const dispatchedAgentTypes = async () => {
  const out = []
  for (const name of await workflowNames()) {
    const raw = await read(`.claude/workflows/${name}.js`)
    const src = stripLineComments(raw)
    for (const m of src.matchAll(/agentType:\s*([^,}\s]+)/g)) {
      const token = m[1]
      const lit = token.match(/^['"](.+)['"]$/)
      if (lit) { out.push({ wf: name, agent: lit[1], via: `literal ${token}` }); continue }
      const decl = src.split('\n').find((l) => new RegExp(`^\\s*const\\s+${token}\\s*=`).test(l))
      assert.ok(decl, `${name}: agentType \`${token}\` has no const declaration -- cannot resolve what ships`)
      assert.ok(/\bA\.|\bargs\./.test(decl),
        `${name}: agentType \`${token}\` is not an args.* override; only a literal or an override with a shipped default is allowed`)
      // The ternary's `:` is the last colon on the declaration line; the fallback follows it.
      const fb = decl.slice(decl.lastIndexOf(':') + 1).match(/['"]([^'"]+)['"]/)
      assert.ok(fb, `${name}: agentType \`${token}\` has no literal default to fall back to`)
      out.push({ wf: name, agent: fb[1], via: `${token} default` })
    }
  }
  return out
}

test('every non-built-in agentType dispatched from a workflow is shipped under .claude/agents/', async () => {
  const shipped = await shippedAgentNames()
  const dispatched = await dispatchedAgentTypes()
  assert.ok(dispatched.length > 0, 'sanity: the scan found agentType dispatches at all')
  for (const { wf, agent, via } of dispatched) {
    if (BUILTIN_AGENTS.has(agent)) continue
    assert.ok(shipped.has(agent),
      `${wf} dispatches agentType "${agent}" (${via}) but no .claude/agents/*.md declares ` +
      `\`name: ${agent}\` -- on a fresh plugin install it resolves to nothing this repo controls. ` +
      `Shipped: [${[...shipped.keys()].join(', ') || 'none'}]`)
  }
})

test('.claude/agents/ is registered in plugin.json (it is NOT an auto-discovery path)', async () => {
  // Plugins auto-discover `agents/` at the PLUGIN ROOT only. `.claude/agents/` is the project
  // scope -- it covers contributors with this repo checked out, but an installer gets nothing
  // unless plugin.json names the path explicitly. Shipping the file without this key is decoration.
  const shipped = await shippedAgentNames()
  if (shipped.size === 0) return
  const m = await readJSON('.claude-plugin/plugin.json')
  const declared = [].concat(m.agents || [])
  for (const file of shipped.values()) {
    assert.ok(
      declared.some((p) => p === './.claude/agents/' || p === './.claude/agents' || p.endsWith(`/${file}`)),
      `.claude/agents/${file} ships but plugin.json's "agents" does not point at it — installers never load it`)
  }
})

test('every workflow has a suite, and every suite is in the package.json test chain', async () => {
  // CLAUDE.md says plugin-integrity "fails the build if you break" the rule that package.json's
  // test script lists each suite explicitly. It did not — nothing here ever opened package.json,
  // so a new workflow could ship with no sim and a suite could exist but never run in CI. Both
  // halves are now actually enforced, so the claim is true.
  const files = await readdir(new URL('tests/', ROOT))
  const suites = files.filter((f) => f.endsWith('.test.mjs')).sort()
  const chain = JSON.parse(await read('package.json')).scripts.test
  for (const f of suites) {
    assert.ok(chain.includes(`node tests/${f}`), `package.json test chain is missing tests/${f} — CI would never run it`)
  }
  // Filename conventions vary (`<name>-sim.test.mjs`, `<name>.test.mjs`, and `dss-sim.test.mjs`
  // for deep-security-scan), so the invariant is not the suite's NAME — it is that some suite
  // actually targets the workflow's path. That is what "it would ship untested" really means.
  const wfDir = new URL('.claude/workflows/', ROOT)
  const sources = await Promise.all(suites.map((f) => read(`tests/${f}`)))
  for (const wf of (await readdir(wfDir)).filter((f) => f.endsWith('.js'))) {
    assert.ok(
      sources.some((src) => src.includes(`.claude/workflows/${wf}`)),
      `no suite in tests/ targets .claude/workflows/${wf} — it would ship untested`
    )
  }
})

test('hooks/hooks.json (if shipped) is valid, plugin-root, and fails open', async () => {
  // Hooks auto-discover at the PLUGIN ROOT (`hooks/hooks.json`) — unlike `.claude/agents/`,
  // no plugin.json key is needed. Getting the path wrong ships a file that never runs.
  let raw
  try { raw = await read('hooks/hooks.json') } catch { return }  // not shipping hooks: fine
  const h = JSON.parse(raw)
  assert.ok(h.hooks && typeof h.hooks === 'object', 'has a top-level "hooks" object')
  const EVENTS = new Set(['PreToolUse', 'PostToolUse', 'SessionStart', 'SessionEnd', 'Stop',
    'UserPromptSubmit', 'PreCompact', 'PostCompact', 'Notification', 'SubagentStop'])
  for (const [event, groups] of Object.entries(h.hooks)) {
    assert.ok(EVENTS.has(event), `"${event}" is a real hook event (a typo here silently never fires)`)
    for (const g of [].concat(groups)) {
      for (const entry of [].concat(g.hooks || [])) {
        assert.ok(entry.type === 'command', `${event}: only command hooks are used here`)
        assert.ok(typeof entry.command === 'string' && entry.command.length > 0, `${event}: non-empty command`)
        // A session-lifecycle hook that can exit non-zero can wedge startup for every
        // project the plugin is enabled in. Ours must swallow failure explicitly.
        if (event === 'SessionStart') {
          assert.ok(/(\|\|\s*true|;\s*true)\s*$/.test(entry.command.trim()),
            'SessionStart hook must end in `|| true` or `; true` so a broken/absent CLI cannot block startup')
          assert.ok(typeof entry.timeout === 'number' && entry.timeout > 0,
            'SessionStart hook sets a timeout (it makes a network call)')
        }
      }
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
