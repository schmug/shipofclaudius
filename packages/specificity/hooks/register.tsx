// The specificity mod: scores each prompt the person submits for how specific it
// is given the session so far, and shows the score above the prompt, in the
// status line and under /spec.
//
// THE INVARIANT: the prompt is never blocked, delayed, rewritten or dropped. The
// `prompt.submit` hook passes `e` to `next` untouched and returns its result; the
// scoring runs from a `$.clock.after(0)` timer, so it is not part of the prompt's
// dispatch (whose abandonment would abort its model call) and nothing waits on it.
// Every non-answer is logged to the debug log alone: no toast, no band.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { SpecificityResult } from '../types'
import {
  bandText,
  breakdown,
  buildContext,
  completePrompt,
  excerpt,
  forkPrompt,
  HISTORY_CAP,
  isUserPrompt,
  slashName,
  parseJudgement,
  readCount,
  readMode,
  RUBRIC,
  sparkline,
} from './judge'

const last = atom({ plugin: 'specificity', key: 'last' } as const, null)
const history = atom({ plugin: 'specificity', key: 'history' } as const, [])
const isHidden = atom({ plugin: 'specificity', key: 'isHidden' } as const, false)
const isBandOff = atom({ plugin: 'specificity', key: 'isBandOff' } as const, false)

const HAIKU_TIMEOUT_MS = 15_000
const SPARK_MIN_COLUMNS = 40

// Only the newest prompt's score may land: a slow judge for an older prompt is
// dropped rather than overwrite a newer result. `submitted` orders submissions;
// `latest` is the newest submission known to be a prompt (a `/name` candidate
// joins only once it is known not to be a real command, so a command never
// supersedes anything); `epoch` moves at session start and end, dropping every
// judge in flight. Module-local on purpose; a reload starting the counts over
// can only drop a stale score, never misfile one.
let submitted = 0
let latest = 0
let epoch = 0

/** `order` is a prompt, not a command: it supersedes every older one, never a newer one. */
function confirm(order: number): void {
  latest = Math.max(latest, order)
}

function debug($: EngineInterface, line: string): void {
  $.ui.log(`specificity: ${line}`, { to: 'debug' })
}

/**
 * The newest prompt got no score: hide the band and clear the status line so
 * neither shows the previous prompt's score as if it were this one's. `last`
 * and `history` keep the previous result, which `/spec` names by its excerpt.
 */
async function quiet($: EngineInterface, isStale: () => boolean, why: string): Promise<void> {
  $.ui.log(`specificity: no score (${why})`, { to: 'debug' })
  if (isStale()) return
  await update($, isHidden, hidden => (isStale() ? hidden : true))
  if (!isStale()) $.ui.status(undefined)
}

/**
 * Judges one prompt and, if it is still the newest when the answer lands, writes
 * the result. `order` and `born` (the session epoch) were taken at submission,
 * so a /clear between submission and the timer firing still drops it. A prompt
 * that looks like a slash command is checked against the session's real
 * commands first: `/compact` is dropped without superseding anything,
 * `/tmp is full` is confirmed and judged.
 */
async function score(
  $: EngineInterface,
  prompt: string,
  order: number,
  born: number,
  mode: 'haiku' | 'fork',
  contextMessages: number,
): Promise<void> {
  const isStale = () => order !== latest || born !== epoch
  try {
    await judgeAndWrite($, prompt, order, isStale, mode, contextMessages)
  } catch (err: unknown) {
    await quiet($, isStale, err instanceof Error ? err.name : 'error')
  }
}

async function judgeAndWrite(
  $: EngineInterface,
  prompt: string,
  order: number,
  isStale: () => boolean,
  mode: 'haiku' | 'fork',
  contextMessages: number,
): Promise<void> {
  const name = slashName(prompt)
  if (name !== null) {
    if ((await $.command.list()).some(c => c.name === name)) return
    confirm(order)
  }

  const startedAt = await $.clock.now()
  let judge = mode
  let reply = mode === 'fork' ? await $.model.fork({ prompt: forkPrompt(prompt) }) : null
  // A session's first prompt has no response to fork yet (and none right after
  // /clear); the context is empty then anyway, so the cheap judge stands in.
  if (reply === null || (!reply.isAnswered && reply.reason === 'nothing-to-fork')) {
    judge = 'haiku'
    const messages = await $.session.messages()
    reply = await $.model.complete({
      model: 'haiku',
      system: RUBRIC,
      prompt: completePrompt(buildContext(messages, prompt, contextMessages), prompt),
      maxTokens: 400,
      effort: 'low',
      timeoutMs: HAIKU_TIMEOUT_MS,
    })
  }

  if (!reply.isAnswered) {
    await quiet($, isStale, `${reply.reason}${reply.reason === 'api-error' ? ` ${reply.status ?? '-'} ${reply.error}` : ''}`)
    return
  }
  const judged = parseJudgement(reply.text)
  if (judged === null) {
    await quiet($, isStale, `unparseable reply, ${reply.text.length} chars`)
    return
  }

  const now = await $.clock.now()
  const result: SpecificityResult = { ...judged, mode: judge, excerpt: excerpt(prompt), at: now, ms: now - startedAt }
  // The staleness check runs inside each write's updater: `update` re-runs it
  // after any concurrent write (a /clear's reset, a newer score), so a newer
  // prompt or a /clear that lands mid-way stops every remaining write.
  if (isStale()) {
    $.ui.log('specificity: score dropped, a newer prompt or /clear superseded it', { to: 'debug' })
    return
  }
  await update($, last, current => (isStale() ? current : result))
  await update($, history, list => (isStale() ? list : [...list, result.score].slice(-HISTORY_CAP)))
  await update($, isHidden, hidden => (isStale() ? hidden : false))
  if (!isStale()) $.ui.status(`spec ${result.score}`)
}

export const register: Register = (on, options) => {
  const mode = readMode(options['mode'])
  const contextMessages = readCount(options['contextMessages'], 8, 40)

  on('session.start', async ($, e, next) => {
    epoch += 1
    await $.command.register({
      name: 'spec',
      description: 'Show the last prompt specificity score, or turn its band on, off or hide it',
      argumentHint: '[on|off|hide]',
      immediate: true,
    })
    const current = await read($, last)
    $.ui.status(mode === 'off' || current === null ? undefined : `spec ${current.score}`)
    return next(e)
  })

  // A /clear ends the conversation with no session.start after it, and a resume
  // swaps it: a judge still running for the old conversation must not land in
  // the new one, so every outstanding sequence number is invalidated here.
  on('session.end', async ($, e, next) => {
    epoch += 1
    if (e.reason === 'clear' || e.reason === 'resume') {
      await update($, last, () => null)
      await update($, history, () => [])
      $.ui.status(undefined)
    }
    return next(e)
  })

  on('prompt.submit', ($, e, next) => {
    if (mode !== 'off' && isUserPrompt(e.origin, e.text)) {
      const prompt = e.text
      const judge = mode
      const order = ++submitted
      const born = epoch
      if (slashName(prompt) === null) confirm(order)
      $.clock.after(0, () => {
        score($, prompt, order, born, judge, contextMessages).catch((err: unknown) =>
          debug($, `no score (${err instanceof Error ? err.name : 'error'})`),
        )
      })
    }
    return next(e)
  })

  on('command.run', { command: 'spec' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'on') {
      await update($, isBandOff, () => false)
      await update($, isHidden, () => false)
      return { text: mode === 'off' ? 'Band on, but the scorer is off (mode: off).' : 'Specificity band on.' }
    }
    if (arg === 'off') {
      await update($, isBandOff, () => true)
      return { text: 'Specificity band off. /spec on brings it back.' }
    }
    if (arg === 'hide') {
      await update($, isHidden, () => true)
      return { text: 'Specificity band hidden until the next score.' }
    }
    if (arg !== '') return { text: 'Usage: /spec [on|off|hide]' }
    return { text: breakdown(await read($, last), mode) }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (mode === 'off' || e.props.hasSurvey) return next(e)
    const current = await read($, last)
    if (current === null || (await read($, isBandOff)) || (await read($, isHidden))) return next(e)

    const { Box, Text, Button } = $.ui.resolve(e)
    const spark = e.props.bodyColumns >= SPARK_MIN_COLUMNS ? sparkline(await read($, history)) : ''

    return (
      <Box key="spec" flexDirection="row" columnGap={1}>
        <Box key="text" flexShrink={1}>
          <Text dimColor wrap="truncate-end">
            {bandText(current)}
          </Text>
        </Box>
        {spark !== '' && (
          <Box key="spark" flexShrink={0}>
            <Text dimColor>{spark}</Text>
          </Box>
        )}
        <Button key="hide" label="Hide" plain dimColor onPress={() => update($, isHidden, () => true)} />
      </Box>
    )
  })
}
