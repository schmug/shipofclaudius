// The specificity mod: scores each prompt the person submits for how specific it
// is given the session so far, and shows the score as a chip beside the model
// in the prompt footer; the chip opens a panel with the breakdown, as does /spec.
//
// THE INVARIANT: the prompt is never blocked, delayed, rewritten or dropped. The
// `prompt.submit` hook passes `e` to `next` untouched and returns its result; the
// scoring runs from a `$.clock.after(0)` timer, so it is not part of the prompt's
// dispatch (whose abandonment would abort its model call) and nothing waits on it.
// Every non-answer is logged to the debug log alone: no toast, no chip.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { SpecificityResult } from '../types'
import {
  breakdown,
  buildContext,
  CLEF_URL,
  clefRequest,
  completePrompt,
  excerpt,
  footerSpark,
  forkPrompt,
  chip,
  HISTORY_CAP,
  isAnswerUnderway,
  isLoopback,
  isUserPrompt,
  markup,
  noteLine,
  panelLines,
  slashName,
  parseClef,
  parseJudgement,
  readCount,
  readMode,
  RUBRIC,
  sparkline,
  withSuggestions,
} from './judge'

const last = atom({ plugin: 'specificity', key: 'last' } as const, null)
const history = atom({ plugin: 'specificity', key: 'history' } as const, [])
const isHidden = atom({ plugin: 'specificity', key: 'isHidden' } as const, false)
const isChipOff = atom({ plugin: 'specificity', key: 'isChipOff' } as const, false)
const isSuggesting = atom({ plugin: 'specificity', key: 'isSuggesting' } as const, false)

const PANE = 'specificity'

const HAIKU_TIMEOUT_MS = 15_000
// A Clef server that accepts the request but never answers must not hold the
// score forever: past this, haiku judges instead.
const CLEF_TIMEOUT_MS = 10_000

// Only the newest prompt's score may land: a slow judge for an older prompt is
// dropped rather than overwrite a newer result. `submitted` orders submissions;
// `latest` is the newest submission known to be a prompt (a `/name` candidate
// joins only once it is known not to be a real command, so a command never
// supersedes anything); `epoch` moves at session start and end, dropping every
// judge in flight; `finished` is the newest confirmed prompt whose judge reached
// an outcome (a score or a non-answer; a command is never counted, so it can't
// mask a prompt still being judged); `candidates` are `/name` prompts not yet
// classified. Module-local on
// purpose; a reload starting the counts over can only drop a stale score, never
// misfile one.
let submitted = 0
let latest = 0
let epoch = 0
let finished = 0
const candidates = new Set<number>()

/** `order` is a prompt, not a command: it supersedes every older one, never a newer one. */
function confirm(order: number): void {
  latest = Math.max(latest, order)
}

function debug($: EngineInterface, line: string): void {
  $.ui.log(`specificity: ${line}`, { to: 'debug' })
}

/**
 * Opens the breakdown panel; the chip's press and `/spec` are both the person
 * asking. A Clef score has no words yet, so opening it asks Haiku for them on a
 * timer of its own: the panel opens at once and fills in when Haiku answers.
 */
async function openPanel($: EngineInterface, contextMessages: number): Promise<void> {
  await $.ui.open({ id: PANE, title: 'Specificity' })
  const current = await read($, last)
  if (current !== null && current.mode === 'clef' && current.notes.length === 0 && current.improved === null) {
    $.clock.after(0, () => {
      suggest($, contextMessages).catch((err: unknown) => debug($, `no suggestions (${err instanceof Error ? err.name : 'error'})`))
    })
  }
}

async function closePanel($: EngineInterface): Promise<void> {
  await $.ui.close({ id: PANE })
}

/**
 * Puts the judge's sharper prompt in the prompt box for the person to edit and
 * send. It never sends anything: the scored prompt has long since gone, and the
 * next one is the person's to submit. A draft already typed is kept, with the
 * suggestion added after it.
 */
async function fillImproved($: EngineInterface): Promise<void> {
  const current = await read($, last)
  if (current === null || current.improved === null) return
  const { text } = await $.prompt.read()
  const filled = await $.prompt.fill(
    text.trim() === '' ? { text: current.improved, mode: 'replace' } : { text: `\n\n${current.improved}`, mode: 'append' },
  )
  if (filled.isFilled) await closePanel($)
}

/**
 * mode clef scores without words: when the person opens the panel (or presses
 * Get suggestions after a miss), the haiku judge reads the scored prompt in its
 * context and writes the gap, suggestions and sharper prompt, which join the
 * Clef score in the panel. One call at a time; a newer score landing meanwhile
 * drops the answer.
 */
async function suggest($: EngineInterface, contextMessages: number): Promise<void> {
  const current = await read($, last)
  if (current === null || current.mode !== 'clef' || (await read($, isSuggesting))) return
  await update($, isSuggesting, () => true)
  try {
    const messages = await $.session.messages()
    const reply = await $.model.complete({
      model: 'haiku',
      system: RUBRIC,
      prompt: completePrompt(buildContext(messages, current.prompt, contextMessages), current.prompt),
      maxTokens: 1000,
      effort: 'low',
      timeoutMs: HAIKU_TIMEOUT_MS,
    })
    const judged = reply.isAnswered ? parseJudgement(reply.text, current.prompt) : null
    if (judged === null) {
      debug($, `no suggestions (${reply.isAnswered ? 'unparseable reply' : reply.reason})`)
      return
    }
    await update($, last, now => (now !== null && now.at === current.at ? withSuggestions(now, judged) : now))
  } finally {
    await update($, isSuggesting, () => false)
  }
}

/**
 * The newest prompt got no score: hide the chip so it doesn't show the previous
 * prompt's score as if it were this one's. `last` and `history` keep the
 * previous result, which the panel and `/spec` name by its excerpt.
 */
async function quiet($: EngineInterface, isStale: () => boolean, why: string): Promise<void> {
  $.ui.log(`specificity: no score (${why})`, { to: 'debug' })
  if (isStale()) return
  await update($, isHidden, hidden => (isStale() ? hidden : true))
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
  mode: 'haiku' | 'fork' | 'clef',
  contextMessages: number,
  clefUrl: string,
): Promise<void> {
  // Superseded by a newer prompt, or by a /clear, resume or exit. A `/name`
  // candidate not yet confirmed is not stale on that account alone.
  const isStale = () => latest > order || born !== epoch
  try {
    await judgeAndWrite($, prompt, order, isStale, mode, contextMessages, clefUrl)
  } catch (err: unknown) {
    await quiet($, isStale, err instanceof Error ? err.name : 'error')
  } finally {
    candidates.delete(order)
    if (order <= latest) finished = Math.max(finished, order)
  }
}

async function judgeAndWrite(
  $: EngineInterface,
  prompt: string,
  order: number,
  isStale: () => boolean,
  mode: 'haiku' | 'fork' | 'clef',
  contextMessages: number,
  clefUrl: string,
): Promise<void> {
  const name = slashName(prompt)
  if (name !== null) {
    // A lookup that fails is read as "not a command": the prompt is judged and
    // supersedes the previous score, so a failed lookup never leaves that
    // score standing as if it were this prompt's.
    const commands = await $.command.list().catch(() => [])
    if (commands.some(c => c.name === name)) return
    confirm(order)
  }

  const startedAt = await $.clock.now()
  let judge = mode
  let reply: Awaited<ReturnType<typeof $.model.fork>> | null = null
  let judged: ReturnType<typeof parseJudgement> = null
  // Clef answers only when its local server is up; anything else (refused,
  // an error status, a malformed reply) falls through to the haiku judge.
  if (mode === 'clef' && !isStale()) {
    const messages = await $.session.messages()
    try {
      const res = await Promise.race([
        $.http.fetch(clefUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: clefRequest(buildContext(messages, prompt, contextMessages), prompt),
        }),
        $.clock.sleep(CLEF_TIMEOUT_MS).then(() => null),
      ])
      judged = res !== null && res.ok ? parseClef(res.text, prompt) : null
      if (judged === null) debug($, `clef reply unusable (${res === null ? 'timed out' : `status ${res.status}`}); judging with haiku`)
    } catch (err: unknown) {
      $.ui.log(`specificity: clef unreachable (${err instanceof Error ? err.name : 'error'}); judging with haiku`, { to: 'debug' })
    }
  }
  // The fork is the transcript as the main thread last sent it, so once Claude's
  // answer to this prompt has started it may carry that answer. Checked before
  // forking and again once the fork answers: if the answer may be in it, the
  // fork's score is dropped and the haiku judge, whose context is cut at the
  // prompt, rates it instead.
  if (judged === null && mode === 'fork' && !isAnswerUnderway(await $.session.messages(), prompt) && !isStale()) {
    reply = await $.model.fork({ prompt: forkPrompt(prompt) })
    if (reply.isAnswered && isAnswerUnderway(await $.session.messages(), prompt)) {
      $.ui.log('specificity: fork dropped, the answer may be in it; judging with haiku', { to: 'debug' })
      reply = null
    }
  }
  // A session's first prompt has no response to fork yet (and none right after
  // /clear); the context is empty then anyway, so the cheap judge stands in.
  if (judged === null && (reply === null || (!reply.isAnswered && reply.reason === 'nothing-to-fork'))) {
    judge = 'haiku'
    const messages = await $.session.messages()
    // Checked before each model call, not only after: a judge already
    // superseded (a newer prompt, a /clear) would pay for an answer certain
    // to be dropped.
    if (isStale()) return
    reply = await $.model.complete({
      model: 'haiku',
      system: RUBRIC,
      prompt: completePrompt(buildContext(messages, prompt, contextMessages), prompt),
      maxTokens: 1000,
      effort: 'low',
      timeoutMs: HAIKU_TIMEOUT_MS,
    })
  }

  if (judged === null) {
    if (reply === null) return
    if (!reply.isAnswered) {
      await quiet($, isStale, `${reply.reason}${reply.reason === 'api-error' ? ` ${reply.status ?? '-'} ${reply.error}` : ''}`)
      return
    }
    judged = parseJudgement(reply.text, prompt)
    if (judged === null) {
      await quiet($, isStale, `unparseable reply, ${reply.text.length} chars`)
      return
    }
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
}

export const register: Register = (on, options) => {
  const mode = readMode(options['mode'])
  const contextMessages = readCount(options['contextMessages'], 8, 40)
  const clefSetting = typeof options['clefUrl'] === 'string' ? options['clefUrl'].trim() : ''
  // The prompt goes to clefUrl, so only this machine may receive it.
  const clefUrl = isLoopback(clefSetting) ? clefSetting : CLEF_URL

  on('session.start', async ($, e, next) => {
    epoch += 1
    if (mode === 'clef' && clefSetting !== '' && clefUrl !== clefSetting) debug($, `clefUrl is not on this machine; using ${CLEF_URL}`)
    await $.command.register({
      name: 'spec',
      description: 'Show the last prompt specificity breakdown, turn its chip on or off, or hide its panel',
      argumentHint: '[on|off|hide]',
      immediate: true,
    })
    return next(e)
  })

  // A /clear ends the conversation with no session.start after it, and a resume
  // swaps it: a judge still running for the old conversation must not land in
  // the new one, so every outstanding sequence number is invalidated here.
  on('session.end', async ($, e, next) => {
    epoch += 1
    // Only a candidate newer than every confirmed prompt could be the newest
    // prompt; older ones are superseded. All of them end with this epoch.
    const isCandidatePending = [...candidates].some(order => order > latest)
    candidates.clear()
    if (e.reason === 'clear' || e.reason === 'resume') {
      await update($, last, () => null)
      await update($, history, () => [])
    } else if (latest > finished || isCandidatePending) {
      // The newest prompt's judge is cut off here and will never land: hide
      // the chip so a reopened conversation doesn't show the older score as
      // if it were this prompt's. A finished score still comes back.
      await update($, isHidden, () => true)
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
      else candidates.add(order)
      $.clock.after(0, () => {
        score($, prompt, order, born, judge, contextMessages, clefUrl).catch((err: unknown) =>
          debug($, `no score (${err instanceof Error ? err.name : 'error'})`),
        )
      })
    }
    return next(e)
  })

  on('command.run', { command: 'spec' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'on') {
      // isHidden is not cleared: it means the newest prompt has no score, and
      // only a new score may lift it, or an older one would pose as the latest.
      await update($, isChipOff, () => false)
      return { text: mode === 'off' ? 'Chip on, but the scorer is off (mode: off).' : 'Specificity chip on.' }
    }
    if (arg === 'off') {
      await update($, isChipOff, () => true)
      return { text: 'Specificity chip off. /spec on brings it back.' }
    }
    if (arg === 'hide') {
      await closePanel($)
      return { text: 'Specificity panel closed. The chip or /spec opens it.' }
    }
    if (arg !== '') return { text: 'Usage: /spec [on|off|hide]' }
    const current = await read($, last)
    if (mode !== 'off' && current !== null) await openPanel($, contextMessages)
    return { text: breakdown(current, mode) }
  })

  // The chip: one colored circle, a button that opens the panel. It sits in
  // the footer beside the model, ahead of the mode labels the hooks beneath
  // draw, never in place of them. The footer draws text only (no tooltip), so
  // the press is the way in. Ahead of the chip, from the first score,
  // a sparkline of the session's recent scores: a thin line of Braille dots,
  // two scores per cell, each cell colored on a red-to-green gradient. The
  // footer drew no Svg in a desktop test, so the line is colored Text.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    if (mode === 'off') return next(e)
    const current = await read($, last)
    if (current === null || (await read($, isChipOff)) || (await read($, isHidden))) return next(e)

    const { Box, Text, Button } = $.ui.resolve(e)
    const spark = footerSpark(await read($, history))
    const below = await next(e)
    return (
      <Box key="specificity" flexDirection="row" columnGap={1}>
        {spark.length > 0 && (
          <Box key="spark" flexDirection="row">
            {spark.map((b, i) => (
              <Text key={String(i)} color={b.color}>
                {b.glyph}
              </Text>
            ))}
          </Box>
        )}
        <Button key="chip" label={chip(current.score)} plain onPress={() => openPanel($, contextMessages)} />
        {below}
      </Box>
    )
  })

  // The panel: the score, the prompt marked up where it could be sharper with
  // a numbered suggestion per piece (and questions for what it leaves out), and
  // the judge's sharper prompt with a button that puts it in the prompt box.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const current = await read($, last)
    if (mode === 'off' || current === null) {
      return (
        <Box key="panel" flexDirection="column">
          <Text wrap="wrap">{breakdown(current, mode)}</Text>
          <Button key="close" label="Close" role="dismiss" onPress={() => closePanel($)} />
        </Box>
      )
    }
    const spark = sparkline(await read($, history))
    const header = panelLines(current, await read($, isHidden))
    return (
      <Box key="panel" flexDirection="column" rowGap={1}>
        <Box key="header" flexDirection="column">
          {header.map((line, i) => (
            <Box key={`header-${i}`}>
              <Text wrap="wrap" dimColor={i > 0 && !line.startsWith('The newest')}>
                {line}
              </Text>
            </Box>
          ))}
        </Box>
        <Box key="prompt" flexDirection="column">
          <Text bold>Your prompt</Text>
          <Text wrap="wrap">
            {markup(current.prompt, current.notes).map(run =>
              run.note === null ? (
                run.text
              ) : (
                <Text color="warning" underline>{`${run.text}[${run.note}]`}</Text>
              ),
            )}
          </Text>
        </Box>
        {current.notes.length > 0 && (
          <Box key="notes" flexDirection="column">
            <Text bold>Suggestions</Text>
            {current.notes.map((note, i) => (
              <Box key={`note-${i}`}>
                <Text wrap="wrap">{noteLine(note, i)}</Text>
              </Box>
            ))}
          </Box>
        )}
        {current.improved !== null && (
          <Box key="improved" flexDirection="column">
            <Text bold>A sharper prompt</Text>
            <Text wrap="wrap">{current.improved}</Text>
          </Box>
        )}
        {spark !== '' && (
          <Box key="spark">
            <Text dimColor>{`Recent ${spark}`}</Text>
          </Box>
        )}
        <Box key="actions" flexDirection="row" columnGap={1}>
          {current.mode === 'clef' && current.notes.length === 0 && current.improved === null && (
            (await read($, isSuggesting)) ? (
              <Box key="suggesting">
                <Text dimColor>Asking Haiku for suggestions…</Text>
              </Box>
            ) : (
              <Button key="suggest" label="Get suggestions" variant="primary" onPress={() => suggest($, contextMessages)} />
            )
          )}
          {current.improved !== null && (
            <Button key="use" label="Put in prompt box" variant="primary" onPress={() => fillImproved($)} />
          )}
          <Button key="close" label="Close" role="dismiss" onPress={() => closePanel($)} />
        </Box>
      </Box>
    )
  })
}
