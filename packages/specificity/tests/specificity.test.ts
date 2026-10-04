import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { ModelCompleteResult, ModelForkResult, On, PromptOrigin, SessionMessage } from 'claude-code'

const GOOD = JSON.stringify({
  score: 72,
  dimensions: { target: 3, outcome: 2, constraints: 1, scope: 2 },
  gap: 'which file?',
  rationale: 'The file is named but done-criteria are loose.',
  // Out of order on purpose: the panel lists quoted pieces first, missing ones after.
  notes: [
    { quote: null, dimension: 'constraints', suggestion: 'Should the public API stay the same?' },
    { quote: 'fix the bug', dimension: 'outcome', suggestion: 'Say what correct behaviour looks like.' },
  ],
  improved: 'Fix [which bug?] in src/a.ts so that [expected behaviour], keeping the public API unchanged.',
})

const USAGE = { input_tokens: 10, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
const SLOW_MS = 5_000

type World = {
  clock: MockClock
  submitted: string[]
  modelCalls: number
  toasts: string[]
  statuses: (string | undefined)[]
  /** What `$.session.messages()` answers. */
  messages: SessionMessage[]
  /** The prompts the haiku judge was sent. */
  asked: string[]
  /** The forks taken. */
  forks: number
  /** When set, the session holds these once the fork answers (the main thread moved on meanwhile). */
  afterFork: SessionMessage[] | null
  /** When set, `$.command.list()` rejects. */
  commandsFail: boolean
  /** While set, `$.command.list()` waits on it. */
  commandsHeld: Promise<void> | null
  /** Panes opened and closed, in order: `open <id>` / `close <id>`. */
  panes: string[]
  /** The prompt box's draft, which `$.prompt.fill` writes. */
  draft: string
}

const answered = (text: string) => ({ isAnswered: true as const, text, usage: USAGE })
const complete = (reply: string | ModelCompleteResult): { value: ModelCompleteResult } => ({
  value: typeof reply === 'string' ? answered(reply) : reply,
})
const fork = (reply: string | ModelForkResult): { value: ModelForkResult } => ({
  value: typeof reply === 'string' ? answered(reply) : reply,
})

/** The engine beneath the plugin: a slow model answering `reply` (the fork `forkReply`), an empty transcript, and recorders. */
type Reply = string | ModelCompleteResult

/** The engine beneath the plugin. `reply` answers every completion; a list answers them in turn. */
function world(on: On, reply: Reply | Reply[], forkReply: string | ModelForkResult = Array.isArray(reply) ? GOOD : reply): World {
  const replies = Array.isArray(reply) ? [...reply] : null
  const w: World = { clock: mock.clock(on), submitted: [], modelCalls: 0, toasts: [], statuses: [], messages: [], asked: [], forks: 0, afterFork: null, commandsFail: false, commandsHeld: null, panes: [], draft: '' }
  on('prompt.submit', ($, e) => {
    w.submitted.push(e.text)
    return { text: e.text }
  })
  on('session.messages', () => ({ value: w.messages }))
  on('model.complete', async ($, e) => {
    w.modelCalls += 1
    w.asked.push(e.prompt)
    await w.clock.sleep(SLOW_MS)
    return complete(replies === null ? (reply as Reply) : (replies.shift() ?? GOOD))
  })
  on('model.fork', async () => {
    w.modelCalls += 1
    w.forks += 1
    if (typeof forkReply !== 'string' && !forkReply.isAnswered && forkReply.reason === 'nothing-to-fork') return fork(forkReply)
    await w.clock.sleep(SLOW_MS)
    if (w.afterFork !== null) w.messages = w.afterFork
    return fork(forkReply)
  })
  on('ui.toast', ($, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', ($, e) => {
    w.statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('ui.open', ($, e) => {
    w.panes.push(`open ${e.id}`)
    return { value: { isPlaced: true as const } }
  })
  on('prompt.read', () => ({ value: { text: w.draft, cursor: w.draft.length } }))
  on('prompt.fill', ($, e) => {
    w.draft = e.mode === 'append' ? w.draft + e.text : e.text
    return { isFilled: true, text: w.draft }
  })
  on('ui.close', ($, e) => {
    w.panes.push(`close ${e.id}`)
    return { value: undefined }
  })
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('command.list', async () => {
    await w.commandsHeld
    if (w.commandsFail) throw new Error('command lookup failed')
    return { value: [{ name: 'compact', description: 'Compact', source: 'builtin' as const }] }
  })
  on('ui.render', { component: 'SessionMode' }, () => ({ type: 'Box', props: { key: 'engine' }, children: [] }))
  return w
}

const submit = ($: Engine, text: string, origin: PromptOrigin = { kind: 'composer' }) =>
  $.prompt.submit({ text, origin, wait: false })

/** The last result as `/spec` reports it. */
const spec = async ($: Engine, args = '') =>
  (await $.command.run({ command: 'spec', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })).text ?? ''
const NONE = 'No prompt scored yet this session.'

/** Submits a prompt and lets the slow judge finish. */
async function scored($: Engine, w: World, text: string) {
  await submit($, text)
  await w.clock.settle()
  await w.clock.advance(SLOW_MS)
}

const FOOTER_PROPS = { modes: [] as string[] }
const PANE_PROPS = {
  title: 'Specificity',
  isFocused: false,
  bodyColumns: 60,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 20 },
  view: {},
}

/** The footer chip's circle, or undefined when no chip is drawn. */
async function chip($: Engine, surface: 'terminal' | 'desktop' = 'terminal'): Promise<string | undefined> {
  const ui = await $.ui.mount({ plugin: 'specificity', surface, component: 'SessionMode', props: FOOTER_PROPS })
  const score = await ui.find({ key: 'chip' })
  await ui.unmount()
  return score === undefined ? undefined : String(score.props['label'])
}

type Drawn = { type: string; props?: Record<string, unknown>; children?: (Drawn | string)[] }

/** The footer sparkline's bars, oldest first, as glyph and color: the Text children of the Box keyed `spark`. */
async function sparkBars(ui: { drawn: () => Promise<unknown> }) {
  const walk = (node: Drawn | string): Drawn | undefined => {
    if (typeof node === 'string') return undefined
    if (node.props?.['key'] === 'spark') return node
    for (const child of node.children ?? []) {
      const hit = walk(child)
      if (hit !== undefined) return hit
    }
    return undefined
  }
  const spark = walk((await ui.drawn()) as Drawn)
  return (spark?.children ?? []).map(t => {
    const text = t as Drawn
    return { glyph: (text.children ?? []).join(''), color: text.props?.['color'] }
  })
}

describe('prompt.submit', () => {
  test('the prompt reaches the session unchanged, before scoring finishes', async ($, on) => {
    const w = world(on, GOOD)
    const result = await submit($, 'fix the bug in src/a.ts')

    expect(result).toMatchObject({ text: 'fix the bug in src/a.ts' })
    expect(w.submitted).toEqual(['fix the bug in src/a.ts'])
    expect(await spec($)).toBe(NONE)

    await w.clock.settle()
    expect(w.modelCalls).toBe(1)
    expect(await spec($)).toBe(NONE)

    await w.clock.advance(SLOW_MS)
    expect(await spec($)).toContain('spec 72/100')
    expect(await chip($)).toBe('🟢')
    // The chip replaced the status-line entry: nothing is published there.
    expect(w.statuses).toEqual([])
  })

  test('non-user origins and slash commands are not scored', async ($, on) => {
    const w = world(on, GOOD)
    const others: PromptOrigin[] = [
      { kind: 'plugin', name: 'other' },
      { kind: 'peer' },
      { kind: 'task-notification' },
      { kind: 'scheduled-trigger' },
      { kind: 'unclassified' },
    ]
    for (const origin of others) await submit($, 'fix the bug', origin)
    await submit($, '/compact')
    await w.clock.settle()
    await w.clock.advance(SLOW_MS)

    expect(w.submitted).toHaveLength(others.length + 1)
    expect(w.modelCalls).toBe(0)
    expect(await spec($)).toBe(NONE)
  })

  test('a prompt that starts with a path or route is still scored', async ($, on) => {
    const w = world(on, GOOD)
    await scored($, w, '/tmp is full')
    expect(w.modelCalls).toBe(1)
    await scored($, w, '/login should redirect after authentication')
    expect(w.modelCalls).toBe(2)
    expect(await spec($)).toContain('for "/login should redirect')
  })

  test("the judge reads only what came before the prompt, never Claude's answer to it", async ($, on) => {
    const w = world(on, GOOD)
    w.messages = [
      { role: 'user', text: 'what options do I have?', toolUses: [] },
      { role: 'assistant', text: 'Option 1, option 2 or option 3.', toolUses: [] },
      { role: 'user', text: 'yes, do option 2', toolUses: [] },
      { role: 'assistant', text: 'ANSWER-ALREADY-STARTED', toolUses: [] },
    ]
    await scored($, w, 'yes, do option 2')
    const asked = w.asked[0] ?? ''
    expect(asked).toContain('Option 1, option 2 or option 3.')
    expect(asked).not.toContain('ANSWER-ALREADY-STARTED')
    expect(asked.split('yes, do option 2')).toHaveLength(2)
  })

  test('a malformed reply produces no chip and no toast', async ($, on) => {
    const w = world(on, 'Sure! The prompt is fairly specific, maybe 70.')
    await scored($, w, 'fix the bug')

    expect(w.modelCalls).toBe(1)
    expect(await spec($)).toBe(NONE)
    expect(w.toasts).toEqual([])
    for (const surface of ['terminal', 'desktop'] as const) expect(await chip($, surface)).toBeUndefined()
  })

  test('mode off makes no model calls and draws no chip', { options: { mode: 'off' } }, async ($, on) => {
    const w = world(on, GOOD)
    await scored($, w, 'fix the bug in src/a.ts')

    expect(w.submitted).toEqual(['fix the bug in src/a.ts'])
    expect(w.modelCalls).toBe(0)
    expect(await chip($)).toBeUndefined()
  })

  test('fork mode judges through $.model.fork', { options: { mode: 'fork' } }, async ($, on) => {
    const w = world(on, GOOD)
    await scored($, w, 'yes, do option 2')
    expect(w.modelCalls).toBe(1)
    expect(await spec($)).toContain('(fork,')
  })

  test("fork mode never forks once Claude's answer has started", { options: { mode: 'fork' } }, async ($, on) => {
    const w = world(on, GOOD)
    w.messages = [
      { role: 'user', text: 'yes, do option 2', toolUses: [] },
      { role: 'assistant', text: 'ANSWER-ALREADY-STARTED', toolUses: [] },
    ]
    await submit($, 'yes, do option 2')
    await w.clock.settle()
    await w.clock.advance(SLOW_MS)
    await w.clock.settle()
    await w.clock.advance(SLOW_MS)

    expect(w.forks).toBe(0)
    expect(w.asked[0] ?? '').not.toContain('ANSWER-ALREADY-STARTED')
    expect(await spec($)).toContain('(haiku,')
  })

  test("fork mode drops a fork taken while Claude's answer started", { options: { mode: 'fork' } }, async ($, on) => {
    const w = world(on, GOOD)
    w.messages = [{ role: 'user', text: 'yes, do option 2', toolUses: [] }]
    w.afterFork = [...w.messages, { role: 'assistant', text: 'ANSWER-ALREADY-STARTED', toolUses: [] }]
    await submit($, 'yes, do option 2')
    await w.clock.settle()
    await w.clock.advance(SLOW_MS)
    await w.clock.settle()
    await w.clock.advance(SLOW_MS)

    expect(w.forks).toBe(1)
    expect(w.asked).toHaveLength(1)
    expect(w.asked[0] ?? '').not.toContain('ANSWER-ALREADY-STARTED')
    expect(await spec($)).toContain('(haiku,')
  })

  test('fork mode falls back to haiku before the first response', { options: { mode: 'fork' } }, async ($, on) => {
    const w = world(on, GOOD, { isAnswered: false, reason: 'nothing-to-fork' })
    await scored($, w, 'fix the bug')
    expect(w.modelCalls).toBe(2)
    expect(await spec($)).toContain('(haiku,')
  })

  test('a reply that omits gap is a non-answer', async ($, on) => {
    const { gap: _omitted, ...rest } = JSON.parse(GOOD) as Record<string, unknown>
    const w = world(on, JSON.stringify(rest))
    await scored($, w, 'fix the bug')
    expect(w.modelCalls).toBe(1)
    expect(await spec($)).toBe(NONE)
  })

  test('an explicit null gap is accepted', async ($, on) => {
    const w = world(on, JSON.stringify({ ...JSON.parse(GOOD), gap: null }))
    await scored($, w, 'fix the bug in src/a.ts')
    expect(await spec($)).toContain('gap: none')
  })

  test('a judge still running at /clear never lands', async ($, on) => {
    const w = world(on, GOOD)
    on('session.end', ($, e) => ({ sessionId: e.sessionId }))
    await submit($, 'fix the bug in src/a.ts')
    await w.clock.settle()
    expect(w.modelCalls).toBe(1)
    await $.session.end({ reason: 'clear', sessionId: 'old', resume: { id: 'old' } })
    await w.clock.advance(SLOW_MS)
    expect(await spec($)).toBe(NONE)
    expect(await chip($)).toBeUndefined()
  })

  test('a /clear before the queued judge starts drops it', async ($, on) => {
    const w = world(on, GOOD)
    on('session.end', ($, e) => ({ sessionId: e.sessionId }))
    await submit($, 'fix the bug in src/a.ts')
    await $.session.end({ reason: 'clear', sessionId: 'old', resume: { id: 'old' } })
    await w.clock.settle()
    await w.clock.advance(SLOW_MS)
    expect(w.modelCalls).toBe(0)
    expect(await spec($)).toBe(NONE)
    expect(await chip($)).toBeUndefined()
  })

  test('a /clear before the queued judge starts takes no fork', { options: { mode: 'fork' } }, async ($, on) => {
    const w = world(on, GOOD)
    on('session.end', ($, e) => ({ sessionId: e.sessionId }))
    await submit($, 'fix the bug in src/a.ts')
    await $.session.end({ reason: 'clear', sessionId: 'old', resume: { id: 'old' } })
    await w.clock.settle()
    await w.clock.advance(SLOW_MS)
    expect(w.forks).toBe(0)
    expect(w.modelCalls).toBe(0)
  })

  test('a /clear during the command lookup stops the judge before any model call', async ($, on) => {
    const w = world(on, GOOD)
    on('session.end', ($, e) => ({ sessionId: e.sessionId }))
    let release = () => {}
    w.commandsHeld = new Promise(resolve => (release = resolve))
    await submit($, '/tmp is full')
    await w.clock.settle()
    await $.session.end({ reason: 'clear', sessionId: 'old', resume: { id: 'old' } })
    release()
    await w.clock.settle()
    await w.clock.advance(SLOW_MS)
    expect(w.modelCalls).toBe(0)
  })

  test('exiting while the newest judge runs keeps the older score hidden on restart', async ($, on) => {
    const w = world(on, GOOD)
    on('session.end', ($, e) => ({ sessionId: e.sessionId }))
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    await scored($, w, 'fix the bug in src/a.ts')
    await submit($, 'and the other one')
    await w.clock.settle()
    await $.session.end({ reason: 'prompt_input_exit', sessionId: 'old', resume: { id: 'old' } })
    await w.clock.advance(SLOW_MS)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    expect(await chip($)).toBeUndefined()
  })

  test('a command after a prompt still being judged does not mask it at exit', async ($, on) => {
    const w = world(on, GOOD)
    on('session.end', ($, e) => ({ sessionId: e.sessionId }))
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    await scored($, w, 'fix the bug in src/a.ts')
    await submit($, 'and the other one')
    await submit($, '/compact')
    await w.clock.settle()
    await $.session.end({ reason: 'prompt_input_exit', sessionId: 'old', resume: { id: 'old' } })
    await w.clock.advance(SLOW_MS)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    expect(await chip($)).toBeUndefined()
  })

  test('exiting while a /name prompt is unclassified keeps the older score hidden', async ($, on) => {
    const w = world(on, GOOD)
    on('session.end', ($, e) => ({ sessionId: e.sessionId }))
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    await scored($, w, 'fix the bug in src/a.ts')
    w.commandsHeld = new Promise(() => {})
    await submit($, '/tmp is full')
    await w.clock.settle()
    await $.session.end({ reason: 'prompt_input_exit', sessionId: 'old', resume: { id: 'old' } })
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    expect(await chip($)).toBeUndefined()
  })

  test('a superseded /name prompt still in lookup does not hide the newest score at exit', async ($, on) => {
    const w = world(on, GOOD)
    on('session.end', ($, e) => ({ sessionId: e.sessionId }))
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    w.commandsHeld = new Promise(() => {})
    await submit($, '/tmp is full')
    await scored($, w, 'clean out /tmp/cache older than a day')
    await $.session.end({ reason: 'prompt_input_exit', sessionId: 'old', resume: { id: 'old' } })
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    expect(await chip($)).toBe('🟢')
  })

  test('a command after the newest score does not hide it at exit', async ($, on) => {
    const w = world(on, GOOD)
    on('session.end', ($, e) => ({ sessionId: e.sessionId }))
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    await scored($, w, 'fix the bug in src/a.ts')
    await submit($, '/compact')
    await w.clock.settle()
    await $.session.end({ reason: 'prompt_input_exit', sessionId: 'old', resume: { id: 'old' } })
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    expect(await chip($)).toBe('🟢')
  })

  test('exiting after the newest score landed still republishes it on restart', async ($, on) => {
    const w = world(on, GOOD)
    on('session.end', ($, e) => ({ sessionId: e.sessionId }))
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    await scored($, w, 'fix the bug in src/a.ts')
    await $.session.end({ reason: 'prompt_input_exit', sessionId: 'old', resume: { id: 'old' } })
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    expect(await chip($)).toBe('🟢')
  })

  test('a failed judge for the newest prompt hides the previous score', async ($, on) => {
    const w = world(on, [GOOD, 'not json'])
    await scored($, w, 'fix the bug in src/a.ts')
    expect(await chip($)).toBe('🟢')
    await scored($, w, 'and the other one')
    expect(w.modelCalls).toBe(2)
    expect(await chip($)).toBeUndefined()
    expect(w.toasts).toEqual([])
    expect(await spec($)).toContain('for "fix the bug in src/a.ts"')
  })

  test('/spec on after a failed newest judge does not bring back the older score', async ($, on) => {
    const w = world(on, [GOOD, 'not json'])
    await scored($, w, 'fix the bug in src/a.ts')
    await scored($, w, 'and the other one')
    await spec($, 'on')
    expect(await chip($)).toBeUndefined()
  })

  test('a path-led prompt keeps its submission order', async ($, on) => {
    const w = world(on, GOOD)
    await submit($, '/tmp is full')
    await submit($, 'clean out /tmp/cache older than a day')
    await w.clock.settle()
    await w.clock.advance(SLOW_MS)
    // The older prompt was superseded before its judge started, so it never pays for a call.
    expect(w.modelCalls).toBe(1)
    expect(await spec($)).toContain('for "clean out /tmp/cache')
  })

  test('a restart after a failed newest judge does not republish the older score', async ($, on) => {
    const w = world(on, [GOOD, 'not json'])
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    await scored($, w, 'fix the bug in src/a.ts')
    await scored($, w, 'and the other one')
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    expect(await chip($)).toBeUndefined()
  })

  test('a restart republishes a visible score', async ($, on) => {
    const w = world(on, GOOD)
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    await scored($, w, 'fix the bug in src/a.ts')
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    expect(await chip($)).toBe('🟢')
  })

  test('a real command sent while the previous judge finishes does not drop it', async ($, on) => {
    const w = world(on, GOOD)
    let release: () => void = () => {}
    w.commandsHeld = new Promise<void>(resolve => {
      release = resolve
    })
    await submit($, 'fix the bug in src/a.ts')
    await w.clock.settle()
    await submit($, '/compact')
    await w.clock.settle()
    await w.clock.advance(SLOW_MS)
    expect(await spec($)).toContain('spec 72/100')
    release()
    await w.clock.settle()
    expect(w.modelCalls).toBe(1)
  })

  test('a real slash command does not cancel the previous score', async ($, on) => {
    const w = world(on, GOOD)
    await submit($, 'fix the bug in src/a.ts')
    await w.clock.settle()
    await submit($, '/compact')
    await w.clock.settle()
    await w.clock.advance(SLOW_MS)
    expect(w.modelCalls).toBe(1)
    expect(await spec($)).toContain('spec 72/100')
  })

  test('a failed command lookup still scores a path-led prompt, replacing the old score', async ($, on) => {
    const w = world(on, GOOD)
    await scored($, w, 'fix the bug in src/a.ts')
    w.commandsFail = true
    await scored($, w, '/tmp is full')

    expect(await spec($)).toContain('for "/tmp is full"')
  })

  test('api errors and aborts are quiet', async ($, on) => {
    const w = world(on, { isAnswered: false, reason: 'aborted', usage: USAGE })
    await scored($, w, 'fix the bug')
    expect(await spec($)).toBe(NONE)
    expect(w.toasts).toEqual([])
    expect(await chip($)).toBeUndefined()
  })
})

describe('clef mode', () => {
  const CLEF_URL = 'http://127.0.0.1:8765/v1/systemone'
  const clefReply = (scores: Record<string, number>) =>
    JSON.stringify({
      model: 'clef-flash',
      answers: Object.fromEntries(Object.entries(scores).map(([id, score]) => [id, { type: 'score', score }])),
      usage: { input_tokens: 900, output_tokens: 0 },
    })
  /** Stubs the local Clef server: `reply` is the body, or an Error to throw. */
  function clefServer(on: On, reply: string | Error, status = 200) {
    const seen: { url: string; body: string }[] = []
    on('http.fetch', ($, e) => {
      seen.push({ url: e.url, body: e.init?.body ?? '' })
      if (reply instanceof Error) throw reply
      return { value: { status, ok: status >= 200 && status < 300, headers: {}, text: reply } }
    })
    return seen
  }

  test('scores the four dimensions through the local Clef server, with no model call', { options: { mode: 'clef' } }, async ($, on) => {
    const w = world(on, GOOD)
    const seen = clefServer(on, clefReply({ target: 2.6, outcome: 1.2, constraints: 0.4, scope: 1.8 }))
    await scored($, w, 'fix the bug in src/a.ts')

    expect(w.modelCalls).toBe(0)
    expect(seen).toHaveLength(1)
    expect(seen[0]?.url).toBe(CLEF_URL)
    const body = JSON.parse(seen[0]?.body ?? '{}')
    expect(Object.keys(body.questions).sort()).toEqual(['constraints', 'outcome', 'scope', 'target'])
    expect(body.state.prompt).toBe('fix the bug in src/a.ts')
    const out = await spec($)
    expect(out).toContain('spec 50/100 (clef,')
    expect(out).toContain('target 3/3 · outcome 1/3 · constraints 0/3 · scope 2/3')
    expect(out).toContain('gap: not written')
  })

  test('falls back to haiku when the Clef server is unreachable', { options: { mode: 'clef' } }, async ($, on) => {
    const w = world(on, GOOD)
    clefServer(on, new Error('connect ECONNREFUSED'))
    await scored($, w, 'fix the bug in src/a.ts')
    expect(w.modelCalls).toBe(1)
    expect(await spec($)).toContain('(haiku,')
  })

  test('falls back to haiku when the Clef reply is malformed or an error status', { options: { mode: 'clef' } }, async ($, on) => {
    const w = world(on, GOOD)
    clefServer(on, clefReply({ target: 2, outcome: 9, constraints: 1, scope: 1 }))
    await scored($, w, 'fix the bug in src/a.ts')
    expect(w.modelCalls).toBe(1)
    expect(await spec($)).toContain('(haiku,')
  })

  test('falls back to haiku when the Clef server never answers', { options: { mode: 'clef' } }, async ($, on) => {
    const w = world(on, GOOD)
    on('http.fetch', () => new Promise(() => {}))
    await submit($, 'fix the bug in src/a.ts')
    await w.clock.settle()
    await w.clock.advance(10_000)
    expect(w.modelCalls).toBe(1)
    await w.clock.advance(SLOW_MS)
    expect(await spec($)).toContain('(haiku,')
  })

  test('sends the prompt only to this machine, whatever clefUrl says', { options: { mode: 'clef', clefUrl: 'https://example.com/v1/systemone' } }, async ($, on) => {
    const w = world(on, GOOD)
    const seen = clefServer(on, clefReply({ target: 2, outcome: 2, constraints: 2, scope: 2 }))
    await scored($, w, 'fix the bug in src/a.ts')
    expect(seen.map(r => r.url)).toEqual([CLEF_URL])
  })

  test('/spec asks haiku for suggestions without waiting on them', { options: { mode: 'clef' } }, async ($, on) => {
    const w = world(on, GOOD)
    clefServer(on, clefReply({ target: 2.6, outcome: 1.2, constraints: 0.4, scope: 1.8 }))
    await scored($, w, 'fix the bug in src/a.ts')

    // /spec answers with the Clef score at once; haiku runs after it.
    expect(await spec($)).toContain('gap: not written yet')
    expect(w.panes).toEqual(['open specificity'])
    expect(w.modelCalls).toBe(0)
    await w.clock.settle()
    expect(w.modelCalls).toBe(1)
    expect(w.asked[0]).toContain('fix the bug in src/a.ts')
    await w.clock.advance(SLOW_MS)
    const out = await spec($)
    expect(out).toContain('spec 50/100 (clef,')
    expect(out).toContain('gap: which file?')
    // Opening again with suggestions in hand asks nothing more.
    await w.clock.settle()
    expect(w.modelCalls).toBe(1)
  })

  test('pressing the circle opens the panel and fills it with suggestions', { options: { mode: 'clef' } }, async ($, on) => {
    const w = world(on, GOOD)
    clefServer(on, clefReply({ target: 2.6, outcome: 1.2, constraints: 0.4, scope: 1.8 }))
    await scored($, w, 'fix the bug in src/a.ts')
    const footer = await $.ui.mount({ plugin: 'specificity', surface: 'desktop', component: 'SessionMode', props: FOOTER_PROPS })
    await footer.press({ key: 'chip' })
    await footer.unmount()
    await w.clock.settle()
    expect(w.modelCalls).toBe(1)

    const mount = () => $.ui.mount({ plugin: 'specificity', surface: 'desktop', component: 'Pane', requestId: 'specificity', props: PANE_PROPS })
    const waiting = await mount()
    expect(await waiting.find({ key: 'suggesting' })).toBeDefined()
    expect(await waiting.find({ key: 'suggest' })).toBeUndefined()
    await waiting.unmount()
    await w.clock.advance(SLOW_MS)
    const pane = await mount()
    expect((await pane.find({ key: 'note-0' }))?.text).toBe('1. outcome: Say what correct behaviour looks like.')
    expect(await pane.find({ key: 'use' })).toBeDefined()
    await pane.unmount()
  })

  test('opening the panel on a haiku score asks nothing more', { options: { mode: 'clef' } }, async ($, on) => {
    const w = world(on, GOOD)
    clefServer(on, new Error('connect ECONNREFUSED'))
    await scored($, w, 'fix the bug in src/a.ts')
    expect(w.modelCalls).toBe(1)
    await spec($)
    await w.clock.settle()
    expect(w.modelCalls).toBe(1)
  })

  test('a missed answer leaves Get suggestions to try again', { options: { mode: 'clef' } }, async ($, on) => {
    const w = world(on, ['not json', GOOD])
    clefServer(on, clefReply({ target: 2, outcome: 2, constraints: 2, scope: 2 }))
    await scored($, w, 'fix the bug in src/a.ts')
    await spec($)
    await w.clock.settle()
    await w.clock.advance(SLOW_MS)
    const pane = await $.ui.mount({ plugin: 'specificity', surface: 'desktop', component: 'Pane', requestId: 'specificity', props: PANE_PROPS })
    expect(await pane.find({ key: 'suggest' })).toBeDefined()
    await pane.unmount()
  })

  test('a Get suggestions press asks haiku, and its answer joins the Clef score', { options: { mode: 'clef' } }, async ($, on) => {
    const w = world(on, GOOD)
    clefServer(on, clefReply({ target: 2.6, outcome: 1.2, constraints: 0.4, scope: 1.8 }))
    await scored($, w, 'fix the bug in src/a.ts')
    const mount = () => $.ui.mount({ plugin: 'specificity', surface: 'desktop', component: 'Pane', requestId: 'specificity', props: PANE_PROPS })

    const pane = await mount()
    expect(await pane.find({ key: 'use' })).toBeUndefined()
    expect(await pane.find({ key: 'notes' })).toBeUndefined()
    // The press resolves once haiku answers, so the slow model is let run first.
    const pressed = pane.press({ key: 'suggest' })
    await w.clock.settle()
    expect(w.modelCalls).toBe(1)
    expect(w.asked[0]).toContain('fix the bug in src/a.ts')
    expect(await pane.find({ key: 'suggesting' })).toBeDefined()
    await w.clock.advance(SLOW_MS)
    await pressed
    await pane.unmount()

    const after = await mount()
    expect((await after.find({ key: 'note-0' }))?.text).toBe('1. outcome: Say what correct behaviour looks like.')
    expect(await after.find({ key: 'use' })).toBeDefined()
    expect(await after.find({ key: 'suggest' })).toBeUndefined()
    const out = await spec($)
    expect(out).toContain('spec 50/100 (clef,')
    expect(out).toContain('gap: which file?')
  })

  test('suggestions for an older score never land on a newer one', { options: { mode: 'clef' } }, async ($, on) => {
    const w = world(on, GOOD)
    clefServer(on, clefReply({ target: 2, outcome: 2, constraints: 2, scope: 2 }))
    await scored($, w, 'fix the bug in src/a.ts')
    const pane = await $.ui.mount({ plugin: 'specificity', surface: 'desktop', component: 'Pane', requestId: 'specificity', props: PANE_PROPS })
    const pressed = pane.press({ key: 'suggest' })
    await w.clock.settle()
    await w.clock.advance(1)
    await scored($, w, 'and the other one')
    await w.clock.advance(SLOW_MS)
    await pressed
    await pane.unmount()
    expect(await spec($)).not.toContain('which file?')
  })
})

describe('chip', () => {
  test('is one colored circle, no number, on terminal and desktop', async ($, on) => {
    const w = world(on, GOOD)
    await scored($, w, 'fix the bug in src/a.ts')

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'specificity', surface, component: 'SessionMode', props: FOOTER_PROPS })
      const button = await ui.find({ key: 'chip' })
      expect(button?.type).toBe('Button')
      expect(button?.props['label']).toBe('🟢')
      expect((await ui.find({ key: 'specificity' }))?.text).not.toContain('72')
      await ui.unmount()
    }
  })

  test("sits ahead of the footer's mode labels instead of replacing them", async ($, on) => {
    const w = world(on, GOOD)
    await scored($, w, 'fix the bug in src/a.ts')

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'specificity', surface, component: 'SessionMode', props: FOOTER_PROPS })
      expect(await ui.find({ key: 'chip' })).toBeDefined()
      expect(await ui.find({ key: 'engine' })).toBeDefined()
      await ui.unmount()
    }
  })

  test('the circle is red under 40, yellow under 70, green from 70', async ($, on) => {
    const tiers = [[0, '🔴'], [39, '🔴'], [40, '🟡'], [69, '🟡'], [70, '🟢'], [100, '🟢']] as const
    const w = world(on, tiers.map(([score]) => JSON.stringify({ ...JSON.parse(GOOD), score })))
    for (const [score, circle] of tiers) {
      await scored($, w, `prompt scored ${score}`)
      expect(await chip($)).toBe(circle)
    }
  })

  test('from the second score, a sparkline of the scores sits ahead of the chip, red to green', async ($, on) => {
    const scores = [0, 50, 100]
    const w = world(on, scores.map(score => JSON.stringify({ ...JSON.parse(GOOD), score })))
    const bars = async (surface: 'terminal' | 'desktop') => {
      const ui = await $.ui.mount({ plugin: 'specificity', surface, component: 'SessionMode', props: FOOTER_PROPS })
      const found = await sparkBars(ui)
      const chipStill = await ui.find({ key: 'chip' })
      await ui.unmount()
      expect(chipStill).toBeDefined()
      return found
    }

    await scored($, w, 'first prompt')
    expect(await bars('desktop')).toEqual([])

    await scored($, w, 'second prompt')
    await scored($, w, 'third prompt')
    for (const surface of ['terminal', 'desktop'] as const) {
      expect(await bars(surface)).toEqual([
        { glyph: '▁', color: '#c32222' },
        { glyph: '▅', color: '#c3c322' },
        { glyph: '█', color: '#22c322' },
      ])
    }
  })

  test('the sparkline keeps the last 20 scores', async ($, on) => {
    const scores = Array.from({ length: 22 }, (_, i) => i * 4)
    const w = world(on, scores.map(score => JSON.stringify({ ...JSON.parse(GOOD), score })))
    for (const score of scores) await scored($, w, `prompt scored ${score}`)
    const ui = await $.ui.mount({ plugin: 'specificity', surface: 'desktop', component: 'SessionMode', props: FOOTER_PROPS })
    const found = await sparkBars(ui)
    await ui.unmount()
    expect(found).toHaveLength(20)
    // The oldest two of 22 (0 and 4) are gone: the first bar is the score 8.
    expect(found[0]?.glyph).toBe('▂')
    expect(found[0]?.color).not.toBe(found[19]?.color)
  })
})

describe('panel', () => {
  const openPanel = async ($: Engine) => {
    const footer = await $.ui.mount({ plugin: 'specificity', surface: 'desktop', component: 'SessionMode', props: FOOTER_PROPS })
    await footer.press({ key: 'chip' })
    await footer.unmount()
    return $.ui.mount({ plugin: 'specificity', surface: 'desktop', component: 'Pane', requestId: 'specificity', props: PANE_PROPS })
  }

  test('pressing the circle opens the marked-up prompt with suggestions', async ($, on) => {
    const w = world(on, GOOD)
    await scored($, w, 'fix the bug in src/a.ts')

    const pane = await openPanel($)
    expect(w.panes).toEqual(['open specificity'])
    const panel = (await pane.find({ key: 'panel' }))?.text ?? ''
    expect(panel).toContain("Last prompt's specificity: 72/100")
    expect(panel).toContain('target 3/3 · outcome 2/3 · constraints 1/3 · scope 2/3')
    expect(panel).toContain('Why: The file is named')
    expect((await pane.find({ key: 'prompt' }))?.text).toContain('fix the bug[1] in src/a.ts')
    const marked = await pane.find({ type: 'Text', text: /^fix the bug\[1\]$/ })
    expect(marked?.props['color']).toBe('warning')
    expect((await pane.find({ key: 'note-0' }))?.text).toBe('1. outcome: Say what correct behaviour looks like.')
    expect((await pane.find({ key: 'note-1' }))?.text).toBe('2. Missing constraints: Should the public API stay the same?')
    expect((await pane.find({ key: 'improved' }))?.text).toContain('Fix [which bug?] in src/a.ts')
    expect(panel).toContain('Recent ▆')
    await pane.press({ key: 'close' })
    expect(w.panes).toEqual(['open specificity', 'close specificity'])
  })

  test('the sharper prompt goes into the prompt box, never sent, keeping a typed draft', async ($, on) => {
    const w = world(on, GOOD)
    await scored($, w, 'fix the bug in src/a.ts')
    const sent = w.submitted.length

    const pane = await openPanel($)
    await pane.press({ key: 'use' })
    expect(w.draft).toBe('Fix [which bug?] in src/a.ts so that [expected behaviour], keeping the public API unchanged.')
    expect(w.submitted).toHaveLength(sent)
    expect(w.panes.at(-1)).toBe('close specificity')
    await pane.unmount()

    w.draft = 'also check b.ts'
    const again = await openPanel($)
    await again.press({ key: 'use' })
    expect(w.draft).toBe('also check b.ts\n\nFix [which bug?] in src/a.ts so that [expected behaviour], keeping the public API unchanged.')
  })

  test('a quote not in the prompt is shown as a missing piece, never as words the person wrote', async ($, on) => {
    const reply = JSON.stringify({
      ...JSON.parse(GOOD),
      notes: [{ quote: 'refactor the parser', dimension: 'target', suggestion: 'Which parser?' }],
    })
    const w = world(on, reply)
    await scored($, w, 'fix the bug in src/a.ts')

    const pane = await openPanel($)
    expect((await pane.find({ key: 'prompt' }))?.text).toBe('Your promptfix the bug in src/a.ts')
    expect((await pane.find({ key: 'note-0' }))?.text).toBe('1. Missing target: Which parser?')
  })

  test('a reply with no notes or improved prompt still scores, and offers nothing to fill', async ($, on) => {
    const { notes: _n, improved: _i, ...bare } = JSON.parse(GOOD) as Record<string, unknown>
    const w = world(on, JSON.stringify(bare))
    await scored($, w, 'fix the bug in src/a.ts')

    expect(await chip($)).toBe('🟢')
    const pane = await openPanel($)
    expect(await pane.find({ key: 'notes' })).toBeUndefined()
    expect(await pane.find({ key: 'use' })).toBeUndefined()
  })

  test("says when it shows the previous prompt's score", async ($, on) => {
    const w = world(on, [GOOD, 'not json'])
    await scored($, w, 'fix the bug in src/a.ts')
    await scored($, w, 'and the other one')

    const pane = await $.ui.mount({ plugin: 'specificity', surface: 'terminal', component: 'Pane', requestId: 'specificity', props: PANE_PROPS })
    const panel = (await pane.find({ key: 'panel' }))?.text ?? ''
    expect(panel).toContain('The newest prompt has no score; this is the one before it.')
    expect(panel).toContain('fix the bug')
    expect(panel).toContain('in src/a.ts')
  })
})

describe('/spec', () => {
  test('shows the breakdown, opens the panel and toggles the chip', async ($, on) => {
    const w = world(on, GOOD)
    expect(await spec($)).toBe(NONE)
    expect(w.panes).toEqual([])

    await scored($, w, 'fix the bug in src/a.ts')
    const text = await spec($)
    expect(text).toContain('spec 72/100')
    expect(text).toContain('target 3/3 · outcome 2/3 · constraints 1/3 · scope 2/3')
    expect(text).toContain('gap: which file?')
    expect(text).toContain('why: The file is named')
    expect(w.panes).toEqual(['open specificity'])

    await spec($, 'off')
    expect(await chip($)).toBeUndefined()
    await spec($, 'on')
    expect(await chip($)).toBe('🟢')
    await spec($, 'hide')
    expect(w.panes).toEqual(['open specificity', 'close specificity'])
    expect(await chip($)).toBe('🟢')
  })
})
