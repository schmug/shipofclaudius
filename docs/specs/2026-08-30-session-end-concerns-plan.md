# Session-End Concern Capture — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `Stop` hook that catches what a session leaves unresolved and files it to `schmug/agent-notes`, so concerns stop dying in one local transcript.

**Architecture:** A `type: "prompt"` hook on `Stop` evaluates a stopping *condition* against the transcript. When unmet it blocks and the reason reaches the main agent, which invokes a new `file-concerns` process skill to open one issue per session — falling back to a local spool if `gh` fails. A weekly scheduled task routes filed concerns onward and closes them.

**Tech Stack:** Node built-ins only (this repo has zero dependencies, no lockfile, and CI runs `npm test` with no install step). `gh` CLI. `jq` for shell hooks.

**Spec:** [`docs/specs/2026-08-30-session-end-concerns-design.md`](2026-08-30-session-end-concerns-design.md)

## Global Constraints

- **Zero npm dependencies.** No `package.json` deps, no lockfile. Tests use `node:` built-ins only.
- **Every suite must be in the `package.json` `test` chain.** `tests/plugin-integrity.test.mjs` fails the build for a suite that is not — a suite absent from the chain never runs in CI.
- **Never pin a test total** in `README.md` or `CLAUDE.md`. `plugin-integrity` fails the build if a count is written into either.
- **Hooks auto-discover at the plugin root** `hooks/hooks.json`. No `plugin.json` key is needed (unlike `.claude/agents/`, which does need one).
- **A new skill must declare `workflow: none`** in frontmatter, or it is classified as a Workflow wrapper and breaks the 1:1 workflow↔wrapper invariant.
- **The hook must never wedge a session.** A `Stop` hook that errors or blocks unsatisfiably costs the user their session output (spec §9).
- **Verbatim condition clause:** the prompt MUST contain `Default to satisfied` — it is the anti-nag guard and a content-contract test protects it.
- **Verbatim sink:** `schmug/agent-notes`, label `concern`, spool at `~/.claude/concerns-spool.jsonl`.
- Conventional commit prefixes (`feat:`, `fix:`, `test:`, `docs:`, `chore:`). Never author or sign as Cory.

---

### Task 1: Verify the three gating unknowns before any production code — **DONE (2026-08-30)**

> **Outcome:** all three resolved, plus two findings the plan did not anticipate. Prompt hooks DO load from a plugin `hooks/hooks.json` (14 evaluations fired), so Tasks 3-6 are alive. `Bash(gh issue create:*)` is a valid matcher. `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP=2` lowers the cap to 3 evaluations — adopt it. The default cap is not fixed (9 and 14 observed). And the `concern` label does not exist on `agent-notes`, so Task 3 gained a prerequisite step. Spec §10 items 8-12 carry the detail.

Spec §10 leaves three open items, and two of them can invalidate the whole design. This task writes **no production code** — its deliverable is an updated §10.

**Files:**
- Modify: `docs/specs/2026-08-30-session-end-concerns-design.md` (§10 only)

**Interfaces:**
- Consumes: nothing.
- Produces: a go/no-go on `type: "prompt"` in a plugin-loaded `hooks/hooks.json`. **If 1a fails, stop and report — Tasks 3–6 are void** and the fallback is a `command` hook that emits its condition via `systemMessage`.

- [ ] **Step 1: Build a scratch plugin that loads a prompt hook from `hooks/hooks.json`**

The spec's verification used `--settings`, which is a different load path. Build a real plugin:

```bash
S=/tmp/concerns-probe && rm -rf "$S" && mkdir -p "$S/plugin/hooks" "$S/work"
cat > "$S/plugin/.claude-plugin/plugin.json" <<'JSON'
{ "name": "concerns-probe", "description": "throwaway probe for prompt-type Stop hooks" }
JSON
mkdir -p "$S/plugin/.claude-plugin"
cat > "$S/plugin/hooks/hooks.json" <<'JSON'
{
  "description": "probe",
  "hooks": {
    "Stop": [
      { "hooks": [ { "type": "prompt", "prompt": "The transcript contains the word PINEAPPLE.", "timeout": 30 } ] }
    ]
  }
}
JSON
```

- [ ] **Step 2: Run a session against it and confirm the hook fires**

```bash
cd /tmp/concerns-probe/work && claude -p "Reply with exactly the word: ok" \
  --plugin-dir /tmp/concerns-probe/plugin \
  --model claude-haiku-4-5-20251001 \
  --debug-file /tmp/concerns-probe/debug.log < /dev/null
grep -c "Processing prompt hook" /tmp/concerns-probe/debug.log
```

Expected: count ≥ 1, and the log contains `Prompt hook condition was not met` followed by the model eventually emitting `PINEAPPLE`. A count of `0` means plugin-loaded prompt hooks do not work — **stop and report.**

If `--plugin-dir` is not the right flag for a local plugin directory, check `claude --help | grep -i plugin` before concluding the mechanism failed. Distinguish "the flag was wrong" from "the mechanism is absent".

- [ ] **Step 3: Determine the allow-rule matcher for the real filing command**

```bash
cat > /tmp/concerns-probe/settings-gh.json <<'JSON'
{ "permissions": { "allow": ["Bash(gh issue create:*)"] } }
JSON
cd /tmp/concerns-probe/work && claude -p \
  "Run exactly this and report the output: gh issue create -R schmug/agent-notes --title 'probe: allow-rule matcher check' --body 'delete me' --label concern" \
  --settings /tmp/concerns-probe/settings-gh.json --model claude-haiku-4-5-20251001 < /dev/null
```

Expected: the issue is created without a permission prompt. **Close it immediately** — `gh issue close <N> -R schmug/agent-notes --comment "probe"`. If the matcher is rejected, try `Bash(gh:*)` and record which one works.

- [ ] **Step 4: Test whether the block cap can be lowered**

```bash
cd /tmp/concerns-probe/work && CLAUDE_CODE_STOP_HOOK_BLOCK_CAP=2 claude -p "Reply with exactly the word: ok" \
  --settings /tmp/concerns-probe/settings-unsat.json \
  --model claude-haiku-4-5-20251001 --debug-file /tmp/concerns-probe/cap.log < /dev/null
grep -c "Processing prompt hook" /tmp/concerns-probe/cap.log
```

Where `settings-unsat.json` holds a Stop prompt hook with an unsatisfiable condition (`"The transcript contains the word ZXQVJ."`). Expected: a count of ~2 if the cap lowers, ~9 if the variable only raises. Record the observed number either way.

- [ ] **Step 5: Fold the findings into spec §10 and commit**

Move each resolved item from "Still open" to "Confirmed by observation" with the observed value. Do **not** write "verified" for anything you did not run.

```bash
rm -rf /tmp/concerns-probe
git add docs/specs/2026-08-30-session-end-concerns-design.md
git commit -m "docs(concerns): resolve the three gating unknowns in §10"
```

---

### Task 2: Allow non-`command` hook types in the integrity test

`tests/plugin-integrity.test.mjs:521` asserts `entry.type === 'command'`. A `prompt` hook fails the existing suite, so the gate must change before the hook can ship.

**This is a deliberate relaxation of a guardrail — call it out explicitly in the PR body.** It is replaced with a narrower Stop-specific guard, not simply deleted.

**Files:**
- Modify: `tests/plugin-integrity.test.mjs:508-534`

**Interfaces:**
- Consumes: nothing.
- Produces: `hooks/hooks.json` may contain `type: "prompt"` entries on `Stop` only.

- [ ] **Step 1: Write the failing test**

Add inside the existing `hooks/hooks.json (if shipped)` test, replacing the blanket `entry.type === 'command'` assertion:

```js
        const TYPES = new Set(['command', 'prompt', 'agent'])
        assert.ok(TYPES.has(entry.type), `${event}: "${entry.type}" is a real hook type`)
        // LLM-evaluated hook types cost a model call per fire and can block the turn.
        // They earn their keep only on Stop; on a tool event they fire constantly.
        if (entry.type !== 'command') {
          assert.equal(event, 'Stop', `${event}: only Stop may use the ${entry.type} hook type`)
          assert.ok(typeof entry.timeout === 'number' && entry.timeout > 0,
            `${event}: an LLM hook sets a timeout (it makes a model call)`)
        }
        if (entry.type === 'command') {
          assert.ok(typeof entry.command === 'string' && entry.command.length > 0, `${event}: non-empty command`)
        }
```

- [ ] **Step 2: Run it to make sure it fails for the right reason**

```bash
node tests/plugin-integrity.test.mjs
```

Expected: PASS. The current `hooks.json` ships only a `command` SessionStart hook, so this refactor is green before the hook lands — it is a *permission* change, not a behaviour change. Confirm the assertion is actually reached by temporarily adding a `{"type":"prompt","prompt":"x","timeout":5}` entry under `PostToolUse` and re-running; expected FAIL with `only Stop may use the prompt hook type`. Remove it afterwards.

- [ ] **Step 3: Run the full suite**

```bash
npm test
```

Expected: all pass, count unchanged or higher.

- [ ] **Step 4: Commit**

```bash
git add tests/plugin-integrity.test.mjs
git commit -m "test(integrity): permit prompt/agent hook types on Stop only

The blanket command-only assertion would reject the session-end concern
hook. Replaced with a narrower guard: LLM hook types are legal on Stop
and nowhere else, and must carry a timeout."
```

---

### Task 3: The `file-concerns` process skill

The hook's block `reason` is generated by the evaluator model, not authored by us — so it cannot carry a filing procedure. The condition names a skill instead, and the skill holds the exact steps. This is the bridge between an arbitrary reason string and a precise action.

**Files:**
- Create: `skills/file-concerns/SKILL.md`
- Create: `tests/session-end-concerns.test.mjs`
- Modify: `package.json` (test chain)

**Interfaces:**
- Consumes: nothing.
- Produces: skill name `shipofclaudius:file-concerns`, referenced verbatim by the Task 4 hook condition. Writes issues to `schmug/agent-notes` with label `concern`; writes spool lines to `~/.claude/concerns-spool.jsonl`.

- [ ] **Step 0: Create the `concern` label (prerequisite)**

`schmug/agent-notes` carries only the nine GitHub default labels — verified 2026-08-30. Without
this, every `gh issue create --label concern` in the skill body fails.

```bash
gh label create concern -R schmug/agent-notes \
  --description "Unresolved concern captured at session end" --color d4c5f9
gh label list -R schmug/agent-notes --search concern
```

- [ ] **Step 1: Write the failing test**

Create `tests/session-end-concerns.test.mjs`:

```js
// Content-contract test for the session-end concern capture: the file-concerns
// process skill and the Stop hook that names it. Node built-ins only; zero token
// cost. Run: node tests/session-end-concerns.test.mjs
//
// The invariants here are the ones a well-meaning edit silently breaks: the hook
// prompt must stay phrased as a CONDITION (an imperative gets evaluated as though
// it were one and produces nonsense), must keep its anti-nag clause, and must keep
// naming the skill — without the name, the block reason has no procedure to point at.
import { readFile } from 'node:fs/promises'
import assert from 'node:assert/strict'

const ROOT = new URL('../', import.meta.url)
const read = (rel) => readFile(new URL(rel, ROOT), 'utf8')

const tests = []
const test = (name, fn) => tests.push([name, fn])

test('file-concerns: exists as a process skill', async () => {
  const md = await read('skills/file-concerns/SKILL.md')
  assert.ok(/^---[\s\S]*?\ndescription:\s*\S.*\n[\s\S]*?---/m.test(md), 'frontmatter has a non-empty description')
  assert.ok(md.includes('name: file-concerns'), 'frontmatter name matches the directory')
  assert.ok(/^workflow:\s*none$/m.test(md), 'declares workflow: none (process skill, not a wrapper)')
  assert.ok(!md.includes('scriptPath'), 'must not masquerade as a Workflow wrapper')
})

test('file-concerns: files one issue per session to the agreed sink', async () => {
  const md = await read('skills/file-concerns/SKILL.md')
  assert.ok(md.includes('gh issue create -R schmug/agent-notes'), 'names the exact sink command')
  assert.ok(md.includes('--label concern'), 'labels the issue so triage can find it')
  assert.match(md, /one issue per session/i, 'states the one-issue-per-session rule')
  assert.ok(!/one issue per concern/i.test(md), 'must not file per concern — five issues from one session is the wrong shape')
})

test('file-concerns: never fails the turn', async () => {
  const md = await read('skills/file-concerns/SKILL.md')
  assert.ok(md.includes('~/.claude/concerns-spool.jsonl'), 'names the spool path')
  assert.match(md, /do not retry/i, 'forbids in-session retry')
  assert.match(md, /never.*(block|fail).*turn/i, 'states the never-fail-the-turn guarantee')
})

// ---- runner ----
let failed = 0
for (const [name, fn] of tests) {
  try { await fn(); console.log(`PASS ${name}`) }
  catch (e) { failed++; console.error(`FAIL ${name}\n  ${e.message}`) }
}
console.log(failed ? `\n${failed} failed` : `\nall ${tests.length} passed`)
process.exit(failed ? 1 : 0)
```

- [ ] **Step 2: Run it to verify it fails**

```bash
node tests/session-end-concerns.test.mjs
```

Expected: FAIL — `ENOENT: no such file or directory, open '.../skills/file-concerns/SKILL.md'`.

- [ ] **Step 3: Write the skill**

Create `skills/file-concerns/SKILL.md`:

```markdown
---
name: file-concerns
description: File this session's unresolved concerns to schmug/agent-notes. Use when the Stop hook blocks and asks for concerns to be recorded, or when you are wrapping up and something is unresolved — a completion claim you did not actually verify, a scope cut you did not state plainly, a question that never got answered, a doubt about whether the change is right. There is no bar; if it nagged, it counts. Not for durable technical unknowns a future session could answer (use ask-board) or for friction with the tooling itself. Not a Workflow wrapper; this is a process skill.
workflow: none
---

# file-concerns — record what this session left unresolved

**There is no bar.** Do not decide whether a concern is worth filing; that
decision happens at triage. If it nagged, it counts. Filing something trivial
costs a line in a weekly review. Filing nothing costs the concern.

Do NOT classify. Everything goes to one sink — routing to the question board,
the working repo, or the bin happens weekly, not now.

## File it — one issue per session

**One issue per session, not one per concern.** Five issues out of one session
is the wrong shape for review.

```bash
gh issue create -R schmug/agent-notes \
  --title "concerns: <repo-or-cwd> $(date +%F)" \
  --label concern \
  --body "- [ ] <first concern>
- [ ] <second concern>

Session: <session id>
Transcript: <transcript path>"
```

Write each concern so it stands alone. A week from now nobody remembers the
session: say what was claimed, what was not checked, and where the code is.

| Good | Useless |
|---|---|
| "Said the merge gate blocks unsigned commits; never ran it against a scratch repo." | "Unsure about the gate." |
| "Cut Windows path handling from `src/scan.ts` without telling Cory." | "Scope changed." |

## When `gh` fails

`gh` can be unauthenticated, offline, or rate limited. On any failure append one
line to `~/.claude/concerns-spool.jsonl` and carry on:

```bash
jq -nc --arg ts "$(date -u +%FT%TZ)" --arg cwd "$PWD" \
   --args '{ts:$ts,cwd:$cwd,concerns:$ARGS.positional}' \
   "first concern" "second concern" >> ~/.claude/concerns-spool.jsonl
```

**Do not retry in this session.** Do not escalate, do not surface it as an
error, and never block or fail the turn over it — a delayed write is fine, a
lost concern is not.

Drain the spool on the next session where `gh issue create` succeeds: file the
backlogged lines as their own issue, then truncate the file.
```

- [ ] **Step 4: Add the suite to the test chain**

In `package.json`, append to the `test` script's `&&`-chain, immediately before `node tests/plugin-integrity.test.mjs`:

```
node tests/session-end-concerns.test.mjs &&
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
node tests/session-end-concerns.test.mjs && npm test
```

Expected: the new suite's 3 tests PASS, and the full chain passes with a count 3 higher than the base. The base is **24 suites / 944 assertions** as of `165a6a6`. Note that the trailing `all N passed` line is only the LAST suite's count, not a repo total — sum across suites with `npm test 2>&1 | grep -E '^all [0-9]+ passed'`. Re-measure on the base commit rather than trusting this number, per CLAUDE.md.

- [ ] **Step 6: Commit**

```bash
git add skills/file-concerns/SKILL.md tests/session-end-concerns.test.mjs package.json
git commit -m "feat(concerns): file-concerns process skill for session-end capture

The Stop hook's block reason is generated by the evaluator, not authored
by us, so it cannot carry a procedure. The condition names this skill
instead and the skill holds the exact steps: one issue per session to
agent-notes, spool to ~/.claude/concerns-spool.jsonl when gh fails,
never retry and never fail the turn."
```

---

### Task 4: The `Stop` hook

**Files:**
- Modify: `hooks/hooks.json` (add a `Stop` key beside the existing `SessionStart`)
- Modify: `tests/session-end-concerns.test.mjs`

**Interfaces:**
- Consumes: the skill name `shipofclaudius:file-concerns` from Task 3, and Task 2's relaxed integrity assertion.
- Produces: nothing downstream depends on this.

- [ ] **Step 1: Write the failing test**

Append to `tests/session-end-concerns.test.mjs`, before the runner block:

```js
const hooksJson = JSON.parse(await read('hooks/hooks.json'))
const stopEntries = [].concat(hooksJson.hooks?.Stop || []).flatMap((g) => [].concat(g.hooks || []))

test('stop hook: one prompt-type entry with a timeout', () => {
  assert.equal(stopEntries.length, 1, 'exactly one Stop entry — each one costs a model call per stop')
  assert.equal(stopEntries[0].type, 'prompt', 'is a prompt hook (agent type costs ~4x per stop; see spec §2)')
  assert.ok(typeof stopEntries[0].timeout === 'number' && stopEntries[0].timeout > 0, 'sets a timeout')
})

test('stop hook: the prompt is phrased as a condition, not an instruction', () => {
  const p = stopEntries[0].prompt || ''
  // The harness wraps this as "has the following stopping condition been satisfied?".
  // An imperative gets evaluated as though it were a condition and produces nonsense —
  // observed: an imperative reason produced "Understood, I'll do that IF I'm about to stop".
  assert.ok(p.startsWith('Either this session surfaced nothing unresolved'),
    'opens as a condition on the transcript')
})

test('stop hook: keeps the anti-nag clause and names the filing skill', () => {
  const p = stopEntries[0].prompt || ''
  // Without this clause the hook blocks routine sessions, and a block replaces the
  // session's closing message with hook-loop chatter (spec §9).
  assert.ok(p.includes('Default to satisfied'), 'keeps the anti-nag clause')
  // Without the skill name the block reason has no procedure to point at.
  assert.ok(p.includes('shipofclaudius:file-concerns'), 'names the skill that does the filing')
  // The escape hatch is what terminates the loop when gh is down (spec §4.4).
  assert.ok(p.includes('concerns-spool.jsonl'), 'counts a spooled concern as satisfying the condition')
})
```

- [ ] **Step 2: Run it to verify it fails**

```bash
node tests/session-end-concerns.test.mjs
```

Expected: FAIL with `exactly one Stop entry` — `hooks.json` currently has no `Stop` key, so `stopEntries.length` is `0`.

- [ ] **Step 3: Add the hook**

In `hooks/hooks.json`, add a `Stop` key as a sibling of `SessionStart` inside the `hooks` object (leave `SessionStart` untouched):

```json
    "Stop": [
      {
        "hooks": [
          {
            "type": "prompt",
            "prompt": "Either this session surfaced nothing unresolved, or every unresolved item has already been recorded this session — by invoking the shipofclaudius:file-concerns skill, or by appending to ~/.claude/concerns-spool.jsonl after a failed gh call. Unresolved means: a completion claim resting on a check that was never actually run, a scope reduction never stated plainly to the user, a question raised and never answered, or a doubt about whether the change is correct. Default to satisfied — if nothing clearly unresolved stands out, the condition is met.",
            "timeout": 30
          }
        ]
      }
    ]
```

Also update the file's top-level `"description"` to mention both hooks, since it currently describes only the question board.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
node tests/session-end-concerns.test.mjs && node tests/plugin-integrity.test.mjs && npm test
```

Expected: all pass. `plugin-integrity` must accept the new entry — if it fails with `only command hooks are used here`, Task 2 was not applied.

- [ ] **Step 5: Verify it end-to-end in a real session**

Static tests cannot show the hook fires. Run one:

```bash
cd /tmp && mkdir -p concerns-e2e && cd concerns-e2e
claude -p "Reply with exactly the word: ok" --model claude-haiku-4-5-20251001 \
  --debug-file /tmp/concerns-e2e/debug.log < /dev/null
grep -E "Processing prompt hook|condition was (met|not met)" /tmp/concerns-e2e/debug.log
```

Expected: exactly one `Processing prompt hook`, then `Prompt hook condition was met` — a trivial session must NOT block. A block here means the condition is too eager; tighten `Default to satisfied` before shipping.

- [ ] **Step 6: Commit**

```bash
git add hooks/hooks.json tests/session-end-concerns.test.mjs
git commit -m "feat(concerns): Stop hook that catches unresolved session-end concerns

Phrased as a stopping condition, not an instruction — the harness wraps
it as 'has the following stopping condition been satisfied?' and an
imperative evaluates to nonsense. Keeps the Default-to-satisfied clause
because a block replaces the session's closing message."
```

---

### Task 5: Weekly triage scheduled task

**Files:**
- Create: `~/.claude/scheduled-tasks/concern-triage/SKILL.md` (not this repo — versioned in `schmug/dotclaude` since 2026-08-30; registration itself remains unversioned runtime state)
- Modify: `docs/specs/2026-08-30-session-end-concerns-design.md` (§6, record that it exists and when it runs)

**Interfaces:**
- Consumes: issues labelled `concern` in `schmug/agent-notes`; spool lines in `~/.claude/concerns-spool.jsonl`.
- Produces: routed issues; closed session issues.

- [ ] **Step 1: Read the existing pattern**

```bash
cat ~/.claude/scheduled-tasks/board-utilization-audit/SKILL.md
```

Match its frontmatter and cadence fields exactly — do not invent a schema.

- [ ] **Step 2: Write the triage task**

Body must cover, in order: read open `concern` issues plus any spool backlog; route each item (durable unknown → Q&A board post per the `ask-board` skill; tooling friction → the vent tool (`mcp__plugin_shipofclaudius_vent__vent`, shipped in #151-#153); real defect → an issue in the working repo bodied per `/issue`; nothing actionable → close with a one-line reason); close the session issue once every box is routed; truncate drained spool lines. Report counts filed/routed/closed so utilization is self-measuring against the §9 kill criterion.

- [ ] **Step 3: Verify it is registered — `ls` is NOT sufficient**

Creating the directory does **not** register anything. Verified 2026-08-30: after writing
`~/.claude/scheduled-tasks/concern-triage/SKILL.md`, the task was absent from
`mcp__scheduled-tasks__list_scheduled_tasks`, and several long-standing directories
(`branch-prune`, `pr-check`, `sentry-triage`, `worktree-cleanup`, …) are likewise inert —
present on disk, registered nowhere, never running.

Registration requires `mcp__scheduled-tasks__create_scheduled_task` with a `cronExpression`,
and it **overwrites** `SKILL.md` with the `prompt` argument, so pass the full body.

```bash
# verification that actually proves it
# mcp__scheduled-tasks__list_scheduled_tasks  -> the entry must appear with a nextRunAt
```

Creating a recurring task is persistent configuration; get explicit approval before
registering it. **Done 2026-08-30** — registered `0 8 * * 1`, confirmed in the task list
with a `nextRunAt`.

- [ ] **Step 4: Commit the spec update**

```bash
git add docs/specs/2026-08-30-session-end-concerns-design.md
git commit -m "docs(concerns): record the weekly triage task in §6"
```

---

### Task 6: Open the PR

**Files:** none.

- [ ] **Step 1: Run every gate**

```bash
npm test
```

Report the count. Every other gate this repo has (there is no separate lint or typecheck step — `npm test` is the whole chain) must be green.

- [ ] **Step 2: Push and open the PR**

```bash
git push -u origin docs/session-end-concerns
gh pr create --title "feat(concerns): session-end concern capture" --body "<see below>"
```

The body must include: the full `npm test` output with counts; an explicit call-out that **Task 2 relaxed a guardrail assertion** in `plugin-integrity` (blanket command-only → LLM types on Stop only) and why; the Task 4 Step 5 end-to-end evidence showing a trivial session does not block; and the §9 kill criterion with the date three weeks out, so the review has a scheduled re-check.

- [ ] **Step 3: Do not merge**

Per the repo's merge gate, squash-merge only once required checks are green. If `schmug/shipofclaudius` has no server-side ruleset with required checks, **stop at the PR and say which gate is missing** rather than merging.

---

## Self-Review

**Spec coverage.** §2 trigger/sink/bar decisions → Tasks 3–4. §4.1 condition wording → Task 4 Step 3, guarded by Task 4 Step 1. §4.2 issue format → Task 3 skill body, guarded by the one-issue-per-session assertions. §4.3 input shape → informational only, no task needed. §4.4 loop guard and escape hatch → Task 4's `concerns-spool.jsonl` assertion. §4.5 never-fail-the-turn → Task 3's third test. §5 sink → Task 3. §6 triage → Task 5. §7 testing → Tasks 3–4. §9 kill criterion → Task 6 Step 2. §10 open items → Task 1.

**Gap found and closed:** §7 lists spool-drain and concurrent-append cases that the Task 3 suite asserts only as *documented* procedure, not as executed behaviour — the spool is written by an agent following prose, so there is no function to unit-test. Recorded here deliberately rather than faking coverage; if the spool later becomes a script, those cases become real tests.

**Placeholder scan:** no TBD/TODO. The `<first concern>` / `<repo-or-cwd>` forms inside the skill body are runtime template slots, which is what a skill body is meant to carry.

**Type consistency:** skill directory `file-concerns`, frontmatter `name: file-concerns`, hook reference `shipofclaudius:file-concerns` (plugin-qualified — the form an agent types). Spool path `~/.claude/concerns-spool.jsonl` identical in skill body, hook prompt, and test. Label `concern` singular in both the skill's `gh` command and the triage task.
