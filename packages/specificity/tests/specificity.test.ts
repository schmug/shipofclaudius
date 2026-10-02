import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { ModelCompleteResult, ModelForkResult, On, PromptOrigin, SessionMessage } from 'claude-code'

const GOOD = JSON.stringify({
  score: 72,
  dimensions: { target: 3, outcome: 2, constraints: 1, scope: 2 },
  gap: 'which file?',
  rationale: 'The file is named but done-criteria are loose.',
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
  const w: World = { clock: mock.clock(on), submitted: [], modelCalls: 0, toasts: [], statuses: [], messages: [], asked: [], forks: 0, afterFork: null, commandsFail: false, commandsHeld: null }
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
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('command.list', async () => {
    await w.commandsHeld
    if (w.commandsFail) throw new Error('command lookup failed')
    return { value: [{ name: 'compact', description: 'Compact', source: 'builtin' as const }] }
  })
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Box', props: { key: 'engine' }, children: [] }))
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

const BAND_PROPS = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 6,
  bodyColumns: 80,
  scroll: { offset: 0, bodyRows: 5 },
  view: {},
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
    expect(w.statuses.at(-1)).toBe('spec 72')
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

  test('a malformed reply produces no band and no toast', async ($, on) => {
    const w = world(on, 'Sure! The prompt is fairly specific, maybe 70.')
    await scored($, w, 'fix the bug')

    expect(w.modelCalls).toBe(1)
    expect(await spec($)).toBe(NONE)
    expect(w.toasts).toEqual([])
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'specificity', surface, component: 'AbovePrompt', props: BAND_PROPS })
      expect(await ui.find({ key: 'spec' })).toBeUndefined()
      await ui.unmount()
    }
  })

  test('mode off makes no model calls and draws no band', { options: { mode: 'off' } }, async ($, on) => {
    const w = world(on, GOOD)
    await scored($, w, 'fix the bug in src/a.ts')

    expect(w.submitted).toEqual(['fix the bug in src/a.ts'])
    expect(w.modelCalls).toBe(0)
    const ui = await $.ui.mount({ plugin: 'specificity', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
    expect(await ui.find({ key: 'spec' })).toBeUndefined()
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
    expect(w.statuses.filter(s => s !== undefined)).toEqual([])
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
    expect(w.statuses.filter(s => s !== undefined)).toEqual([])
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
    expect(w.statuses.at(-1)).toBeUndefined()
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
    expect(w.statuses.at(-1)).toBeUndefined()
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
    expect(w.statuses.at(-1)).toBeUndefined()
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
    expect(w.statuses.at(-1)).toBe('spec 72')
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
    expect(w.statuses.at(-1)).toBe('spec 72')
  })

  test('exiting after the newest score landed still republishes it on restart', async ($, on) => {
    const w = world(on, GOOD)
    on('session.end', ($, e) => ({ sessionId: e.sessionId }))
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    await scored($, w, 'fix the bug in src/a.ts')
    await $.session.end({ reason: 'prompt_input_exit', sessionId: 'old', resume: { id: 'old' } })
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    expect(w.statuses.at(-1)).toBe('spec 72')
  })

  test('a failed judge for the newest prompt hides the previous score', async ($, on) => {
    const w = world(on, [GOOD, 'not json'])
    await scored($, w, 'fix the bug in src/a.ts')
    expect(w.statuses.at(-1)).toBe('spec 72')
    await scored($, w, 'and the other one')
    expect(w.modelCalls).toBe(2)
    expect(w.statuses.at(-1)).toBeUndefined()
    expect(w.toasts).toEqual([])
    const ui = await $.ui.mount({ plugin: 'specificity', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
    expect(await ui.find({ key: 'spec' })).toBeUndefined()
    expect(await spec($)).toContain('for "fix the bug in src/a.ts"')
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
    expect(w.statuses.at(-1)).toBeUndefined()
  })

  test('a restart republishes a visible score', async ($, on) => {
    const w = world(on, GOOD)
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    await scored($, w, 'fix the bug in src/a.ts')
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    expect(w.statuses.at(-1)).toBe('spec 72')
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
    expect(w.statuses.filter(s => s !== undefined)).toEqual([])
  })
})

describe('band', () => {
  test('renders on terminal and desktop, hides under a survey', async ($, on) => {
    const w = world(on, GOOD)
    await scored($, w, 'fix the bug in src/a.ts')

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'specificity', surface, component: 'AbovePrompt', props: BAND_PROPS })
      expect((await ui.find({ key: 'text' }))?.text).toBe('spec 72 · gap: which file?')
      expect((await ui.find({ key: 'spark' }))?.text).toBe('▆')
      expect(await ui.find({ key: 'hide' })).toBeDefined()
      await ui.unmount()

      const survey = await $.ui.mount({
        plugin: 'specificity',
        surface,
        component: 'AbovePrompt',
        props: { ...BAND_PROPS, hasSurvey: true },
      })
      expect(await survey.find({ key: 'spec' })).toBeUndefined()
      await survey.unmount()
    }
  })

  test("stacks on top of another mod's band instead of replacing it", async ($, on) => {
    const w = world(on, GOOD)
    await scored($, w, 'fix the bug in src/a.ts')

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'specificity', surface, component: 'AbovePrompt', props: BAND_PROPS })
      expect(await ui.find({ key: 'spec' })).toBeDefined()
      expect(await ui.find({ key: 'engine' })).toBeDefined()
      await ui.unmount()
    }
  })

  test('drops the sparkline at narrow widths and Hide hides it', async ($, on) => {
    const w = world(on, GOOD)
    await scored($, w, 'fix the bug in src/a.ts')

    const ui = await $.ui.mount({
      plugin: 'specificity',
      surface: 'terminal',
      component: 'AbovePrompt',
      props: { ...BAND_PROPS, bodyColumns: 24 },
    })
    expect(await ui.find({ key: 'text' })).toBeDefined()
    expect(await ui.find({ key: 'spark' })).toBeUndefined()
    await ui.press({ key: 'hide' })
    expect(await ui.find({ key: 'spec' })).toBeUndefined()

    await scored($, w, 'now the same in src/b.ts')
    expect(await ui.find({ key: 'spec' })).toBeDefined()
  })
})

describe('/spec', () => {
  test('shows the breakdown and toggles the band', async ($, on) => {
    const w = world(on, GOOD)
    expect(await spec($)).toBe(NONE)

    await scored($, w, 'fix the bug in src/a.ts')
    const text = await spec($)
    expect(text).toContain('spec 72/100')
    expect(text).toContain('target 3/3 · outcome 2/3 · constraints 1/3 · scope 2/3')
    expect(text).toContain('gap: which file?')
    expect(text).toContain('why: The file is named')

    const ui = await $.ui.mount({ plugin: 'specificity', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
    await spec($, 'off')
    expect(await ui.find({ key: 'spec' })).toBeUndefined()
    await spec($, 'on')
    expect(await ui.find({ key: 'spec' })).toBeDefined()
    await spec($, 'hide')
    expect(await ui.find({ key: 'spec' })).toBeUndefined()
  })
})
