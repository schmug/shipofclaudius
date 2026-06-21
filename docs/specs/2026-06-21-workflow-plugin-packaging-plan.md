# Workflow-Plugin Packaging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Package the `shipofclaudius` repo as a Claude Code plugin whose thin wrapper skills run each bundled workflow in place via `Workflow({ scriptPath })`, so the nine workflows install once and work in every project with zero copy and zero drift.

**Architecture:** The repo root *is* the plugin root. A `.claude-plugin/plugin.json` manifest makes it installable. For each workflow in `.claude/workflows/*.js`, a `skills/<name>/SKILL.md` wrapper tells the model to call the Workflow tool with `scriptPath: "${CLAUDE_PLUGIN_ROOT}/.claude/workflows/<name>.js"`. The workflows themselves are unchanged (single source of truth). An offline integrity test enforces the wrapper↔workflow 1:1 correspondence and path correctness.

**Tech Stack:** Claude Code plugin system (`.claude-plugin/plugin.json`, `marketplace.json`, `skills/<name>/SKILL.md`, `${CLAUDE_PLUGIN_ROOT}` substitution), the Workflow tool (`scriptPath`), Node ESM tests (`.mjs`, `node:fs/promises` + `node:assert/strict`), Markdown, JSON.

## Global Constraints

- Plugin name/slug: `shipofclaudius` (matches the repo).
- Workflows stay canonical in `.claude/workflows/*.js` — **no second copy** of the `.js`.
- Wrappers reference `${CLAUDE_PLUGIN_ROOT}/.claude/workflows/<name>.js` (the **primary** path; the fallback `${CLAUDE_PLUGIN_ROOT}/workflows/<name>.js` is decided only in Task 4 if the nested `.claude/` proves not inert).
- One wrapper per workflow — **all nine** — and the wrappers add **no logic** (pure indirection). Descriptions drive natural-language triggering.
- Do **not** change any workflow's behavior or the in-repo project-level auto-load.
- Tests are **offline**, Node built-ins only (`node:fs/promises`, `node:assert/strict`), zero token cost, wired into `npm test`. The suite count only goes up.
- Conventional-commit prefixes; every commit ends with a `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` trailer; open a PR (never push `main`); do not enable auto-merge.
- The nine workflow names (canonical, = filename stems): `deep-security-scan`, `defense-scan`, `issue-research-fanout`, `issue-triage-fanout`, `pr-review-fanout`, `pr-triage-fanout`, `security-diff-scan`, `stacked-impl-lanes`, `stacked-merge-walk`.

---

### Task 1: Plugin manifest + marketplace entry (with a manifest integrity test)

**Files:**
- Create: `.claude-plugin/plugin.json`
- Create: `.claude-plugin/marketplace.json`
- Test: `tests/plugin-integrity.test.mjs`

**Interfaces:**
- Produces: a valid plugin manifest at `.claude-plugin/plugin.json` with `{ name: "shipofclaudius", version, description }`; a `marketplace.json` listing the plugin; and the test file `tests/plugin-integrity.test.mjs` exporting a runnable Node test (run via `node tests/plugin-integrity.test.mjs`, exits non-zero on failure) that later tasks extend.

- [ ] **Step 1: Write the failing manifest test**

Create `tests/plugin-integrity.test.mjs`:

```js
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

test('plugin.json is valid JSON with name/version/description', async () => {
  const m = await readJSON('.claude-plugin/plugin.json')
  assert.equal(m.name, 'shipofclaudius', 'plugin name matches the repo slug')
  assert.equal(typeof m.version, 'string', 'version is a string')
  assert.ok(typeof m.description === 'string' && m.description.length > 0, 'non-empty description')
})

test('marketplace.json is valid JSON and lists the shipofclaudius plugin', async () => {
  const mk = await readJSON('.claude-plugin/marketplace.json')
  assert.ok(Array.isArray(mk.plugins) && mk.plugins.length >= 1, 'has a plugins array')
  assert.ok(mk.plugins.some((p) => p && p.name === 'shipofclaudius'), 'lists the shipofclaudius plugin')
})

// ---- runner ----
let failed = 0
for (const [name, fn] of tests) {
  try { await fn(); console.log('PASS', name) }
  catch (e) { failed++; console.error('FAIL', name, '\n  ', e.message) }
}
console.log(failed ? `\n${failed}/${tests.length} FAILED` : `\nall ${tests.length} passed`)
process.exit(failed ? 1 : 0)
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node tests/plugin-integrity.test.mjs`
Expected: FAIL — both tests error (`ENOENT` opening `.claude-plugin/plugin.json` / `marketplace.json`), process exits non-zero.

- [ ] **Step 3: Create the plugin manifest**

Create `.claude-plugin/plugin.json`:

```json
{
  "name": "shipofclaudius",
  "version": "0.1.0",
  "description": "Curated dynamic workflows (issue/PR triage, research, stacked impl + merge, and security scans) as run-in-place wrapper skills."
}
```

- [ ] **Step 4: Create the marketplace entry**

Create `.claude-plugin/marketplace.json` (single-plugin marketplace, the repo is its own source):

```json
{
  "name": "shipofclaudius",
  "owner": { "name": "schmug" },
  "plugins": [
    {
      "name": "shipofclaudius",
      "source": "./",
      "description": "Curated dynamic workflows as run-in-place wrapper skills."
    }
  ]
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node tests/plugin-integrity.test.mjs`
Expected: PASS — `all 2 passed`, exit 0.

- [ ] **Step 6: Validate the manifest with the plugin CLI**

Run: `claude plugin validate .` (run from the repo root)
Expected: passes with no errors. If it reports a manifest/marketplace schema issue, fix `plugin.json` / `marketplace.json` per its message and re-run Step 5 + Step 6 until both pass. (The CLI is the schema authority; this step reconciles any field the offline test does not know about.)

- [ ] **Step 7: Commit**

```bash
git add .claude-plugin/plugin.json .claude-plugin/marketplace.json tests/plugin-integrity.test.mjs
git commit -m "feat: add shipofclaudius plugin manifest + marketplace entry

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Wrapper skills for all nine workflows (+ extend the integrity test)

**Files:**
- Create: `skills/<name>/SKILL.md` for each of the nine workflow names (Global Constraints list).
- Modify: `tests/plugin-integrity.test.mjs` (add the correspondence + path-correctness checks).

**Interfaces:**
- Consumes: `tests/plugin-integrity.test.mjs` from Task 1; the nine canonical names; the primary path `${CLAUDE_PLUGIN_ROOT}/.claude/workflows/<name>.js`.
- Produces: nine `skills/<name>/SKILL.md` wrappers, each with YAML frontmatter (`name`, `description`) and a body that instructs a `Workflow({ scriptPath })` call.

- [ ] **Step 1: Extend the integrity test (correspondence + path) — failing**

Add these two tests to `tests/plugin-integrity.test.mjs`, immediately before the `// ---- runner ----` line:

```js
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

test('every workflow has exactly one wrapper skill, and vice versa (1:1, no orphans)', async () => {
  assert.deepEqual(await skillNames(), await workflowNames(),
    'skills/<name>/ set must equal .claude/workflows/<name>.js set')
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
```

- [ ] **Step 2: Run the test to verify the new checks fail**

Run: `node tests/plugin-integrity.test.mjs`
Expected: FAIL — the two new tests error (`ENOENT` reading `skills/` / the `SKILL.md` files); the two manifest tests from Task 1 still PASS.

- [ ] **Step 3: Create the nine wrapper skills from this template + data table**

For EACH row in the table below, create `skills/<NAME>/SKILL.md` using this exact template, substituting `<NAME>`, `<DESCRIPTION>`, `<KEY_ARGS>`, and `<CAVEAT>` from that row:

````markdown
---
name: <NAME>
description: <DESCRIPTION>
---

Run the `<NAME>` dynamic workflow bundled with this plugin by calling the Workflow tool with its bundled script path:

```
Workflow({ scriptPath: "${CLAUDE_PLUGIN_ROOT}/.claude/workflows/<NAME>.js", args: { /* fill from the request */ } })
```

Fill `args` from the user's request. Common args: <KEY_ARGS>. For the full, current argument list, read the header comment / `meta` block in `${CLAUDE_PLUGIN_ROOT}/.claude/workflows/<NAME>.js`, or the repo README "Arguments" table. <CAVEAT>
````

Data table (one file per row):

| `<NAME>` | `<DESCRIPTION>` | `<KEY_ARGS>` | `<CAVEAT>` |
|---|---|---|---|
| `deep-security-scan` | Higher-recall security audit of a whole repo or a scoped path — prefilter + K threat-model-lensed workers → disprove-first validation → one HTML+markdown report. Use to audit a codebase/path for vulnerabilities (not a diff/PR). | `target` (default `"."`), `scope`, `rounds`, `threshold` (default `low`), `tools` | Read-only analysis; writes a report file. |
| `defense-scan` | Defense-in-depth security orchestrator — composes deep-security-scan with opt-in supply-chain / DAST / LLM-red-team / network / governance layers into one merged report with a per-layer coverage statement. | `target`, `rounds`, `threshold`, `supplyChain`, `url`+`authorized`, `repo` | Layers 2–6 are opt-in / authorization-gated and fail-open; writes a report. |
| `security-diff-scan` | Change-scoped security review of a git diff / PR / working tree → one HTML+markdown report with a coverage statement. Use to review a change for security regressions (not a whole-repo audit). | `base` (default `main`), `head`, `pr`+`repo`, `threshold`, `rounds` | Read-only on the change; PR mode fences untrusted PR text; writes a report. |
| `issue-triage-fanout` | Read-only fan-out triage of open GitHub issues → GREEN/DECISION/RESEARCH/DONE/BLOCKED with grouping + dependencies. Auto-gathers all open issues when none are given. | `numbers` (subset; omit to auto-gather), `repo`, `notes`, `readonlyAgent` | READ-ONLY on GitHub — run with a read-scoped `gh` token (README "Security model"); act on results only with the user's confirmation. |
| `issue-research-fanout` | Web-enabled fan-out over the RESEARCH bucket — one agent per issue investigates (codebase + gh + web) and returns a verdict aiming to move it to GREEN with an implementable spec. | `numbers` (required — the triage RESEARCH bucket), `triaged`, `label`, `repo` | READ-ONLY on GitHub; uses the web; read-scoped `gh` token. |
| `pr-triage-fanout` | Read-only fan-out triage of your open PRs → MERGE/CLOSE/REBASE/FIX_CI/COMMENT/AWAITING_HUMAN/ESCALATE with CI verdict + mergeability. | `numbers` (subset; omit to auto-gather), `repo`, `author`, `notes` | READ-ONLY; triages only the resolved author's PRs; read-scoped `gh` token. |
| `pr-review-fanout` | Read-only deep review of ONE PR's diff — fan out review dimensions → adversarially verify each finding → one HTML+markdown review traced to file:line. | `number`/`pr` (required), `repo`, `dimensions`, `threshold` | READ-ONLY; reviews/reports only, never comments/merges; read-scoped `gh` token. |
| `stacked-impl-lanes` | Implements issue-lanes into review-only PRs (parallel if file-disjoint, sequential + stacked if hub-coupled); security-hardening review on invariant lanes. | `lanes` (required), `mode`, `base`, `repo` | WRITES — opens PRs; needs write scope. Do NOT run under a read-only token; see the workflow header for its safety gates. |
| `stacked-merge-walk` | Lands a chain of stacked PRs onto a moving base (base-first, gate-verified, rebase-own-commits, escalate real conflicts). The terminal write step of the dev-lifecycle pipeline. | `prs` (required, base-first), `base`, `repo`, `execute` | WRITES — needs write scope; see the workflow header for its safety gates (it stages/gates before landing). |

- [ ] **Step 4: Run the test to verify it passes**

Run: `node tests/plugin-integrity.test.mjs`
Expected: PASS — `all 4 passed`, exit 0. (If the 1:1 test fails, a `skills/<name>` is missing or misnamed vs a workflow; if the path test fails, a wrapper's `name:`/`scriptPath` does not match its own workflow.)

- [ ] **Step 5: Re-validate the whole plugin**

Run: `claude plugin validate .`
Expected: passes (manifest + skills discovered, no errors).

- [ ] **Step 6: Commit**

```bash
git add skills tests/plugin-integrity.test.mjs
git commit -m "feat: add wrapper skills running each workflow in-place from the plugin root

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Wire the integrity test into `npm test` + add the README "Install as a plugin" section

**Files:**
- Modify: `package.json` (append the integrity test to the `test` script)
- Modify: `README.md` (add an "Install as a plugin" subsection under `## Install`)

**Interfaces:**
- Consumes: `tests/plugin-integrity.test.mjs` (green from Task 2).
- Produces: `npm test` runs the integrity test as the last suite; a documented plugin-install path in the README.

- [ ] **Step 1: Append the integrity test to the `test` script**

In `package.json`, change the `"test"` script value to end with the new suite. Modify the existing line so it reads (append ` && node tests/plugin-integrity.test.mjs` to the current chain):

```json
    "test": "node tests/dss-sim.test.mjs && node tests/defense-scan.test.mjs && node tests/issue-triage-sim.test.mjs && node tests/issue-research-sim.test.mjs && node tests/pr-triage-sim.test.mjs && node tests/stacked-impl-sim.test.mjs && node tests/stacked-merge-sim.test.mjs && node tests/pr-review-sim.test.mjs && node tests/security-diff-sim.test.mjs && node tests/plugin-integrity.test.mjs"
```

- [ ] **Step 2: Run the full suite to verify it stays green**

Run: `npm test`
Expected: every suite prints `all N passed`; the final line is the plugin-integrity suite (`all 4 passed`); `npm test` exits 0.

- [ ] **Step 3: Add the README "Install as a plugin" subsection**

In `README.md`, under the `## Install` heading, add a new subsection (after the existing "Machine-wide (every project)" subsection):

````markdown
### As a plugin (one install, every project, zero drift)

Install the repo as a Claude Code plugin and the workflows run **in place** from the plugin — no copy into `~/.claude/workflows/`, nothing to keep in sync:

```bash
claude plugin marketplace add schmug/shipofclaudius
claude plugin install shipofclaudius@shipofclaudius
```

Each workflow is exposed as a wrapper skill (`/shipofclaudius:<name>`, e.g. `/shipofclaudius:deep-security-scan`) and by natural language (*"run a deep security scan"*). The wrapper calls the Workflow tool with the bundled script at `${CLAUDE_PLUGIN_ROOT}/.claude/workflows/<name>.js`, so an update to the plugin updates the workflows everywhere with no manual step.
````

- [ ] **Step 4: Commit**

```bash
git add package.json README.md
git commit -m "feat: wire plugin-integrity into npm test + document plugin install

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Runtime smoke test — confirm a wrapper runs its workflow in place (resolves the nested-`.claude/` question)

This is the one **manual** verification (the offline tests cannot exercise a real plugin install). It confirms the load-bearing assumption and resolves the §4.3 open detail from the design spec.

**Files:**
- (Conditional) Modify: `tests/plugin-integrity.test.mjs` + the nine `skills/<name>/SKILL.md` — only if the fallback is needed.
- (Conditional) Create: `workflows/` (top-level) — only if the fallback is needed.

- [ ] **Step 1: Install the plugin locally**

Run (from a directory that is NOT this repo, so project-level auto-load can't mask the plugin):

```bash
claude plugin marketplace add /absolute/path/to/this/repo
claude plugin install shipofclaudius@shipofclaudius
```

Expected: install succeeds; `claude plugin list` shows `shipofclaudius`.

- [ ] **Step 2: Confirm a wrapper resolves and runs its bundled workflow**

In a Claude Code session in that non-repo directory, invoke a cheap read-only wrapper, e.g.:

> /shipofclaudius:pr-triage-fanout

Expected: the model calls `Workflow({ scriptPath: "<resolved-CLAUDE_PLUGIN_ROOT>/.claude/workflows/pr-triage-fanout.js", ... })` and the Workflow run starts (visible under `/workflows`). Confirm the resolved `scriptPath` points inside the installed plugin directory and the run does not error with a "script not found"/path error.

- [ ] **Step 3: Decide the path, and (only if needed) apply the fallback**

- If Step 2 ran from `${CLAUDE_PLUGIN_ROOT}/.claude/workflows/...` cleanly → **done, no change.** The primary path holds.
- If the nested `.claude/` is mishandled (e.g. Claude Code treats the plugin's internal `.claude/` specially, or the path doesn't resolve) → apply the fallback:
  1. Add a top-level `workflows/` copy step. Simplest robust form — a committed copy generated from the canonical source:
     ```bash
     rm -rf workflows && cp -R .claude/workflows workflows && rm -f workflows/*.bak
     ```
     (Keep `.claude/workflows/` as the single authored source; `workflows/` is a build-time mirror. If you prefer, document this `cp` in a `prepack`/release note so it is regenerated, never hand-edited.)
  2. In `tests/plugin-integrity.test.mjs`, change the single `wfRef` line to:
     ```js
     const wfRef = (name) => `\${CLAUDE_PLUGIN_ROOT}/workflows/${name}.js`
     ```
  3. In each `skills/<name>/SKILL.md`, change `${CLAUDE_PLUGIN_ROOT}/.claude/workflows/<name>.js` → `${CLAUDE_PLUGIN_ROOT}/workflows/<name>.js` (the body references it twice: the `Workflow({...})` call and the "read the header" line).
  4. Run `node tests/plugin-integrity.test.mjs` → expect PASS. Re-run Step 1–2 to confirm the fallback path resolves.

- [ ] **Step 4: Commit (only if the fallback was applied)**

```bash
git add workflows tests/plugin-integrity.test.mjs skills
git commit -m "fix: run wrappers from a top-level workflows/ mirror (nested .claude/ not inert)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

- [ ] **Step 5: Open the PR**

```bash
git push -u origin feat/workflow-plugin
gh pr create --base main --head feat/workflow-plugin \
  --title "feat: package shipofclaudius as a zero-copy wrapper-skill plugin" \
  --body "Implements docs/specs/2026-06-21-workflow-plugin-packaging-design.md. Adds the plugin manifest + marketplace entry, nine in-place wrapper skills (Workflow scriptPath from \${CLAUDE_PLUGIN_ROOT}), a plugin-integrity test wired into npm test, and a README install section. Smoke-tested a wrapper running its bundled workflow.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

Do not enable auto-merge.

---

## Definition of done (maps to the design spec §7)

- `.claude-plugin/plugin.json` + `marketplace.json` added and `claude plugin validate` passes.
- Nine wrapper skills present, each path-correct for its own workflow; 1:1 with the workflows (no orphans).
- `tests/plugin-integrity.test.mjs` green and wired into `npm test` (suite count up by one file / four assertions); full suite still 0 failing.
- README "Install as a plugin" subsection added.
- Smoke test confirms a wrapper runs its workflow in place; the §4.3 path question resolved (primary or fallback).
- PR opened (not `main`), conventional commits, `Co-Authored-By: Claude`, auto-merge off.
