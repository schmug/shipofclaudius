// Unit + end-to-end tests for the M4 validation log (spec §9.1).
//
// Two invariants dominate this file, and both are asserted rather than trusted:
//
//   PRIVACY — the log carries counts, never prompt-derived text. A cache file holds one
//   turn and is overwritten; a log accumulates forever, so a leak here is permanent. The
//   tests below drive real prompts full of distinctive phrases and paths through the real
//   hook process and assert none of it reaches the file.
//
//   §8 — no configuration of this tool may break a session. `outcome_log` is a new way to
//   configure it, so every way logging can fail gets a test proving the hook still exits 0.
//
// Run:  node tests/specificity-outcome-log.test.mjs
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { DEFAULTS, parseToml, normalizeConfig } from '../packages/specificity/src/config.mjs'
import {
  FIELDS, LOG_NAME, MAX_LINE_BYTES, outcomeLogPath, buildOutcomeRecord, serialize,
  appendOutcome, parseOutcomeLog, groundingRatio,
} from '../packages/specificity/src/outcome-log.mjs'
import {
  humanTurns, detectCorrection, wordCount, pairTurns, joinLabels, auc, wilson, compare,
  rng, sampleRows, scoreVerdicts, SHORT_TURN_WORDS, CORRECTION_MARKERS,
} from '../packages/specificity/src/analysis.mjs'
import { buildFastBlock } from '../packages/specificity/src/record.mjs'
import { buildIndex } from '../packages/specificity/src/context-index.mjs'
import { extractReferents } from '../packages/specificity/src/referents.mjs'
import { decide } from '../packages/specificity/bin/fast.mjs'

const execFileP = promisify(execFile)
const BIN = fileURLToPath(new URL('../packages/specificity/bin/fast.mjs', import.meta.url))
const ANALYZE = fileURLToPath(new URL('../packages/specificity/bin/analyze.mjs', import.meta.url))
const tests = []
const test = (name, fn) => tests.push([name, fn])

const fastFor = (prompt, blocks = [], files = []) =>
  buildFastBlock(prompt, extractReferents(prompt), buildIndex({ blocks, files }))

// ---------- config (§7) ----------

test('config: outcome_log ships OFF, so the log is never created by default', () => {
  // §9.1: instrumentation you switch on for an experiment, not a thing that accumulates
  // because a milestone needed it.
  assert.equal(DEFAULTS.outcome_log, false)
  assert.equal(normalizeConfig({}).outcome_log, false)
})

test('config: outcome_log reads from the flat TOML and coerces junk to the default', () => {
  assert.equal(normalizeConfig(parseToml('outcome_log = true')).outcome_log, true)
  for (const bad of ['yes', 1, 'true', null, []]) {
    assert.equal(normalizeConfig({ outcome_log: bad }).outcome_log, false, `${JSON.stringify(bad)} is not a boolean`)
  }
})

// ---------- the record shape (§9.1 decision 2) ----------

test('record: carries precisely the §9.1 fields and nothing else', () => {
  const rec = buildOutcomeRecord({ prompt_id: 'p1', fast: fastFor('fix the timeout in src/a.mjs'), nowMs: 1756500000123 })
  assert.deepEqual(Object.keys(rec).sort(), [...FIELDS].sort())
  assert.deepEqual(Object.keys(JSON.parse(serialize(rec))).sort(), [...FIELDS].sort())
  assert.equal(rec.ts, 1756500000.123)
})

test('record: every value is a number except prompt_id, so there is nowhere for text to sit', () => {
  // The structural form of the privacy rule. No object, no array, no free string field —
  // a referent list cannot be added later without breaking this test first.
  const rec = buildOutcomeRecord({ prompt_id: 'p1', fast: fastFor('rewrite the config file so it returns JSON') })
  for (const [k, v] of Object.entries(rec)) {
    if (k === 'prompt_id') { assert.equal(typeof v, 'string'); continue }
    assert.equal(typeof v, 'number', `${k} must be a number, got ${typeof v}`)
    assert.ok(Number.isFinite(v), `${k} must be finite`)
  }
})

test('record: a prompt_id that is not a plain id becomes null rather than prose on disk', () => {
  // prompt_id is the only string in the record, so it is the only place a host could put
  // text. It goes through the same filter as session_id: refused, not sanitized.
  for (const bad of ['fix the config file please', '../../etc/passwd', 'a b', 'x'.repeat(200), 42, null]) {
    const rec = buildOutcomeRecord({ prompt_id: bad, fast: fastFor('hello') })
    assert.equal(rec.prompt_id, null, `${JSON.stringify(bad)} is refused`)
  }
  assert.equal(buildOutcomeRecord({ prompt_id: '550e8400-e29b-41d4-a716-446655440000', fast: fastFor('hi') }).prompt_id,
    '550e8400-e29b-41d4-a716-446655440000')
})

test('record: NO referent phrase or file path can reach the log', () => {
  // The privacy invariant, driven end to end through the real builders: every distinctive
  // token in the prompt, the transcript window and the file index is checked against the
  // serialized line.
  const secrets = ['zaphodbeeblebrox', 'src/quokka-secret-alpha.mjs', 'the marmalade config', 'Ostrich-Token-9f2c']
  const prompt = `update ${secrets[2]} at ${secrets[1]} for ${secrets[0]} using ${secrets[3]}`
  const fast = fastFor(prompt, [{ role: 'user', text: `${secrets[1]} ${secrets[3]}` }], [secrets[1]])
  assert.ok(fast.referents.length > 0, 'the prompt really does produce referents to leak')
  const line = serialize(buildOutcomeRecord({ prompt_id: 'p1', fast }))
  for (const s of secrets) {
    assert.equal(line.includes(s), false, `"${s}" must not appear in the log line`)
  }
  // And the containers those phrases live in are absent too, not merely empty.
  assert.equal(line.includes('referents'), false)
  assert.equal(line.includes('candidates'), false)
})

test('record: an unknown property on the object cannot ride along into the file', () => {
  // serialize() walks the allowlist rather than stringifying the object, so a future edit
  // that attaches a field has to change FIELDS — where the test above is watching.
  const rec = { ...buildOutcomeRecord({ prompt_id: 'p1', fast: fastFor('hello') }), referents: [{ text: 'the config file' }] }
  assert.equal(serialize(rec).includes('the config file'), false)
})

test('record: a turn whose scoring errored logs nothing rather than a row of zeroes', () => {
  // A zero row is indistinguishable from a genuinely empty prompt, which would quietly
  // poison the dataset M4 exists to build.
  assert.equal(buildOutcomeRecord({ prompt_id: 'p1', fast: null }), null)
  assert.equal(appendOutcome('/nonexistent', null), null)
})

// ---------- the line, and concurrent appends ----------

test('line: exactly one trailing newline and none inside, so appends cannot tear', () => {
  const line = serialize(buildOutcomeRecord({ prompt_id: 'p1', fast: fastFor('fix the thing\nwith a newline\nin it') }))
  assert.equal(line.endsWith('\n'), true)
  assert.equal(line.slice(0, -1).includes('\n'), false)
})

test('line: a realistic record is far under the atomic-append cap', () => {
  const huge = fastFor(`${'the config file and the test suite and src/a.mjs '.repeat(200)}`)
  const line = serialize(buildOutcomeRecord({ prompt_id: 'x'.repeat(128), fast: huge }))
  assert.ok(Buffer.byteLength(line) < MAX_LINE_BYTES, `line is ${Buffer.byteLength(line)} bytes`)
})

test('line: a line over the cap is dropped, not written half-way', async () => {
  // Note what it takes to build one: every field the builder produces is a bounded number
  // or a <=128-character id, so `buildOutcomeRecord` CANNOT produce an oversized line.
  // The guard exists for a caller that hand-builds a record, and that is what is driven
  // here — the atomicity argument in MAX_LINE_BYTES is enforced, not merely reasoned to.
  const dir = await mkdtemp(join(tmpdir(), 'spec-cap-'))
  const rec = { ...buildOutcomeRecord({ prompt_id: 'p1', fast: fastFor('hi') }), prompt_id: 'x'.repeat(MAX_LINE_BYTES) }
  assert.equal(appendOutcome(dir, rec), null)
  assert.deepEqual(await readdir(dir), [], 'nothing was created')
})

test('append: concurrent writers interleave between lines, never inside one', async () => {
  // Several Claude Code sessions run at once and append to this one file. Each append is
  // one small write to an O_APPEND fd, so the file must stay parseable line by line.
  const dir = await mkdtemp(join(tmpdir(), 'spec-conc-'))
  const WRITERS = 8
  const PER = 25
  const script = `
    import { appendOutcome } from ${JSON.stringify(fileURLToPath(new URL('../packages/specificity/src/outcome-log.mjs', import.meta.url)))}
    const dir = process.argv[2], tag = Number(process.argv[3])
    for (let i = 0; i < ${PER}; i++) {
      appendOutcome(dir, { prompt_id: 'w' + tag + '-' + i, ts: 1, grounded: tag, unresolved: i,
        ambiguous: 0, indeterminate: 0, acceptance: 0, io_spec: 0, named_files: 0, format: 0,
        prompt_tokens: 1, log_length_baseline: 0 })
    }
  `
  const runner = join(dir, 'writer.mjs')
  await writeFile(runner, script)
  await Promise.all(Array.from({ length: WRITERS }, (_, n) => execFileP('node', [runner, dir, String(n)])))
  const { records, malformed } = parseOutcomeLog(await readFile(outcomeLogPath(dir), 'utf8'))
  assert.equal(malformed, 0, 'no torn line survived')
  assert.equal(records.length, WRITERS * PER)
  assert.equal(new Set(records.map((r) => r.prompt_id)).size, WRITERS * PER, 'every append landed exactly once')
})

test('append: a torn line costs that line and not the rest of the dataset', () => {
  const good = serialize(buildOutcomeRecord({ prompt_id: 'p1', fast: fastFor('hi') }))
  const { records, malformed } = parseOutcomeLog(`${good}{"prompt_id":"p2","ts":\n${good}`)
  assert.equal(records.length, 2)
  assert.equal(malformed, 1)
})

// ---------- the decision layer ----------

const EVENT = (over = {}) => ({ session_id: 'sess', prompt_id: 'pid', prompt: 'fix it and that thing like before', cwd: tmpdir(), transcript_path: '', ...over })

test('decide: with outcome_log off there is no record to write at all', () => {
  assert.equal(decide(EVENT(), normalizeConfig({})).outcome, null)
})

test('decide: with outcome_log on the record is assembled in the pure layer', () => {
  const d = decide(EVENT(), normalizeConfig({ outcome_log: true }))
  assert.ok(d.outcome, 'the record exists without any I/O having happened')
  assert.deepEqual(Object.keys(d.outcome).sort(), [...FIELDS].sort())
  assert.equal(d.exitCode, 0)
})

test('decide: a gate-blocked turn is still logged, because dropping it would bias the log', () => {
  const d = decide(EVENT(), normalizeConfig({ mode: 'gate', gate_threshold: 1, outcome_log: true }))
  assert.equal(d.exitCode, 2)
  assert.ok(d.outcome, 'the hardest turns are exactly the ones M4 must not lose')
})

test('decide: an unparseable transcript logs nothing and still exits 0', () => {
  // A fast block usually survives an unreadable transcript, but it was scored against an
  // EMPTY context index, so every referent reads "unresolved". That row would enter the
  // dataset looking like a maximally vague turn. It is dropped instead.
  const d = decide(EVENT({ transcript_path: fileURLToPath(import.meta.url) }), normalizeConfig({ outcome_log: true }))
  assert.equal(d.record.phase, 'error')
  assert.ok(d.record.fast, 'the cache still gets its block — only the dataset is protected')
  assert.equal(d.exitCode, 0)
  assert.equal(d.outcome, null)
})

// ---------- end to end, through the real process ----------

function runHook(event, { dir } = {}) {
  const res = { code: 0, stdout: '', stderr: '' }
  try {
    res.stdout = execFileSync('node', [BIN], { input: JSON.stringify(event), encoding: 'utf8', env: { ...process.env, SPECIFICITY_DIR: dir } })
  } catch (e) {
    res.code = e.status
    res.stdout = e.stdout || ''
    res.stderr = e.stderr || ''
  }
  return res
}

test('e2e: with outcome_log off, no log file is created AT ALL', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spec-off-'))
  runHook({ session_id: 'off1', prompt_id: 'p1', prompt: 'fix the timeout', cwd: tmpdir() }, { dir })
  const files = await readdir(dir)
  assert.equal(files.includes(LOG_NAME), false, `default-off means absent, not empty: saw ${files}`)
})

test('e2e: with outcome_log on, exactly one line is appended per turn', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spec-on-'))
  await writeFile(join(dir, 'config.toml'), 'outcome_log = true\n')
  for (const n of [1, 2, 3]) {
    const res = runHook({ session_id: 'on1', prompt_id: `p${n}`, prompt: `fix the timeout number ${n}`, cwd: tmpdir() }, { dir })
    assert.equal(res.code, 0)
  }
  const { records, malformed } = parseOutcomeLog(await readFile(outcomeLogPath(dir), 'utf8'))
  assert.equal(malformed, 0)
  assert.equal(records.length, 3, 'one line per turn, no more and no fewer')
  assert.deepEqual(records.map((r) => r.prompt_id), ['p1', 'p2', 'p3'])
  for (const r of records) assert.deepEqual(Object.keys(r).sort(), [...FIELDS].sort())
})

test('e2e: nothing from the prompt reaches the log file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spec-priv-'))
  const repo = await mkdtemp(join(tmpdir(), 'spec-repo-'))
  await mkdir(join(repo, 'src'))
  await writeFile(join(repo, 'src', 'quokka-secret-alpha.mjs'), 'export const x = 1\n')
  await writeFile(join(dir, 'config.toml'), 'outcome_log = true\n')
  const secrets = ['zaphodbeeblebrox', 'quokka-secret-alpha', 'marmalade', 'Ostrich-Token-9f2c']
  runHook({
    session_id: 'priv1',
    prompt_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    prompt: `update the marmalade config in src/quokka-secret-alpha.mjs for zaphodbeeblebrox using Ostrich-Token-9f2c`,
    cwd: repo,
  }, { dir })
  const raw = await readFile(outcomeLogPath(dir), 'utf8')
  assert.ok(raw.trim().length > 0, 'something really was logged')
  for (const s of secrets) assert.equal(raw.includes(s), false, `"${s}" leaked into the log`)
})

test('e2e: a log the hook cannot write is cosmetic, never a non-zero exit', async () => {
  // "A directory underneath a regular FILE" fails ENOTDIR on every OS and for every uid,
  // and — unlike /proc paths — cannot hang. See ensureDir() on why that matters here.
  const base = await mkdtemp(join(tmpdir(), 'spec-unw-'))
  await writeFile(join(base, 'blocker'), '')
  const cfgDir = await mkdtemp(join(tmpdir(), 'spec-unw-cfg-'))
  await writeFile(join(cfgDir, 'config.toml'), 'outcome_log = true\n')
  // Point SPECIFICITY_DIR at the unwritable path but hand the hook the same config by
  // copying it in is impossible there — so assert the two failure shapes separately.
  const started = Date.now()
  const blocked = runHook({ session_id: 'unw1', prompt_id: 'p1', prompt: 'hello', cwd: tmpdir() }, { dir: join(base, 'blocker', 'cache') })
  assert.equal(blocked.code, 0, 'the session survives a directory it cannot create')
  assert.ok(Date.now() - started < 5000, 'and fails fast rather than hanging the turn')

  // And with logging genuinely enabled, against a log path that is itself a directory:
  // appendFileSync throws EISDIR, which main() must swallow.
  const dir2 = await mkdtemp(join(tmpdir(), 'spec-eisdir-'))
  await writeFile(join(dir2, 'config.toml'), 'outcome_log = true\n')
  await mkdir(join(dir2, LOG_NAME))  // the log path is a directory: every append will throw
  const res = runHook({ session_id: 'unw2', prompt_id: 'p2', prompt: 'hello', cwd: tmpdir() }, { dir: dir2 })
  assert.equal(res.code, 0, 'an unwritable log must not reach the user\'s turn')
  assert.match(JSON.parse(res.stdout).systemMessage, /specificity/, 'and the advisory output still arrives intact')
})

test('e2e: a read-only log directory still exits 0', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spec-ro-'))
  await writeFile(join(dir, 'config.toml'), 'outcome_log = true\n')
  await writeFile(outcomeLogPath(dir), '')
  const { chmodSync } = await import('node:fs')
  chmodSync(outcomeLogPath(dir), 0o400)
  try {
    const res = runHook({ session_id: 'ro1', prompt_id: 'p1', prompt: 'hello', cwd: tmpdir() }, { dir })
    // Running as root ignores the mode bits, so the exit code is the assertion, not the
    // absence of a write.
    assert.equal(res.code, 0)
  } finally {
    chmodSync(outcomeLogPath(dir), 0o600)
    await rm(dir, { recursive: true, force: true })
  }
})

// ---------- the correction heuristic (§9.1 decision 3) ----------

test('heuristic: short marked turns are corrections', () => {
  for (const t of [
    'no, use the other one',
    "that's not what I meant",
    'actually, put it in src/b.mjs instead',
    'I meant the second function',
    'wrong file',
    'still failing',
    'you missed the second case',
    'undo that',
    'nope',
  ]) {
    assert.equal(detectCorrection(t).correction, true, `"${t}" is a correction`)
  }
})

test('heuristic: unmarked turns are not corrections however short', () => {
  for (const t of [
    'run the tests',
    'now add a test for the empty case',
    'thanks, ship it',
    'what does that function return?',
    'ok',
    '',
  ]) {
    assert.equal(detectCorrection(t).correction, false, `"${t}" is not a correction`)
  }
})

test('heuristic: a long turn that merely contains a marker is a new instruction', () => {
  // The conjunction is the whole design: markers alone would label any turn containing
  // "actually" as a repair of the previous one.
  const long = `Implement the validation log for the scorer. ${'It should append one line per turn and carry only counts. '.repeat(4)} Actually the config key is outcome_log.`
  const d = detectCorrection(long)
  assert.ok(d.markers.length > 0, 'the marker really did fire')
  assert.ok(d.words > SHORT_TURN_WORDS)
  assert.equal(d.correction, false)
})

test('heuristic: fenced code does not count toward the length, or supply markers', () => {
  const withFence = 'no, like this:\n```\n' + Array.from({ length: 80 }, (_, n) => `line ${n} actually`).join('\n') + '\n```'
  const d = detectCorrection(withFence)
  assert.ok(d.words <= SHORT_TURN_WORDS, `pasted code inflated the count to ${d.words}`)
  assert.equal(d.correction, true)
  assert.equal(wordCount('```\na b c d e f g\n```'), 0)
})

test('heuristic: reports which marker family fired, so a hand check is actionable', () => {
  assert.deepEqual(detectCorrection('no, I meant the other file').markers.sort(), ['negation', 'restatement'])
  assert.ok(CORRECTION_MARKERS.length >= 4)
})

// ---------- transcripts → labelled pairs ----------

const trLine = (o) => JSON.stringify({ type: 'user', isSidechain: false, origin: { kind: 'human' }, sessionId: 's1', timestamp: '2026-08-30T00:00:00.000Z', ...o })

test('turns: tool results, sidechains, meta and slash-command envelopes are not human turns', () => {
  const text = [
    trLine({ promptId: 'p1', uuid: 'u1', message: { role: 'user', content: 'fix the timeout' } }),
    // same turn, later record: a tool result sharing p1
    trLine({ promptId: 'p1', uuid: 'u2', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } }),
    trLine({ promptId: 'p2', uuid: 'u3', isSidechain: true, message: { role: 'user', content: 'subagent prompt' } }),
    trLine({ promptId: 'p3', uuid: 'u4', isMeta: true, message: { role: 'user', content: 'meta' } }),
    trLine({ promptId: 'p4', uuid: 'u5', message: { role: 'user', content: '<command-name>ship</command-name>' } }),
    trLine({ promptId: 'p5', uuid: 'u6', origin: { kind: 'agent' }, message: { role: 'user', content: 'injected' } }),
    trLine({ promptId: 'p6', uuid: 'u7', message: { role: 'user', content: [{ type: 'text', text: 'no, the other one' }] } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'done' } }),
    'not json at all',
  ].join('\n')
  assert.deepEqual(humanTurns(text).map((t) => t.prompt_id), ['p1', 'p6'])
})

test('pairs: the label comes from the NEXT turn, and the last turn is unlabelled', () => {
  const text = [
    trLine({ promptId: 'p1', uuid: 'u1', message: { role: 'user', content: 'add the retry' } }),
    trLine({ promptId: 'p2', uuid: 'u2', message: { role: 'user', content: 'no, on the other call' } }),
    trLine({ promptId: 'p3', uuid: 'u3', message: { role: 'user', content: 'now run the tests' } }),
  ].join('\n')
  const pairs = pairTurns(humanTurns(text))
  assert.deepEqual(pairs.map((p) => [p.prompt_id, p.label]), [['p1', true], ['p2', false]])
  assert.equal(pairs.length, 2, 'the final turn has no successor and is missing data, not a negative')
})

test('pairs: a session boundary is not a "next turn"', () => {
  const text = [
    trLine({ promptId: 'p1', uuid: 'u1', sessionId: 'A', message: { role: 'user', content: 'do the thing' } }),
    trLine({ promptId: 'p2', uuid: 'u2', sessionId: 'B', message: { role: 'user', content: 'no, wrong' } }),
  ].join('\n')
  assert.deepEqual(pairTurns(humanTurns(text)), [])
})

test('join: log records match turns on prompt_id, and the rest are counted not guessed', () => {
  const records = [
    { prompt_id: 'p1', grounded: 3, unresolved: 1, ambiguous: 0, indeterminate: 5, log_length_baseline: 2.1 },
    { prompt_id: 'gone', grounded: 1, unresolved: 0, ambiguous: 0, indeterminate: 0, log_length_baseline: 1.0 },
  ]
  const pairs = [{ prompt_id: 'p1', label: true, detail: { words: 3, markers: ['negation'] }, next_text: 'no' }]
  const { rows, unmatched } = joinLabels(records, pairs)
  assert.equal(unmatched, 1)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].label, true)
  assert.equal(rows[0].grounding_ratio, 0.75, 'indeterminate is out of the denominator, as in §6')
})

test('ratio: a turn with no scorable referents is missing data, not a 0 or a 1', () => {
  assert.equal(groundingRatio({ grounded: 0, unresolved: 0, ambiguous: 0, indeterminate: 4 }), null)
  assert.equal(groundingRatio({ grounded: 1, unresolved: 1, ambiguous: 2, indeterminate: 0 }), 0.25)
})

// ---------- does it predict anything? ----------

test('auc: a perfect separator scores 1, a reversed one 0, and coin flips 0.5', () => {
  assert.equal(auc([1, 2, 3, 4], [0, 0, 1, 1]), 1)
  assert.equal(auc([4, 3, 2, 1], [0, 0, 1, 1]), 0)
  assert.equal(auc([1, 1, 1, 1], [0, 0, 1, 1]), 0.5, 'all-ties is chance, via midranks')
})

test('auc: is undefined rather than misleading when a class is empty', () => {
  assert.equal(auc([1, 2, 3], [0, 0, 0]), null)
  assert.equal(auc([1, 2, 3], [1, 1, 1]), null)
})

test('auc: rows with a missing predictor are excluded, not scored as zero', () => {
  assert.equal(auc([null, 1, 2, 3, 4], [1, 0, 0, 1, 1]), auc([1, 2, 3, 4], [0, 0, 1, 1]))
})

test('compare: reports both AUCs on the same orientation and a raw margin', () => {
  // Grounding is negated so that HIGHER means "more likely to need a correction" for both
  // predictors; without that the two numbers are not comparable at all.
  const rows = [
    { prompt_id: 'a', label: true, grounding_ratio: 0.0, log_length_baseline: 1.0 },
    { prompt_id: 'b', label: true, grounding_ratio: 0.2, log_length_baseline: 4.0 },
    { prompt_id: 'c', label: false, grounding_ratio: 0.9, log_length_baseline: 2.0 },
    { prompt_id: 'd', label: false, grounding_ratio: 1.0, log_length_baseline: 3.0 },
  ]
  const c = compare(rows)
  assert.equal(c.n, 4)
  assert.equal(c.positives, 2)
  assert.equal(c.grounding_auc, 1, 'well-grounded turns needed no correction, perfectly')
  assert.equal(c.baseline_auc, 0.5)
  assert.equal(c.beats_baseline, true)
  assert.equal(Number(c.margin.toFixed(3)), 0.5)
})

test('compare: an empty or single-class dataset yields no verdict rather than a false one', () => {
  assert.equal(compare([]).beats_baseline, null)
  assert.equal(compare([{ label: true, grounding_ratio: 1, log_length_baseline: 1 }]).beats_baseline, null)
})

test('wilson: the interval brackets the estimate and stays inside [0,1]', () => {
  const w = wilson(3, 30)
  assert.ok(w.low < 0.1 && 0.1 < w.high)
  assert.ok(w.low >= 0 && w.high <= 1)
  assert.equal(wilson(0, 0).low, 0)
})

// ---------- the hand-check path ----------

const ROWS = Array.from({ length: 40 }, (_, n) => ({
  prompt_id: `p${n}`,
  label: n % 5 === 0,
  detail: { words: 3, markers: n % 5 === 0 ? ['negation'] : [] },
  grounding_ratio: (n % 10) / 10,
  log_length_baseline: 1 + (n % 7),
}))

test('sample: the same seed picks the same rows, so a hand check can be scored later', () => {
  const a = sampleRows(ROWS, 10, 7).map((r) => r.prompt_id)
  const b = sampleRows(ROWS, 10, 7).map((r) => r.prompt_id)
  assert.deepEqual(a, b)
  assert.notDeepEqual(a, sampleRows(ROWS, 10, 8).map((r) => r.prompt_id))
  assert.equal(rng(1)(), rng(1)(), 'the PRNG itself is seeded, not Math.random')
})

test('sample: is stratified, so the false-NEGATIVE rate is measurable at all', () => {
  // Corrections are a small minority; a uniform sample of 10 would contain one or two and
  // measure the miss rate not at all.
  const picked = sampleRows(ROWS, 10, 3)
  assert.equal(picked.length, 10)
  const pos = picked.filter((r) => r.label).length
  assert.ok(pos >= 4 && pos <= 6, `expected a balanced sample, got ${pos} positives`)
})

test('sample: asking for more rows than exist yields every row, once', () => {
  const picked = sampleRows(ROWS, 999, 1)
  assert.equal(picked.length, ROWS.length)
  assert.equal(new Set(picked.map((r) => r.prompt_id)).size, ROWS.length)
})

test('verdicts: the heuristic\'s own error rate is what comes out, with an interval', () => {
  const rows = [
    { prompt_id: 'a', label: true }, { prompt_id: 'b', label: true },
    { prompt_id: 'c', label: false }, { prompt_id: 'd', label: false },
  ]
  const s = scoreVerdicts(rows, [
    { prompt_id: 'a', correction: true },    // tp
    { prompt_id: 'b', correction: false },   // fp
    { prompt_id: 'c', correction: true },    // fn
    { prompt_id: 'd', correction: false },   // tn
  ])
  assert.deepEqual([s.true_positive, s.false_positive, s.false_negative, s.true_negative], [1, 1, 1, 1])
  assert.equal(s.error_rate, 0.5)
  assert.equal(s.precision, 0.5)
  assert.equal(s.recall, 0.5)
  assert.ok(s.error_rate_ci.low < 0.5 && s.error_rate_ci.high > 0.5)
})

test('verdicts: rows nobody judged are reported as unjudged, not scored as correct', () => {
  const s = scoreVerdicts([{ prompt_id: 'a', label: true }, { prompt_id: 'b', label: true }], [{ prompt_id: 'a', correction: true }])
  assert.equal(s.n, 1)
  assert.equal(s.checked_missing, 1)
  assert.equal(s.error_rate, 0)
})

// ---------- the analysis CLI, end to end ----------

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'spec-an-'))
  const projects = join(dir, 'projects', 'proj-a')
  await mkdir(projects, { recursive: true })
  // Six turns: the well-grounded ones are followed by ordinary next turns, the poorly
  // grounded ones by corrections. That is the signal `report` should find.
  const turns = [
    ['aaaaaaaa-0001', 'add the retry to src/a.mjs'],
    ['aaaaaaaa-0002', 'no, the other call'],
    ['aaaaaaaa-0003', 'rename the field in src/b.mjs'],
    ['aaaaaaaa-0004', 'now run the tests and report the counts back to me please'],
    ['aaaaaaaa-0005', 'fix that thing'],
    ['aaaaaaaa-0006', "that's not what I meant"],
  ]
  await writeFile(join(projects, 's1.jsonl'),
    turns.map(([id, text], n) => trLine({ promptId: id, uuid: `u${n}`, message: { role: 'user', content: text } })).join('\n'))
  const logDir = join(dir, 'cfg')
  await mkdir(logDir)
  const rec = (id, grounded, unresolved, baseline) => ({
    prompt_id: id, ts: 1, grounded, unresolved, ambiguous: 0, indeterminate: 0,
    acceptance: 0, io_spec: 0, named_files: 1, format: 0, prompt_tokens: 10, log_length_baseline: baseline,
  })
  await writeFile(outcomeLogPath(logDir), [
    rec('aaaaaaaa-0001', 0, 4, 3.0),   // followed by a correction
    rec('aaaaaaaa-0003', 4, 0, 1.0),   // followed by a normal turn
    rec('aaaaaaaa-0005', 0, 3, 2.0),   // followed by a correction
    rec('aaaaaaaa-0004', 4, 0, 4.0),   // followed by a normal turn
  ].map((r) => `${JSON.stringify(r)}\n`).join(''))
  return { dir, projects: join(dir, 'projects'), log: outcomeLogPath(logDir) }
}

test('cli: report joins the log to the transcripts and states a verdict', async () => {
  const f = await fixture()
  const { stdout } = await execFileP('node', [ANALYZE, 'report', '--log', f.log, '--projects', f.projects])
  assert.match(stdout, /joined:\s+4 rows/)
  assert.match(stdout, /positives:\s+2\/4/)
  assert.match(stdout, /grounding ratio \(negated\):\s+1\.000/)
  assert.match(stdout, /VERDICT: the fast-path grounding ratio BEATS the length baseline/)
  assert.match(stdout, /error rate/i, 'and refuses to let the verdict stand alone')
})

test('cli: report survives a log with no matching transcripts, exit 0', async () => {
  const f = await fixture()
  const empty = await mkdtemp(join(tmpdir(), 'spec-an-empty-'))
  const { stdout } = await execFileP('node', [ANALYZE, 'report', '--log', f.log, '--projects', empty])
  assert.match(stdout, /VERDICT: not enough data/)
})

test('cli: a missing log says what to switch on, and exits non-zero', async () => {
  await assert.rejects(
    execFileP('node', [ANALYZE, 'report', '--log', join(tmpdir(), 'no-such-log.jsonl')]),
    (e) => { assert.match(e.stderr, /outcome_log = true/); return true },
  )
})

test('cli: sample prints the worksheet to STDOUT and writes no file', async () => {
  // §9.1 keeps prompt text off disk. Judging the label needs the text, so the worksheet is
  // printed for a human to read; only ids and booleans go back to a file.
  const f = await fixture()
  const before = await readdir(f.dir)
  const { stdout } = await execFileP('node', [ANALYZE, 'sample', '--n', '4', '--seed', '7', '--log', f.log, '--projects', f.projects])
  assert.match(stdout, /hand-check worksheet/)
  assert.match(stdout, /"prompt_id":"aaaaaaaa-000\d","correction":true\|false/)
  assert.match(stdout, /next turn: /)
  assert.deepEqual(await readdir(f.dir), before, 'nothing was written')
})

test('cli: the analyzer has no file-writing path at all', async () => {
  // A structural guard on the rule above: the moment someone adds `--out worksheet.txt`,
  // prompt text lands on disk permanently. Nothing in this CLI may write.
  const src = await readFile(ANALYZE, 'utf8')
  for (const forbidden of ['writeFileSync', 'appendFileSync', 'createWriteStream', 'writeFile(']) {
    assert.equal(src.includes(forbidden), false, `analyze.mjs must not ${forbidden}`)
  }
})

test('cli: check scores the heuristic against hand verdicts and prints an error rate', async () => {
  const f = await fixture()
  const sampled = await execFileP('node', [ANALYZE, 'sample', '--n', '4', '--seed', '7', '--log', f.log, '--projects', f.projects])
  const ids = [...sampled.stdout.matchAll(/^--- (\S+)$/gm)].map((m) => m[1])
  assert.equal(ids.length, 4)
  const verdicts = join(f.dir, 'verdicts.jsonl')
  // Judge the first row against the heuristic and agree with the rest: a known 1/4 error.
  const heuristic = [...sampled.stdout.matchAll(/^heuristic: (CORRECTION|no correction)/gm)].map((m) => m[1] === 'CORRECTION')
  await writeFile(verdicts, ids.map((id, n) => JSON.stringify({ prompt_id: id, correction: n === 0 ? !heuristic[n] : heuristic[n] })).join('\n'))
  const { stdout } = await execFileP('node', [ANALYZE, 'check', '--verdicts', verdicts, '--n', '4', '--seed', '7', '--log', f.log, '--projects', f.projects])
  assert.match(stdout, /hand-checked: 4 of 4/)
  assert.match(stdout, /LABEL ERROR RATE: 25\.0%/)
  assert.match(stdout, /95% Wilson CI/)
})

test('cli: check without --verdicts refuses rather than inventing a number', async () => {
  await assert.rejects(
    execFileP('node', [ANALYZE, 'check']),
    (e) => { assert.equal(e.code, 2); assert.match(e.stderr, /--verdicts/); return true },
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
