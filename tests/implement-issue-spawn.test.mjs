// Content contract for implement-issue's SPAWN RECIPE. Node built-ins only; zero
// token cost.
//
// The skill hands a filed issue to a fresh `claude -p` child process instead of a
// `spawn_task` chip. That swap buys explicit control over model, budget, tools and
// permissions — and it takes away the human click that used to sit in front of the
// work. Everything below is a property that was MEASURED against Claude Code 2.1.251
// on 2026-09-07 and that a well-meaning edit would quietly re-break.
import { readFile } from 'node:fs/promises'
import assert from 'node:assert/strict'

const ROOT = new URL('../', import.meta.url)
const read = (rel) => readFile(new URL(rel, ROOT), 'utf8')
const skill = () => read('skills/implement-issue/SKILL.md')

const tests = []
const test = (name, fn) => tests.push([name, fn])

// MEASURED: `--bare` makes auth "strictly ANTHROPIC_API_KEY or apiKeyHelper (OAuth and
// keychain are never read)", so a subscription child dies with "Not logged in · Please
// run /login". The three unsets are what keep the child off the PARENT account's
// credentials; drop them and the child silently bills the primary account instead.
test('the child is launched off the parent account credentials, and never with --bare', async () => {
  const md = await skill()
  for (const v of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']) {
    assert.match(md, new RegExp(`-u ${v}\\b`), `the launch command must unset ${v}`)
  }
  assert.match(md, /CLAUDE_CONFIG_DIR=/, 'the child must run under its own CLAUDE_CONFIG_DIR')
  for (const line of md.split('\n')) {
    if (!/--bare\b/.test(line)) continue
    assert.match(line, /never|not\b|do not|don't|cannot|can't|breaks|fails/i,
      `--bare cited as usable rather than as a hazard: ${line.trim()}`)
  }
})

// MEASURED: `--permission-mode dontAsk` DENIES rather than prompts — a child under it
// could not run `gh auth status` at all. `bypassPermissions` is the other extreme and
// is refused outright by the parent session's own auto-mode classifier. The shipped
// answer is acceptEdits plus a NAMED Bash allowlist, which measured 0 denials while
// still being auditable.
test('permissions are an explicit allowlist — never bypassPermissions, never bare dontAsk', async () => {
  const md = await skill()
  assert.match(md, /--permission-mode\s+acceptEdits/, 'the launch command uses acceptEdits')
  assert.match(md, /--allowedTools/, 'tool grants are an explicit allowlist, not a blanket grant')
  for (const line of md.split('\n')) {
    if (!/bypassPermissions/.test(line)) continue
    assert.match(line, /never|not\b|do not|don't|refus|blocked|reject/i,
      `bypassPermissions cited as usable rather than as prohibited: ${line.trim()}`)
  }
  assert.ok(!/--permission-mode\s+bypassPermissions/.test(md),
    'the launch command must never request bypassPermissions')
})

// MEASURED: a child under CLAUDE_CONFIG_DIR=<sub dir> loads the PROJECT CLAUDE.md but
// NOT the user-level one — that file lives in the primary config dir, and the sub dir
// has none. Asked directly, the child answered "No" for global guardrails. So the
// no-push-to-main / never-sign-as-me / evidence rules do not reach it unless injected.
// `--add-dir` did NOT inject them; `--append-system-prompt-file` does.
test('the parent guardrails are injected, because the child config dir has no user CLAUDE.md', async () => {
  const md = await skill()
  assert.match(md, /--append-system-prompt-file/,
    'global guardrails must be injected explicitly into the child')
  assert.ok(/does not load|not loaded|never loads|no user-level|does NOT load/i.test(md),
    'the body must state WHY injection is needed: the user-level CLAUDE.md does not load')
})

// Cost control is the whole reason this skill stopped using the in-process Agent tool.
// A child with no ceiling can spend without bound and nothing in the parent notices
// until the bill does.
test('every spawn is capped and its model is chosen explicitly', async () => {
  const md = await skill()
  assert.match(md, /--max-budget-usd/, 'a dollar ceiling is passed')
  assert.match(md, /--max-turns/, 'a turn ceiling is passed')
  assert.match(md, /--model\s+\S+/, 'the model is set explicitly rather than inherited')
  assert.ok(!/--model\s+fable/i.test(md),
    'implementation work must not default to the top tier (delegation tiering)')
  assert.match(md, /--output-format json/, 'the outcome must come back machine-readable')
})

// MEASURED, twice: the child reported "File created successfully" and "4. Done" for a
// write that never landed in the working directory — once because the write was denied,
// once because it resolved a bare filename into its OWN scratchpad. A child's prose is
// not evidence. Only the branch, the commit and the PR are.
test('child success is verified from git/gh artifacts, never from the child self-report', async () => {
  const md = await skill()
  assert.ok(/self-report|claim work it did not do|not\*{0,2} ?evidence|says it did/i.test(md),
    'the body must warn that the child may claim work it did not do')
  assert.ok(/verif/i.test(md), 'the body must require verification')
  assert.match(md, /gh pr (?:view|list|checks)|git log|git rev-parse/,
    'verification must name a concrete git/gh artifact check')
})

// The child gets write tools and an inherited gh token with repo scope. Pointing it at
// the parent's own working tree would let it race the parent's edits on a shared branch.
test('the child works in its own worktree, off the default branch', async () => {
  const md = await skill()
  assert.match(md, /git\b[^\n]*worktree add/, 'the spawn provisions an isolated worktree')
  assert.ok(/default branch|origin\/(main|HEAD)/i.test(md),
    'the worktree must be cut from the default branch, not the current one')
})

// A backgrounded child inherits the parent's stdin. Without a redirect it stalls on a
// "no stdin data received in 3s" warning before proceeding.
test('the launch redirects stdin so a backgrounded child does not stall', async () => {
  assert.match(await skill(), /<\s*\/dev\/null/, 'the launch command redirects stdin from /dev/null')
})

// The click that used to gate the work is gone. That is the real cost of this change and
// the body has to say so plainly rather than let it pass as an implementation detail.
test('the removal of the human click is stated, not buried', async () => {
  const md = await skill()
  assert.ok(/without (?:a |the )?(?:human |user |your )?click|no click|used to|no longer waits|starts immediately|fires immediately/i.test(md),
    'the body must state that the spawn now starts without a click')
})

// The old chip watch joined a session by title through ccd_session_mgmt. A child process
// has no session to join: it is a pid that exits with JSON. If those tools reappear as
// instructions, the mechanism has been half-reverted and the join ambiguity is back.
test('no session-addressing machinery survives — a child process is not a session to join', async () => {
  const md = await skill()
  // Paragraph-scoped, not line-scoped: prose wraps, and a mention's disclaimer routinely
  // lands on the line before or after it. The unit that must carry the framing is the
  // paragraph the mention sits in.
  for (const para of md.split(/\n\s*\n/)) {
    if (!/ccd_session_mgmt|notify_when_idle|\bListAgents\b|spawn_task/.test(para)) continue
    assert.match(para, /never|\bnot\b|\bno\b|none|no longer|do not|don't|cannot|can't|replaced|superseded|instead of|used to|former/i,
      `superseded session machinery cited as usable: ${para.trim().slice(0, 120)}`)
  }
})

let failed = 0
for (const [name, fn] of tests) {
  try { await fn(); console.log(`PASS ${name}`) }
  catch (e) { failed++; console.log(`FAIL ${name}\n  ${e.message}`) }
}
console.log(failed ? `\n${failed} failing` : `\nall ${tests.length} passed`)
process.exit(failed ? 1 : 0)
