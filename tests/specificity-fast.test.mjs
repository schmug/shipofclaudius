// Unit + end-to-end tests for the prompt-specificity fast path (packages/specificity).
//
// Like packages/factory-gate, this is model-free code, so these are ordinary unit tests
// rather than a workflow sim. The bar they enforce is spec §8's single invariant: NO
// configuration of this tool may break a session. For every failure mode in that table
// there is a test proving the hook still exits 0 — because a UserPromptSubmit hook that
// can exit non-zero by accident erases the user's prompt, and that is unrecoverable.
// Run:  node tests/specificity-fast.test.mjs
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, mkdir, readFile, readdir } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { DEFAULTS, parseToml, normalizeConfig, loadConfig } from '../packages/specificity/src/config.mjs'
import { parseTranscript, readTail, loadTranscript } from '../packages/specificity/src/transcript.mjs'
import { walkFiles, SKIP_DIRS } from '../packages/specificity/src/files.mjs'
import { buildIndex, termsOf, looksLikePath } from '../packages/specificity/src/context-index.mjs'
import { extractReferents, countCandidates, resolveReferents, tally, stripCode } from '../packages/specificity/src/referents.mjs'
import { inventory, estimateTokens, logLengthBaseline } from '../packages/specificity/src/constraints.mjs'
import { isSafeSessionId, cachePathFor, writeRecord, ensureDir, MAX_CREATE_DEPTH, PHASES } from '../packages/specificity/src/cache.mjs'
import { buildFastBlock, buildRecord, summarize, ambiguityContext, MAX_HOOK_OUTPUT, MAX_LISTED_REFERENTS } from '../packages/specificity/src/record.mjs'
import { decide } from '../packages/specificity/bin/fast.mjs'

const BIN = fileURLToPath(new URL('../packages/specificity/bin/fast.mjs', import.meta.url))
const tests = []
const test = (name, fn) => tests.push([name, fn])

const idx = (blocks = [], files = []) => buildIndex({ blocks, files })
const userTurn = (text) => ({ role: 'user', text })
const asstTurn = (text) => ({ role: 'assistant', text })

// ---------- config (§7) ----------

test('config: flat TOML with comments, quotes and section headers', () => {
  const t = parseToml([
    '# leading comment',
    '[scoring]           # section headers are flattened away',
    'mode = "gate"',
    'gate_threshold = 5',
    'emit_ambiguities = true',
    "sampling_model = 'small-model'  # trailing comment",
    'ignored = [1, 2]',
  ].join('\n'))
  assert.equal(t.mode, 'gate')
  assert.equal(t.gate_threshold, 5)
  assert.equal(t.emit_ambiguities, true)
  assert.equal(t.sampling_model, 'small-model')
  assert.equal('ignored' in t, false, 'arrays are ignored, not half-parsed')
})

test('config: a `#` inside a quoted value is not a comment', () => {
  assert.equal(parseToml('sampling_model = "model#1"').sampling_model, 'model#1')
})

test('config: bad enum / wrong type falls back to the default, never throws', () => {
  const c = normalizeConfig({ mode: 'nonsense', embedding_backend: 'quantum', gate_threshold: 'three', emit_ambiguities: 'yes' })
  assert.equal(c.mode, DEFAULTS.mode)
  assert.equal(c.embedding_backend, DEFAULTS.embedding_backend)
  assert.equal(c.gate_threshold, DEFAULTS.gate_threshold)
  assert.equal(c.emit_ambiguities, DEFAULTS.emit_ambiguities)
})

test('config: gate ships OFF and the threshold ships high enough to be deliberate', () => {
  // §3.4 — exit 2 on UserPromptSubmit ERASES the prompt. A default-on gate would make
  // that destructive path the out-of-the-box experience.
  assert.equal(DEFAULTS.mode, 'advisory')
  assert.ok(DEFAULTS.gate_threshold >= 3)
  assert.equal(DEFAULTS.emit_ambiguities, false)
})

test('config: an absent config file yields defaults rather than an error', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spec-cfg-'))
  assert.deepEqual(loadConfig(dir), { ...DEFAULTS })
})

// ---------- transcript (§3.2) ----------

test('transcript: tolerates malformed lines instead of losing the window', () => {
  const { blocks, malformed } = parseTranscript([
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'check src/a.mjs' } }),
    '{ not json at all',
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } }),
  ].join('\n'))
  assert.equal(blocks.length, 2)
  assert.equal(malformed, 1)
})

test('transcript: tool_use inputs and tool_result output are part of the window', () => {
  // File paths overwhelmingly enter context through tool calls, not prose. Dropping them
  // would make "the file you just read" unresolvable in the common case.
  const { blocks } = parseTranscript([
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'src/deep/thing.mjs' } }] } }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'error in lib/x.py' }] } }),
  ].join('\n'))
  assert.match(blocks[0].text, /src\/deep\/thing\.mjs/)
  assert.match(blocks[1].text, /lib\/x\.py/)
})

test('transcript: a tail read drops the sliced-through first record', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spec-tr-'))
  const path = join(dir, 't.jsonl')
  const line = (n) => JSON.stringify({ type: 'user', message: { role: 'user', content: `turn ${n}` } })
  await writeFile(path, [line(1), line(2), line(3)].join('\n'))
  const { text, truncated } = readTail(path, 60)
  assert.ok(truncated)
  assert.ok(!text.includes('\n{') || text.startsWith('{'), 'result begins on a record boundary')
  const { malformed } = parseTranscript(text)
  assert.equal(malformed, 0, 'no partial record survives the tail slice')
})

test('transcript: bytes that parse to nothing is the §8 "unparseable" case', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spec-tr2-'))
  const path = join(dir, 'bad.jsonl')
  await writeFile(path, 'this is not JSONL at all\nnor is this\n')
  assert.equal(loadTranscript(path).ok, false)
})

test('transcript: an absent path is normal, not an error', () => {
  assert.equal(loadTranscript('').ok, true)
})

// ---------- disk walk ----------

test('files: the walk skips heavy directories and stays bounded', async () => {
  const root = await mkdtemp(join(tmpdir(), 'spec-walk-'))
  await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true })
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(join(root, 'node_modules', 'pkg', 'index.js'), '')
  await writeFile(join(root, 'src', 'app.mjs'), '')
  const files = walkFiles(root)
  assert.ok(files.includes('src/app.mjs'))
  assert.ok(!files.some((f) => f.startsWith('node_modules/')), 'node_modules never enters the index')
  assert.ok(SKIP_DIRS.has('node_modules'))
})

test('files: an unreadable root degrades to an empty index, it does not throw', () => {
  assert.deepEqual(walkFiles(join(tmpdir(), 'definitely-not-here-12345')), [])
})

// ---------- index ----------

test('index: a path indexes under every segment, extension and camelCase piece', () => {
  const t = termsOf('src/config/loadServer.mjs')
  for (const term of ['src', 'config', 'load', 'server', 'mjs']) assert.ok(t.has(term), `indexed under ${term}`)
})

test('index: files on disk are candidates but are never "recent"', () => {
  // A file merely existing in the repo cannot be what "it" refers to.
  const i = idx([userTurn('look at src/seen.mjs')], ['src/unseen.mjs', 'src/seen.mjs'])
  assert.ok(i.entities.has('src/unseen.mjs'))
  assert.ok(i.recent.has('src/seen.mjs'))
  assert.ok(!i.recent.has('src/unseen.mjs'))
})

test('index: looksLikePath does not depend on call order', () => {
  // A /g regex reused for test() advances lastIndex and starts answering differently.
  for (let n = 0; n < 5; n++) assert.equal(looksLikePath('src/a.mjs'), true, `stable on call ${n}`)
})

// ---------- referent extraction (§3.3 step 2) ----------

test('referents: finds pronouns, definites, deictics and file tokens', () => {
  const found = extractReferents('update the config file in src/a.mjs like before so it passes')
  const kinds = found.map((r) => r.kind)
  for (const kind of ['definite', 'file', 'deictic', 'pronoun']) {
    assert.ok(kinds.includes(kind), `extracts a ${kind} referent (got ${kinds.join(', ')})`)
  }
})

test('referents: a definite description does not bridge an adjacent path token', () => {
  // Regression: masking claimed spans is what keeps "the timeout" from being swallowed
  // into "the timeout in src/app.mjs" and then discarded as an overlap.
  const found = extractReferents('fix the timeout in src/app.mjs')
  const definite = found.find((r) => r.kind === 'definite')
  assert.ok(definite, 'the definite description survives next to a path')
  assert.equal(definite.text, 'the timeout', 'and is reported without a dangling preposition')
})

test('referents: complementizer "that" is not a referent', () => {
  const found = extractReferents('make sure that we handle the retry')
  assert.equal(found.filter((r) => r.kind === 'pronoun').length, 0)
})

test('referents: demonstrative + noun is a description, not a bare pronoun', () => {
  const found = extractReferents('rename that helper')
  assert.equal(found.length, 1)
  assert.equal(found[0].kind, 'definite')
  assert.deepEqual(found[0].words, ['helper'])
})

test('referents: fenced code and inline code do not spray referents', () => {
  assert.ok(!stripCode('see ```the thing it does```').includes('the thing'))
  const found = extractReferents('run this:\n```\nthe config file it uses\n```')
  assert.equal(found.filter((r) => r.kind === 'definite').length, 0)
})

test('referents: a token is attributed to exactly one referent', () => {
  const found = extractReferents('open src/a.mjs')
  assert.equal(found.length, 1, 'the path is not also counted as a definite description')
})

// ---------- resolution (§3.3 step 3) ----------

test('resolution: 0 candidates unresolved, 1 grounded, >1 ambiguous', () => {
  const i = idx([userTurn('a.mjs and b.mjs')], ['pkg/one/config.mjs', 'pkg/two/config.mjs'])
  assert.equal(countCandidates({ kind: 'file', text: 'nowhere.mjs', words: [] }, i), 0)
  assert.equal(countCandidates({ kind: 'file', text: 'pkg/one/config.mjs', words: [] }, i), 1)
  assert.equal(countCandidates({ kind: 'definite', words: ['config', 'file'] }, i), 2)
})

test('resolution: "the config file" is discriminated by its MODIFIER, not its head', () => {
  // Regression: `config` appears on the generic-head list, so filtering modifiers by that
  // list threw away the only discriminating word and made every such phrase unresolved.
  const i = idx([], ['pkg/one/config.mjs', 'pkg/two/config.mjs', 'pkg/three/other.mjs'])
  assert.equal(countCandidates({ kind: 'definite', words: ['config', 'file'] }, i), 2)
})

test('resolution: a wholly generic description falls back to what is recently in play', () => {
  const withOne = idx([userTurn('look at src/only.mjs')], ['src/only.mjs', 'src/other.mjs'])
  assert.equal(countCandidates({ kind: 'definite', words: ['file'] }, withOne), 1, '"the file" is grounded by recency')
  const withNone = idx([userTurn('no paths here')], ['src/only.mjs'])
  assert.equal(countCandidates({ kind: 'definite', words: ['file'] }, withNone), 0)
})

test('resolution: a pronoun with a non-empty window is indeterminate, not ambiguous', () => {
  // Measured over 1,918 real turns: the pronoun branch said "ambiguous" ~97% of the time
  // at every window size and every salience cap, and the most-recent entity was the true
  // antecedent only ~5% of the time. The count is not a measurement, so no status is
  // claimed from it.
  const populated = idx([userTurn('a/one.mjs'), userTurn('b/two.mjs')], [])
  const [pronoun] = resolveReferents(extractReferents('fix it'), populated)
  assert.equal(pronoun.status, 'indeterminate')
  assert.equal(pronoun.candidates, 2, 'the raw count is still recorded for M4')
})

test('resolution: a pronoun with an EMPTY window is a true unresolved', () => {
  // This is the one pronoun verdict the index can actually support, and the case the
  // whole tool exists for: nothing in the window to point at.
  const [pronoun] = resolveReferents(extractReferents('fix it'), idx([], []))
  assert.equal(pronoun.status, 'unresolved')
})

test('resolution: indeterminate referents are excluded from the score and the report', () => {
  const populated = idx([userTurn('a/one.mjs'), userTurn('b/two.mjs')], [])
  const fast = buildFastBlock('fix it', extractReferents('fix it'), populated)
  assert.equal(fast.indeterminate, 1)
  assert.equal(fast.grounded + fast.unresolved + fast.ambiguous, 0, 'nothing scorable')
  assert.equal(ambiguityContext(fast), '', 'and nothing to tell Claude about')
})

test('resolution: a pronoun resolves against RECENT context only', () => {
  const i = idx([userTurn('a/one.mjs'), userTurn('b/two.mjs')], [])
  assert.equal(countCandidates({ kind: 'pronoun', words: [] }, i), 2, 'two recent entities is ambiguous, not grounded')
  assert.equal(countCandidates({ kind: 'pronoun', words: [] }, idx([], [])), 0)
})

test('resolution: a deictic back-reference needs a prior turn to point at', () => {
  assert.equal(countCandidates({ kind: 'deictic', words: [] }, idx([], [])), 0)
  assert.equal(countCandidates({ kind: 'deictic', words: [] }, idx([userTurn('x')], [])), 1)
  assert.equal(countCandidates({ kind: 'deictic', words: [] }, idx([userTurn('x'), asstTurn('y'), userTurn('z')], [])), 2)
})

test('resolution: the same prompt scores differently against different context', () => {
  // This is the whole thesis of the spec — specificity is conditional, not a property of
  // the prompt string. If this test ever passes trivially, the tool measures nothing.
  const prompt = 'fix the timeout'
  const refs = extractReferents(prompt)
  const blind = tally(resolveReferents(refs, idx([], [])))
  const grounded = tally(resolveReferents(refs, idx([userTurn('src/timeout-handler.mjs is failing')], [])))
  assert.equal(blind.unresolved, 1)
  assert.equal(grounded.grounded, 1)
})

// ---------- constraints (§3.3 steps 4-5) ----------

test('constraints: each class is counted separately', () => {
  const c = inventory('It must return JSON. Update src/a.mjs and src/b.mjs. Format as a table.')
  assert.ok(c.acceptance >= 1)
  assert.ok(c.io_spec >= 1)
  assert.equal(c.named_files, 2)
  assert.ok(c.format >= 1)
})

test('constraints: a pasted log is not the user stating acceptance criteria', () => {
  const fenced = inventory('```\nmust verify should expect\n```')
  assert.equal(fenced.acceptance, 0)
  assert.ok(fenced.format >= 1, 'but the fence itself is a format signal')
})

test('constraints: the length baseline is log of the token estimate', () => {
  assert.equal(estimateTokens(''), 0)
  const tokens = estimateTokens('a few words here')
  assert.ok(tokens > 0)
  assert.equal(logLengthBaseline(tokens), Number(Math.log(tokens).toFixed(4)))
  assert.equal(logLengthBaseline(0), 0, 'log(0) is clamped, never -Infinity in the JSON')
})

// ---------- cache (§6) ----------

test('cache: a session_id that is not a plain id is refused, not sanitized', () => {
  for (const bad of ['../../etc/passwd', 'a/b', '', 'x'.repeat(200), 'a b']) {
    assert.equal(isSafeSessionId(bad), false, `${JSON.stringify(bad)} is refused`)
    assert.equal(cachePathFor('/tmp/x', bad), null)
  }
  assert.equal(isSafeSessionId('abc123_-'), true)
})

test('cache: the write is atomic and leaves no temp file behind', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spec-cache-'))
  const target = writeRecord(dir, 'sess1', { session_id: 'sess1', phase: 'skipped' })
  assert.ok(target)
  assert.deepEqual(JSON.parse(await readFile(target, 'utf8')).phase, 'skipped')
  assert.deepEqual((await readdir(dir)).filter((f) => f.endsWith('.tmp')), [], 'no .tmp residue')
})

test('cache: a refused session_id writes nothing at all', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spec-cache2-'))
  assert.equal(writeRecord(dir, '../escape', { phase: 'skipped' }), null)
  assert.deepEqual(await readdir(dir), [])
})

test('cache: ensureDir creates a nested path with no recursive mkdir', async () => {
  const base = await mkdtemp(join(tmpdir(), 'spec-mk-'))
  const target = join(base, 'a', 'b', 'c')
  ensureDir(target)
  assert.ok((await import('node:fs')).statSync(target).isDirectory())
  ensureDir(target)  // idempotent
})

test('cache: ensureDir FAILS FAST instead of hanging on a pathological directory', () => {
  // Regression. `mkdirSync(dir, { recursive: true })` never returns for a path under
  // Linux procfs; the bounded stat-then-create walk throws instead. The wall-clock bound
  // is the assertion that matters — a hang is not a failure any try/catch can see, and on
  // UserPromptSubmit it stalls the user's turn until the host times out.
  for (const bad of ['/proc/nonexistent/nope', '/proc/self/mem/nope']) {
    const started = Date.now()
    assert.throws(() => ensureDir(bad), undefined, `${bad} must throw`)
    assert.ok(Date.now() - started < 2000, `${bad} must fail fast, took ${Date.now() - started}ms`)
  }
})

test('cache: ensureDir refuses to build an arbitrarily deep tree', async () => {
  const base = await mkdtemp(join(tmpdir(), 'spec-deep-'))
  const tooDeep = join(base, ...Array.from({ length: MAX_CREATE_DEPTH + 3 }, (_, n) => `d${n}`))
  assert.throws(() => ensureDir(tooDeep), /levels below any existing directory/)
})

test('record: the shape matches the §6 schema', () => {
  const i = idx([userTurn('src/a.mjs')], ['src/a.mjs'])
  const fast = buildFastBlock('fix the timeout in src/a.mjs', extractReferents('fix the timeout in src/a.mjs'), i)
  for (const key of ['referents', 'unresolved', 'ambiguous', 'grounded', 'indeterminate', 'constraints', 'prompt_tokens', 'log_length_baseline']) {
    assert.ok(key in fast, `fast block carries ${key}`)
  }
  for (const key of ['acceptance', 'io_spec', 'named_files', 'format']) assert.ok(key in fast.constraints)
  for (const r of fast.referents) {
    assert.deepEqual(Object.keys(r).sort(), ['candidates', 'kind', 'status', 'text'])
  }
  const rec = buildRecord({ session_id: 's', prompt_id: 'p', fast, phase: 'skipped' })
  assert.deepEqual(Object.keys(rec).sort(), ['fast', 'phase', 'prompt_id', 'session_id', 'written_at'])
  assert.ok(PHASES.has(rec.phase))
})

// ---------- hook output contract (§3.4) ----------

test('output: additionalContext is factual, never imperative', () => {
  // Text framed as an out-of-band system command can trip Claude's prompt-injection
  // defenses and get surfaced to the user instead of used as context.
  const fast = { referents: [{ text: 'the config file', kind: 'definite', candidates: 3, status: 'ambiguous' }], unresolved: 0, ambiguous: 1 }
  const ctx = ambiguityContext(fast)
  assert.match(ctx, /matches 3 candidates/)
  assert.doesNotMatch(ctx, /\b(you must|please|ask the user|instruct|do not)\b/i)
})

test('output: additionalContext is capped at 10,000 characters', () => {
  const referents = Array.from({ length: 900 }, (_, n) => ({ text: `the referent number ${n}`, kind: 'definite', candidates: 0, status: 'unresolved' }))
  assert.ok(ambiguityContext({ referents, unresolved: 900, ambiguous: 0 }).length <= MAX_HOOK_OUTPUT)
})

test('output: the referent list is capped and leads with the unresolved ones', () => {
  // Real turns average ~19.6 referents, so an uncapped list is noise long before it hits
  // the character budget. Unresolved is the actionable class, so it sorts first.
  const referents = [
    ...Array.from({ length: 12 }, (_, n) => ({ text: `the ambiguous ${n}`, kind: 'definite', candidates: 4, status: 'ambiguous' })),
    ...Array.from({ length: 3 }, (_, n) => ({ text: `the missing ${n}`, kind: 'definite', candidates: 0, status: 'unresolved' })),
  ]
  const ctx = ambiguityContext({ referents, unresolved: 3, ambiguous: 12 })
  const listed = ctx.split('\n').filter((l) => l.startsWith('The referent'))
  assert.equal(listed.length, MAX_LISTED_REFERENTS)
  assert.match(listed[0], /the missing/, 'unresolved referents lead the list')
  assert.match(ctx, new RegExp(`${15 - MAX_LISTED_REFERENTS} further unresolved or ambiguous referents are not listed`))
})

test('output: a fully grounded turn emits no additionalContext at all', () => {
  assert.equal(ambiguityContext({ referents: [{ text: 'src/a.mjs', kind: 'file', candidates: 1, status: 'grounded' }] }), '')
})

test('output: summarize reports counts, not a bare adjective', () => {
  const s = summarize({ referents: [{ status: 'unresolved' }], unresolved: 1, ambiguous: 0, constraints: { acceptance: 1, io_spec: 2, named_files: 3, format: 4 } })
  assert.match(s, /1 unresolved/)
  assert.match(s, /3 files/)
})

// ---------- the decision layer ----------

const EVENT = (over = {}) => ({ session_id: 'sess', prompt_id: 'pid', prompt: 'fix it and that thing like before', cwd: tmpdir(), transcript_path: '', ...over })

test('decide: advisory mode never blocks, however unresolved the turn is', () => {
  const d = decide(EVENT(), normalizeConfig({ mode: 'advisory' }))
  assert.equal(d.exitCode, 0)
  assert.ok(d.record.fast.unresolved > 0, 'the turn really is unresolved')
})

test('decide: gate mode blocks with exit 2 at the threshold, and only there', () => {
  const strict = decide(EVENT(), normalizeConfig({ mode: 'gate', gate_threshold: 1 }))
  assert.equal(strict.exitCode, 2, 'exit 2 is the only code that blocks')
  assert.match(strict.stderr, /unresolved referents/)
  assert.equal(decide(EVENT(), normalizeConfig({ mode: 'gate', gate_threshold: 99 })).exitCode, 0)
})

test('decide: emit_ambiguities gates the additionalContext channel', () => {
  assert.equal(decide(EVENT(), normalizeConfig({})).stdout.includes('hookSpecificOutput'), false)
  const on = JSON.parse(decide(EVENT(), normalizeConfig({ emit_ambiguities: true })).stdout)
  assert.equal(on.hookSpecificOutput.hookEventName, 'UserPromptSubmit')
  assert.ok(on.hookSpecificOutput.additionalContext.length > 0)
})

test('decide: an unparseable transcript degrades to phase "error", not an exception', () => {
  const d = decide(EVENT({ transcript_path: fileURLToPath(import.meta.url) }), normalizeConfig({}))
  assert.equal(d.record.phase, 'error')
  assert.equal(d.exitCode, 0)
})

test('decide: M1 records phase "skipped", not a sampling promise it cannot keep', () => {
  // A "sampling" phase with no sampler wired up renders the in-flight placeholder in the
  // status line forever.
  assert.equal(decide(EVENT(), normalizeConfig({})).record.phase, 'skipped')
})

// ---------- end to end, through the real process ----------

function runHook(event, { dir, config } = {}) {
  const res = { code: 0, stdout: '', stderr: '' }
  try {
    res.stdout = execFileSync('node', [BIN], {
      input: JSON.stringify(event),
      encoding: 'utf8',
      env: { ...process.env, SPECIFICITY_DIR: dir },
    })
  } catch (e) {
    res.code = e.status
    res.stdout = e.stdout || ''
    res.stderr = e.stderr || ''
  }
  return res
}

test('e2e: the hook writes the cache and prints its advisory JSON', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spec-e2e-'))
  const res = runHook({ session_id: 'e2e1', prompt_id: 'p1', prompt: 'fix the timeout', cwd: tmpdir() }, { dir })
  assert.equal(res.code, 0)
  assert.match(JSON.parse(res.stdout).systemMessage, /specificity/)
  const cached = JSON.parse(await readFile(join(dir, 'e2e1.json'), 'utf8'))
  assert.equal(cached.prompt_id, 'p1')
  assert.ok(cached.written_at > 0)
})

test('e2e: garbage on stdin exits 0 and still emits valid JSON', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spec-e2e2-'))
  const res = { code: 0, stdout: '' }
  try {
    res.stdout = execFileSync('node', [BIN], { input: 'not json', encoding: 'utf8', env: { ...process.env, SPECIFICITY_DIR: dir } })
  } catch (e) { res.code = e.status }
  assert.equal(res.code, 0)
  assert.ok(JSON.parse(res.stdout).systemMessage)
})

test('e2e: an unwritable cache directory is cosmetic, not fatal', async () => {
  // The unwritable path is "a directory underneath a regular FILE", which fails ENOTDIR on
  // every OS and for every uid — including root, which ignores mode bits and would sail
  // straight through a chmod-based test. The previous version used /proc/nonexistent/nope,
  // which is merely absent on macOS but is procfs on Linux, where it hung CI for 30
  // minutes; see ensureDir().
  const base = await mkdtemp(join(tmpdir(), 'spec-e2e3-'))
  await writeFile(join(base, 'blocker'), '')
  const started = Date.now()
  const res = runHook({ session_id: 'e2e3', prompt: 'hello', cwd: tmpdir() }, { dir: join(base, 'blocker', 'cache') })
  assert.equal(res.code, 0, 'the session survives a cache it cannot write')
  assert.ok(Date.now() - started < 5000, 'and fails fast rather than hanging the turn')
})

test('e2e: a traversal session_id writes no file and still exits 0', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spec-e2e4-'))
  const res = runHook({ session_id: '../../escape', prompt: 'hello', cwd: tmpdir() }, { dir })
  assert.equal(res.code, 0)
  assert.deepEqual(await readdir(dir), [])
})

test('e2e: gate mode reaches exit 2 through the real process', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spec-e2e5-'))
  await writeFile(join(dir, 'config.toml'), 'mode = "gate"\ngate_threshold = 1\n')
  const res = runHook({ session_id: 'e2e5', prompt: 'fix it like before', cwd: tmpdir() }, { dir })
  assert.equal(res.code, 2)
})

test('e2e: the fast path stays inside its sub-2s budget on a real repo', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spec-e2e6-'))
  const repo = fileURLToPath(new URL('../', import.meta.url))
  const started = Date.now()
  runHook({ session_id: 'e2e6', prompt: 'update the config file so it returns JSON', cwd: repo }, { dir })
  const elapsed = Date.now() - started
  assert.ok(elapsed < 2000, `fast path took ${elapsed}ms, budget is 2000ms (includes node startup)`)
})

// ---- runner ----
let failed = 0
for (const [name, fn] of tests) {
  try { await fn(); console.log('PASS', name) }
  catch (e) { failed++; console.error('FAIL', name, '\n  ', e.message) }
}
console.log(failed ? `\n${failed}/${tests.length} FAILED` : `\nall ${tests.length} passed`)
process.exit(failed ? 1 : 0)
