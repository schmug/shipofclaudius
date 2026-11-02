// Loopback HTTP client for Scrutineer's operator API. Model-free.
// Invariants: every URL passes isLoopback before fetch; the operator token is read at call
// time and only ever placed in the Authorization header (never in errors or logs); POSTs are
// form-encoded with redirect:'manual' because the UI routes answer 303 + Location.
import { readFile as fsReadFile } from 'node:fs/promises'
import { isLoopback } from './config.mjs'

const REQUIRED_FIELDS = ['last_revalidate_verdict', 'production_viability', 'suggested_fix', 'breaking_change']
const SKILLS = new Set(['verify', 'critic', 'patch', 'reattack'])
const REFUSED_STATUSES = new Set(['rejected', 'duplicate', 'ready', 'reported'])

export class ScrutineerError extends Error {
  constructor(status, path, detail = '') {
    super(`scrutineer ${path} failed: ${status}${detail ? ` ${detail}` : ''}`)
    this.name = 'ScrutineerError'
    this.status = status
    this.path = path
  }
}

export class ScrutineerTooOld extends Error {
  constructor(missing) {
    super(`scrutineer-too-old: finding lacks ${missing.join(', ')}`)
    this.name = 'ScrutineerTooOld'
    this.missing = missing
  }
}

function parseJsonl(text) {
  return text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
}

export function createClient({ baseUrl, tokenPath, readFile = fsReadFile, fetch = globalThis.fetch }) {
  async function token() {
    let t
    try { t = String(await readFile(tokenPath, 'utf8')).trim() } catch { throw new Error(`cannot read operator token at ${tokenPath}`) }
    if (!t) throw new Error(`operator token at ${tokenPath} is empty`)
    return t
  }

  async function request(method, path, { query, form } = {}) {
    const qs = query && Object.keys(query).length ? `?${new URLSearchParams(query)}` : ''
    const url = `${baseUrl.replace(/\/+$/, '')}${path}${qs}`
    if (!isLoopback(url)) throw new Error(`refusing non-loopback url (must be 127.0.0.1, localhost or ::1): ${path}`)
    const headers = { Authorization: `Bearer ${await token()}` }
    const init = { method, headers, redirect: 'manual' }
    if (form) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded'
      init.body = new URLSearchParams(form).toString()
    }
    const res = await fetch(url, init)
    const redirected = res.status >= 300 && res.status < 400
    if (!res.ok && !(method === 'POST' && redirected)) {
      await res.text?.().catch(() => {})
      throw new ScrutineerError(res.status, path)
    }
    return res
  }

  const getJsonl = async (path, query) => parseJsonl(await (await request('GET', path, { query })).text())

  return {
    async getFinding(id) {
      const f = await (await request('GET', `/api/v1/findings/${encodeURIComponent(id)}`)).json()
      const missing = REQUIRED_FIELDS.filter((k) => !(k in f))
      if (missing.length) throw new ScrutineerTooOld(missing)
      return f
    },
    listFindings: (query) => getJsonl('/api/v1/findings', query),
    listScans: (query) => getJsonl('/api/v1/scans', query),
    listRepositories: () => getJsonl('/api/v1/repositories'),

    async runFindingSkill(id, skill) {
      if (!SKILLS.has(skill)) throw new Error(`unknown skill ${JSON.stringify(skill)}`)
      const res = await request('POST', `/findings/${encodeURIComponent(id)}/${skill}`, { form: {} })
      const loc = res.headers.get('location') ?? ''
      const m = loc.match(/\/scans\/(\d+)(?:[/?#]|$)/)
      if (m) return { scanId: Number(m[1]), duplicate: false }
      return { scanId: null, duplicate: /\/findings\/\d+/.test(loc) }
    },
    async setStatus(id, status) {
      if (REFUSED_STATUSES.has(status)) throw new Error(`refusing to set status ${status} (not allowed from the autopilot)`)
      await request('POST', `/findings/${encodeURIComponent(id)}/status`, { form: { status } })
    },
    async addNote(id, body) {
      await request('POST', `/findings/${encodeURIComponent(id)}/notes`, { form: { body } })
    },
    async scanRepo(repoId, { mode = 'full' } = {}) {
      await request('POST', `/repositories/${encodeURIComponent(repoId)}/scan`, { form: mode === 'diff' ? { rescan_mode: 'diff' } : {} })
    },
  }
}
