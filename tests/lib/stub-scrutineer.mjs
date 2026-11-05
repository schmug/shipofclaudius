// node:http stub of the Scrutineer HTTP surface, shared by client and tick tests.
// startStub(routes) -> { url, requests, close }
//   routes: { "METHOD /path": handler | fixed } where the path may use {name} segments
//   (match one path segment) or be a regex written /^.../flags (must start with ^). A fixed response is
//   { status = 200, headers = {}, body = '' } or { json }; a handler is
//   (req) => fixed | Promise<fixed>, with req = { method, path, query, headers, body, params }.
//   Unmatched requests answer 404. `requests` records every request, including 404s.
//   Form bodies are parsed into `body` (plain object); `raw` holds the unparsed text.
import { createServer } from 'node:http'

function compile(key) {
  const sp = key.indexOf(' ')
  const method = key.slice(0, sp).toUpperCase()
  const spec = key.slice(sp + 1)
  const rx = spec.match(/^\/(\^.*)\/([a-z]*)$/s)
  if (rx) return { method, test: (path) => { const m = new RegExp(rx[1], rx[2]).exec(path); return m && { ...m.groups } } }
  const names = []
  const src = spec.split(/(\{\w+\})/).map((part) => {
    const m = part.match(/^\{(\w+)\}$/)
    if (m) { names.push(m[1]); return '([^/]+)' }
    return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }).join('')
  const re = new RegExp(`^${src}$`)
  return { method, test: (path) => { const m = re.exec(path); return m && Object.fromEntries(names.map((n, i) => [n, m[i + 1]])) } }
}

export async function startStub(routes = {}) {
  const compiled = Object.entries(routes).map(([k, v]) => ({ ...compile(k), handler: v }))
  const requests = []
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    const raw = Buffer.concat(chunks).toString('utf8')
    const url = new URL(req.url, 'http://stub')
    const ctype = String(req.headers['content-type'] ?? '')
    const body = ctype.includes('application/x-www-form-urlencoded') ? Object.fromEntries(new URLSearchParams(raw)) : raw
    const rec = { method: req.method, path: url.pathname, query: url.search.slice(1), headers: req.headers, body, raw, params: {} }
    requests.push(rec)
    let out = { status: 404, body: 'not found' }
    for (const r of compiled) {
      if (r.method !== req.method) continue
      const params = r.test(url.pathname)
      if (!params) continue
      rec.params = params
      out = typeof r.handler === 'function' ? await r.handler(rec) : r.handler
      break
    }
    const headers = { ...(out.headers ?? {}) }
    let payload = out.body ?? ''
    if (out.json !== undefined) { payload = JSON.stringify(out.json); headers['Content-Type'] ??= 'application/json' }
    res.writeHead(out.status ?? 200, headers)
    res.end(payload)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve) }),
  }
}
