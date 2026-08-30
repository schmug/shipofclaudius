#!/usr/bin/env node
// M4's analysis CLI (spec §9.1). Offline only — nothing here runs on a session's critical
// path, so unlike bin/fast.mjs it is allowed to be slow and allowed to fail loudly.
//
//   analyze.mjs report                       does the grounding ratio beat log_length_baseline?
//   analyze.mjs sample --n 30 --seed 7       print a hand-check worksheet to STDOUT
//   analyze.mjs check --verdicts <file>      score the heuristic against hand verdicts
//
// Shared flags:
//   --log <file>          default <SPECIFICITY_DIR>/outcomes.jsonl
//   --projects <dir>      default ~/.claude/projects  (where Claude Code writes transcripts)
//
// WHY `sample` PRINTS RATHER THAN WRITES: judging the label needs the prompt text, and
// §9.1 keeps prompt text off disk. Stdout is transient; the verdict file the human writes
// back carries prompt ids and booleans only. Do not add a `--out` that writes the text.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { configDir } from '../src/config.mjs'
import { outcomeLogPath, parseOutcomeLog } from '../src/outcome-log.mjs'
import {
  humanTurns, pairTurns, joinLabels, compare, sampleRows, scoreVerdicts,
  SHORT_TURN_WORDS,
} from '../src/analysis.mjs'

// A transcript is a session's whole history and can be large; this is the one place in
// the package that reads a file whole, and the cap keeps a runaway one from OOMing the
// analysis rather than protecting a latency budget.
const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024

function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) out[a.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true
    else out._.push(a)
  }
  return out
}

function* transcriptFiles(root) {
  let projects
  try { projects = readdirSync(root, { withFileTypes: true }) } catch { return }
  for (const p of projects) {
    if (!p.isDirectory()) continue
    let files
    try { files = readdirSync(join(root, p.name)) } catch { continue }
    for (const f of files) if (f.endsWith('.jsonl')) yield join(root, p.name, f)
  }
}

function collectPairs(root) {
  const pairs = []
  let sessions = 0
  for (const file of transcriptFiles(root)) {
    let text
    try {
      if (statSync(file).size > MAX_TRANSCRIPT_BYTES) continue
      text = readFileSync(file, 'utf8')
    } catch { continue }
    const turns = humanTurns(text)
    if (!turns.length) continue
    sessions++
    pairs.push(...pairTurns(turns))
  }
  return { pairs, sessions }
}

function loadRows(opts) {
  const logPath = typeof opts.log === 'string' ? opts.log : outcomeLogPath(configDir())
  let text
  try { text = readFileSync(logPath, 'utf8') } catch {
    console.error(`no outcome log at ${logPath} — set \`outcome_log = true\` in config.toml and collect some turns first`)
    process.exit(1)
  }
  const { records, malformed } = parseOutcomeLog(text)
  const projects = typeof opts.projects === 'string' ? opts.projects : join(homedir(), '.claude', 'projects')
  const { pairs, sessions } = collectPairs(projects)
  const { rows, unmatched } = joinLabels(records, pairs)
  return { rows, records, malformed, pairs, sessions, unmatched, logPath, projects }
}

const pct = (x) => (x === null || x === undefined ? 'n/a' : `${(x * 100).toFixed(1)}%`)
const dec = (x) => (x === null || x === undefined ? 'n/a' : x.toFixed(3))

function report(opts) {
  const d = loadRows(opts)
  const c = compare(d.rows)
  console.log(`log:         ${d.logPath}  (${d.records.length} records${d.malformed ? `, ${d.malformed} malformed` : ''})`)
  console.log(`transcripts: ${d.projects}  (${d.sessions} sessions, ${d.pairs.length} labelled turn pairs)`)
  console.log(`joined:      ${c.n} rows  (${d.unmatched} log records had no following turn and were dropped)`)
  console.log('')
  console.log(`label:       "needed a follow-up correction" = a next turn of <=${SHORT_TURN_WORDS} words carrying a correction marker`)
  console.log(`positives:   ${c.positives}/${c.n}  (${pct(c.positive_rate)})`)
  console.log(`scorable:    ${c.scorable}/${c.n} rows have a grounding ratio (the rest had no scorable referents)`)
  console.log('')
  console.log('AUC at predicting the label, both oriented so higher = more likely to need a correction:')
  console.log(`  grounding ratio (negated):  ${dec(c.grounding_auc)}`)
  console.log(`  log_length_baseline:        ${dec(c.baseline_auc)}`)
  console.log(`  margin:                     ${dec(c.margin)}`)
  console.log('')
  if (c.grounding_auc === null || c.baseline_auc === null) {
    console.log('VERDICT: not enough data — one of the two label classes is empty, so neither AUC is defined.')
  } else if (c.beats_baseline) {
    console.log('VERDICT: the fast-path grounding ratio BEATS the length baseline on this dataset.')
  } else {
    console.log('VERDICT: the fast-path grounding ratio does NOT beat the length baseline on this dataset.')
  }
  console.log('')
  console.log(`Neither verdict means anything until the label's own error rate is known: run`)
  console.log(`\`analyze.mjs sample\` and then \`analyze.mjs check\`. See packages/specificity/VALIDATION.md.`)
  return 0
}

function sample(opts) {
  const d = loadRows(opts)
  const n = Number.parseInt(opts.n, 10) || 30
  const seed = Number.parseInt(opts.seed, 10) || 1
  const picked = sampleRows(d.rows, n, seed)
  const byId = new Map(d.pairs.map((p) => [p.prompt_id, p]))
  console.log(`# hand-check worksheet — ${picked.length} rows, seed=${seed}`)
  console.log('#')
  console.log('# For each row: read the NEXT TURN and decide whether it is the user correcting')
  console.log('# the previous turn (as opposed to a new instruction, an approval, or a follow-up).')
  console.log('# Then write one JSON object per row into a verdicts file — ids and booleans ONLY,')
  console.log('# never the text — and run: analyze.mjs check --verdicts <file> --seed ' + seed + ' --n ' + n)
  console.log('#')
  for (const r of picked) {
    const p = byId.get(r.prompt_id)
    const next = (p?.next_text || '').replace(/\s+/g, ' ').slice(0, 400)
    console.log('')
    console.log(`--- ${r.prompt_id}`)
    console.log(`heuristic: ${r.label ? 'CORRECTION' : 'no correction'}  (words=${r.detail.words}, markers=[${r.detail.markers.join(',')}])`)
    console.log(`next turn: ${next}`)
    console.log(`verdict:   {"prompt_id":"${r.prompt_id}","correction":true|false}`)
  }
  return 0
}

function check(opts) {
  if (typeof opts.verdicts !== 'string') {
    console.error('check needs --verdicts <file>: one JSON object per line, {"prompt_id":"…","correction":true|false}')
    return 2
  }
  const d = loadRows(opts)
  const n = Number.parseInt(opts.n, 10) || 30
  const seed = Number.parseInt(opts.seed, 10) || 1
  // Re-derived from the same (n, seed), so the rows scored are exactly the rows judged.
  const picked = sampleRows(d.rows, n, seed)
  const verdicts = []
  for (const line of readFileSync(opts.verdicts, 'utf8').split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    try { verdicts.push(JSON.parse(t)) } catch { /* a stray line in a hand-edited file */ }
  }
  const s = scoreVerdicts(picked, verdicts)
  console.log(`hand-checked: ${s.n} of ${picked.length} sampled rows (seed=${seed}, n=${n})`)
  if (s.checked_missing) console.log(`  ${s.checked_missing} sampled rows had no verdict and were skipped`)
  console.log('')
  console.log(`  heuristic CORRECTION, actually a correction:   ${s.true_positive}`)
  console.log(`  heuristic CORRECTION, actually not:            ${s.false_positive}`)
  console.log(`  heuristic no-correction, actually a correction:${s.false_negative}`)
  console.log(`  heuristic no-correction, actually not:         ${s.true_negative}`)
  console.log('')
  console.log(`LABEL ERROR RATE: ${pct(s.error_rate)}  (95% Wilson CI ${pct(s.error_rate_ci?.low)} – ${pct(s.error_rate_ci?.high)})`)
  console.log(`  precision ${dec(s.precision)}   recall ${dec(s.recall)}`)
  console.log('')
  console.log('Note that the sample is STRATIFIED — half from each predicted class — so precision')
  console.log('and recall here are computed on a re-balanced sample and are not the rates you would')
  console.log('see on the raw stream. The error rate is what M4 needs: it bounds how much of a weak')
  console.log('correlation is the score failing versus the label never having measured corrections.')
  return 0
}

const opts = parseArgs(process.argv.slice(2))
const cmd = opts._[0] || 'report'
const commands = { report, sample, check }
if (!commands[cmd]) {
  console.error(`unknown command "${cmd}" — expected report | sample | check`)
  process.exit(2)
}
process.exitCode = commands[cmd](opts) || 0
