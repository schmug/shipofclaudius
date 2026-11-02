// Tests for the loopback Scrutineer client against a node:http stub.
// Run:  node tests/scrutineer-autopilot-client.test.mjs
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient, ScrutineerTooOld, ScrutineerError } from '../packages/scrutineer-autopilot/src/client.mjs'
import { startStub } from './lib/stub-scrutineer.mjs'

const tests = []
const test = (name, fn) => tests.push([name, fn])

const TOKEN = 'tok-SECRET-123'
const dir = mkdtempSync(join(tmpdir(), 'scrut-client-'))
const tokenPath = join(dir, 'operator-token')
writeFileSync(tokenPath, TOKEN + '\n')

const FULL = { id: 5, status: 'new', last_revalidate_verdict: 'confirmed', production_viability: 'high', suggested_fix: 'x', breaking_change: false }
const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n\n'
const redirect = (loc) => ({ status: 303, headers: { Location: loc } })

async function withStub(routes, fn) {
  const stub = await startStub(routes)
  try { return await fn(stub, createClient({ baseUrl: stub.url, tokenPath })) } finally { await stub.close() }
}

test('getFinding: rejects with ScrutineerTooOld when breaking_change is missing', async () => {
  const { breaking_change, ...old } = FULL
  await withStub({ 'GET /api/v1/findings/{id}': { json: old } }, async (_s, c) => {
    await assert.rejects(c.getFinding(5), (e) => e instanceof ScrutineerTooOld && /breaking_change/.test(e.message))
  })
})

test('getFinding: returns the object when all 4 fields are present', async () => {
  await withStub({ 'GET /api/v1/findings/{id}': { json: FULL } }, async (_s, c) => {
    assert.deepEqual(await c.getFinding(5), FULL)
  })
})

test('runFindingSkill: 303 to /scans/77 gives scanId 77 with bearer header on the right route', async () => {
  await withStub({ 'POST /findings/{id}/verify': redirect('/scans/77') }, async (s, c) => {
    assert.deepEqual(await c.runFindingSkill(5, 'verify'), { scanId: 77, duplicate: false })
    assert.equal(s.requests.length, 1)
    assert.equal(s.requests[0].method, 'POST')
    assert.equal(s.requests[0].path, '/findings/5/verify')
    assert.equal(s.requests[0].headers.authorization, `Bearer ${TOKEN}`)
    assert.match(s.requests[0].headers['content-type'], /application\/x-www-form-urlencoded/)
  })
})

test('runFindingSkill: 303 to /findings/<id> is a duplicate', async () => {
  await withStub({ 'POST /findings/{id}/critic': redirect('/findings/5') }, async (_s, c) => {
    assert.deepEqual(await c.runFindingSkill(5, 'critic'), { scanId: null, duplicate: true })
  })
})

test('runFindingSkill: absolute Location URL is parsed; unknown skill throws locally', async () => {
  await withStub({ 'POST /findings/{id}/patch': redirect('http://127.0.0.1:9/scans/8') }, async (s, c) => {
    assert.deepEqual(await c.runFindingSkill(5, 'patch'), { scanId: 8, duplicate: false })
    await assert.rejects(c.runFindingSkill(5, 'rm'), /skill/)
    assert.equal(s.requests.length, 1)
  })
})

test('setStatus: refuses rejected, duplicate, ready and reported with zero requests', async () => {
  await withStub({}, async (s, c) => {
    for (const st of ['rejected', 'duplicate', 'ready', 'reported']) {
      await assert.rejects(c.setStatus(5, st), /refus/, st)
    }
    assert.equal(s.requests.length, 0)
  })
})

test('setStatus: posts form field status for an allowed status', async () => {
  await withStub({ 'POST /findings/{id}/status': redirect('/findings/5') }, async (s, c) => {
    await c.setStatus(5, 'fixed')
    assert.deepEqual(s.requests[0].body, { status: 'fixed' })
  })
})

test('addNote: posts form field body to /findings/{id}/notes', async () => {
  await withStub({ 'POST /findings/{id}/notes': redirect('/findings/5') }, async (s, c) => {
    await c.addNote(5, 'hello & world')
    assert.equal(s.requests[0].path, '/findings/5/notes')
    assert.deepEqual(s.requests[0].body, { body: 'hello & world' })
  })
})

test('scanRepo: diff sends rescan_mode=diff, full does not', async () => {
  await withStub({ 'POST /repositories/{id}/scan': redirect('/repositories/3#rt3') }, async (s, c) => {
    await c.scanRepo(3, { mode: 'diff' })
    await c.scanRepo(3, { mode: 'full' })
    assert.equal(s.requests[0].path, '/repositories/3/scan')
    assert.equal(s.requests[0].body.rescan_mode, 'diff')
    assert.equal(s.requests[1].body.rescan_mode, undefined)
  })
})

test('POST redirect to /login rejects with ScrutineerError for addNote and runFindingSkill', async () => {
  await withStub({ 'POST /findings/{id}/notes': redirect('/login'), 'POST /findings/{id}/verify': redirect('/login') }, async (_s, c) => {
    await assert.rejects(c.addNote(5, 'x'), (e) => e instanceof ScrutineerError)
    await assert.rejects(c.runFindingSkill(5, 'verify'), (e) => e instanceof ScrutineerError)
  })
})

test('POST redirect to another finding id rejects', async () => {
  await withStub({ 'POST /findings/{id}/status': redirect('/findings/6'), 'POST /repositories/{id}/scan': redirect('/repositories/9') }, async (_s, c) => {
    await assert.rejects(c.setStatus(5, 'fixed'), ScrutineerError)
    await assert.rejects(c.scanRepo(3, { mode: 'full' }), ScrutineerError)
  })
})

test('POST answered 200 rejects; 401 surfaces as ScrutineerError(401, path)', async () => {
  await withStub({ 'POST /findings/{id}/notes': { status: 200, body: 'ok' }, 'POST /findings/{id}/status': { status: 401 } }, async (_s, c) => {
    await assert.rejects(c.addNote(5, 'x'), (e) => e instanceof ScrutineerError && e.status === 200)
    await assert.rejects(c.setStatus(5, 'fixed'), (e) => e instanceof ScrutineerError && e.status === 401 && e.path === '/findings/5/status')
  })
})

test('errors: a 500 throws ScrutineerError carrying status and path, never the token', async () => {
  await withStub({ 'GET /api/v1/findings/{id}': { status: 500, body: `boom ${TOKEN}` }, 'POST /findings/{id}/notes': { status: 500 } }, async (_s, c) => {
    for (const p of [c.getFinding(5), c.addNote(5, 'x')]) {
      const err = await p.then(() => null, (e) => e)
      assert.ok(err instanceof ScrutineerError)
      assert.equal(err.status, 500)
      assert.ok(!err.message.includes(TOKEN) && !String(err.stack).includes(TOKEN))
    }
  })
})

test('listFindings: parses 3 JSONL lines and ignores a trailing blank line', async () => {
  const rows = [{ id: 1 }, { id: 2 }, { id: 3 }]
  await withStub({ 'GET /api/v1/findings': { body: jsonl(rows) } }, async (s, c) => {
    assert.deepEqual(await c.listFindings({ status: 'new' }), rows)
    assert.equal(s.requests[0].query, 'status=new')
  })
})

test('listScans and listRepositories: parse JSONL', async () => {
  await withStub({ 'GET /api/v1/scans': { body: jsonl([{ id: 1 }]) }, 'GET /api/v1/repositories': { body: jsonl([{ id: 2 }, { id: 3 }]) } }, async (_s, c) => {
    assert.equal((await c.listScans()).length, 1)
    assert.equal((await c.listRepositories()).length, 2)
  })
})

test('token file missing: rejects with /operator token/', async () => {
  const c = createClient({ baseUrl: 'http://127.0.0.1:1', tokenPath: join(dir, 'nope') })
  await assert.rejects(c.listRepositories(), /operator token/)
})

test('non-loopback baseUrl: refused before any fetch', async () => {
  let called = false
  const c = createClient({ baseUrl: 'http://example.com', tokenPath, fetch: async () => { called = true } })
  await assert.rejects(c.listRepositories(), /loopback/)
  assert.equal(called, false)
})

test('stub: regex route keys match', async () => {
  const stub = await startStub({ 'GET /^\\/x\\/\\d+$/': { body: 'ok' } })
  try {
    const r = await fetch(stub.url + '/x/42')
    assert.equal(await r.text(), 'ok')
    assert.equal((await fetch(stub.url + '/x/a')).status, 404)
  } finally { await stub.close() }
})

// ---- runner ----
let failed = 0
for (const [name, fn] of tests) {
  try { await fn(); console.log('PASS', name) }
  catch (e) { failed++; console.error('FAIL', name, '\n  ', e.message) }
}
console.log(failed ? `\n${failed}/${tests.length} FAILED` : `\nall ${tests.length} passed`)
process.exit(failed ? 1 : 0)
