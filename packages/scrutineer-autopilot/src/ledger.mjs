// Ledger, tick lock, paused flag and run log (spec §6/§10). Node built-ins only.
// `now` is injected as a Date or epoch milliseconds (number); both are accepted.
import { open, readFile, writeFile, rename, unlink, mkdir, readdir, access } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const LEDGER = 'ledger.json'
const LOCK = 'tick.lock'
const DEFAULT_STALE_MS = 2 * 3600e3

const toMs = (now) => (now instanceof Date ? now.getTime() : now)
const emptyData = () => ({ findings: {}, repos: {}, budgetSamples: [] })

// A corrupt ledger throws: starting empty would re-run every finding.
export async function openLedger(stateDir) {
  const file = join(stateDir, LEDGER)
  let data
  try {
    const text = await readFile(file, 'utf8')
    try { data = JSON.parse(text) } catch (e) {
      throw new Error(`ledger.json is corrupt (${file}): ${e.message}. Refusing to start empty; repair or remove it by hand.`)
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error(`ledger.json is corrupt (${file}): top level is not an object. Refusing to start empty.`)
    }
    data = { ...emptyData(), ...data }
  } catch (e) {
    if (e.code !== 'ENOENT') throw e
    data = emptyData()
  }
  return {
    data,
    async save() {
      await mkdir(stateDir, { recursive: true })
      const tmp = `${file}.tmp`
      await writeFile(tmp, JSON.stringify(this.data, null, 2))
      await rename(tmp, file)
    },
  }
}

async function tryCreate(path, body) {
  let fh
  try { fh = await open(path, 'wx') } catch (e) {
    if (e.code === 'EEXIST') return false
    throw e
  }
  try { await fh.writeFile(body) } finally { await fh.close() }
  return true
}

export async function acquireLock(stateDir, { now, staleMs = DEFAULT_STALE_MS } = {}) {
  await mkdir(stateDir, { recursive: true })
  const path = join(stateDir, LOCK)
  const at = toMs(now)
  const token = randomUUID()
  const body = JSON.stringify({ pid: process.pid, at, token })
  let got = await tryCreate(path, body)
  if (!got) {
    let stale = false
    try {
      const held = JSON.parse(await readFile(path, 'utf8'))
      stale = !(typeof held?.at === 'number') || at - held.at > staleMs
    } catch {
      stale = true // unparseable, or vanished between open and read: retry the create
    }
    if (!stale) return { ok: false, reason: 'locked' }
    await unlink(path).catch((e) => { if (e.code !== 'ENOENT') throw e })
    got = await tryCreate(path, body) // exactly one retry: if another taker won, we lose
    if (!got) return { ok: false, reason: 'locked' }
  }
  return {
    ok: true,
    async release() {
      try {
        const held = JSON.parse(await readFile(path, 'utf8'))
        if (held?.token === token) await unlink(path)
      } catch { /* already gone or not ours */ }
    },
  }
}

export async function isPaused(stateDir) {
  try { await access(join(stateDir, 'paused')); return true } catch { return false }
}

export async function writeRun(stateDir, run, now) {
  const dir = join(stateDir, 'runs')
  await mkdir(dir, { recursive: true })
  const stamp = new Date(toMs(now)).toISOString().replace(/:/g, '-')
  const path = join(dir, `${stamp}.json`)
  await writeFile(path, JSON.stringify(run, null, 2))
  return path
}

export async function recentRuns(stateDir, n) {
  const dir = join(stateDir, 'runs')
  let names
  try { names = await readdir(dir) } catch (e) { if (e.code === 'ENOENT') return []; throw e }
  names = names.filter((f) => f.endsWith('.json')).sort().reverse().slice(0, n)
  return Promise.all(names.map(async (f) => JSON.parse(await readFile(join(dir, f), 'utf8'))))
}
