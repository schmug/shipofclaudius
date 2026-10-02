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
// dropped rather than overwrite a newer result. Module-local on purpose; a
// reload starting the count over can only drop a stale score, never misfile one.
let latest = 0

function debug($: EngineInterface, line: string): void {
  $.ui.log(`specificity: ${line}`, { to: 'debug' })
}

async function score($: EngineInterface, prompt: string, seq: number, mode: 'haiku' | 'fork', contextMessages: number): Promise<void> {
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
    $.ui.log(`specificity: no score (${reply.reason}${reply.reason === 'api-error' ? ` ${reply.status ?? '-'} ${reply.error}` : ''})`, { to: 'debug' })
    return
  }
  const judged = parseJudgement(reply.text)
  if (judged === null) {
    $.ui.log(`specificity: no score (unparseable reply, ${reply.text.length} chars)`, { to: 'debug' })
    return
  }
  if (seq !== latest) {
    $.ui.log('specificity: score dropped, a newer prompt is being scored', { to: 'debug' })
    return
  }

  const now = await $.clock.now()
  const result: SpecificityResult = { ...judged, mode: judge, excerpt: excerpt(prompt), at: now, ms: now - startedAt }
  await update($, last, () => result)
  await update($, history, list => [...list, result.score].slice(-HISTORY_CAP))
  await update($, isHidden, () => false)
  $.ui.status(`spec ${result.score}`)
}

export const register: Register = (on, options) => {
  const mode = readMode(options['mode'])
  const contextMessages = readCount(options['contextMessages'], 8, 40)

  on('session.start', async ($, e, next) => {
    latest += 1
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
    latest += 1
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
      const seq = ++latest
      $.clock.after(0, () => {
        score($, prompt, seq, judge, contextMessages).catch((err: unknown) =>
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
