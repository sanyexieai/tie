import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tie-protected-reviews-'))
process.env.TIE_DATA_DIR = dataDir
process.env.TIE_ALLOW_WEAK_SECRET = '1'
const { createApp } = await import('../src/app.js')
const { closeLive } = await import('../src/live.js')
const { reviewsFile } = await import('../src/reviews.js')
const prefix = '-----BEGIN TIE ENCRYPTED MARKDOWN-----'
const envelope = (value) => `${prefix}\n{"version":1,"ciphertext":"${value}"}\n-----END TIE ENCRYPTED MARKDOWN-----\n`
const canary = 'fixture-plaintext-review-rejected-82139'
let server, endpoint, token, workspaceId, protectedPage
const route = (id = 'pg_private') => `/api/v1/workspaces/${workspaceId}/pages/${id}`

async function request(url, method = 'GET', body) {
  const response = await fetch(`${endpoint}${url}`, { method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const text = await response.text()
  return { status: response.status, body: text ? JSON.parse(text) : null }
}

before(async () => {
  server = createApp({ jwtSecret: 'test-protected-reviews-secret-over-32-characters' }).listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  endpoint = `http://127.0.0.1:${server.address().port}`
  const account = await request('/api/v1/auth/register', 'POST', { name: 'Protected Owner', email: 'protected-reviews@example.test', password: 'fixture-login-password' })
  token = account.body.accessToken
  workspaceId = (await request('/api/v1/workspaces', 'POST', { name: 'Protected reviews' })).body.id
  const stamp = '2026-11-27T00:00:00.000Z'
  const base = { id: 'pg_private', title: 'Private page', icon: '', parentId: null, sortKey: 0,
    tags: [], createdAt: stamp, updatedAt: stamp, deletedAt: null }
  protectedPage = (await request(route(), 'PUT', { ...base, markdown: envelope('opaque-page') })).body
  assert.equal((await request(route('pg_ordinary'), 'PUT', { ...base, id: 'pg_ordinary', title: 'Ordinary', markdown: '# Ordinary' })).status, 200)
})
after(async () => {
  closeLive()
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
  fs.rmSync(dataDir, { recursive: true, force: true })
})

test('ordinary discussion bodies and their existing size limits remain unchanged', async () => {
  let response = await request(`${route('pg_ordinary')}/signals`, 'POST', { id: 'op_plain', opinionKind: 'support', quote: 'ordinary quote', body: ' ordinary body ' })
  assert.equal(response.status, 200)
  assert.equal(response.body.entries.find((entry) => entry.id === 'op_plain').body, 'ordinary body')
  response = await request(`${route('pg_ordinary')}/signals/op_plain/resolve`, 'POST', { status: 'resolved', resolutionNote: 'ordinary explanation' })
  assert.equal(response.status, 200)
  assert.equal(response.body.entries.find((entry) => entry.id === 'op_plain').resolutionNote, 'ordinary explanation')
  assert.equal((await request(`${route('pg_ordinary')}/signals`, 'POST', { opinionKind: 'support', body: 'x'.repeat(100001) })).status, 400)
  assert.equal((await request(`${route('pg_ordinary')}/signals`, 'POST', { opinionKind: 'support', body: 'body', quote: 'x'.repeat(20001) })).status, 400)
})

test('protected opinions, replies, adoption and withdrawal store opaque fields and reject plaintext', async () => {
  let response = await request(`${route()}/signals`, 'POST', { id: 'op_private', opinionKind: 'correction', body: canary })
  assert.equal(response.status, 400)
  assert.match(response.body.message, /先解锁并加密/)
  response = await request(`${route()}/signals`, 'POST', { id: 'op_private', opinionKind: 'correction', quote: canary, body: envelope('opaque-opinion') })
  assert.equal(response.status, 400)
  const body = envelope('opaque-opinion')
  response = await request(`${route()}/signals`, 'POST', { id: 'op_private', opinionKind: 'correction', quote: '', body, baseUpdatedAt: protectedPage.updatedAt })
  assert.equal(response.status, 200)
  const initial = response.body.entries.find((entry) => entry.id === 'op_private')
  assert.equal(initial.body, body)
  assert.equal(initial.quote, '')
  response = await request(`${route()}/signals`, 'POST', { id: 'op_private_reply', opinionKind: 'support', body: envelope('opaque-reply'), replyTo: 'op_private' })
  assert.equal(response.status, 200)
  assert.equal(response.body.entries.find((entry) => entry.id === 'op_private_reply').replyTo, 'op_private')
  assert.equal((await request(`${route()}/signals/op_private/resolve`, 'POST', { status: 'resolved', resolutionNote: canary })).status, 400)
  assert.equal((await request(`${route()}/signals/op_private/resolve`, 'POST', { status: 'adopted', appliedUpdatedAt: protectedPage.updatedAt })).status, 400)
  protectedPage = (await request(route(), 'PUT', { ...protectedPage, markdown: envelope('opaque-page-update'), updatedAt: '2026-11-27T00:00:01.000Z' })).body
  const note = envelope('opaque-resolution')
  response = await request(`${route()}/signals/op_private/resolve`, 'POST', { status: 'adopted', resolutionNote: note, appliedUpdatedAt: protectedPage.updatedAt })
  assert.equal(response.status, 200)
  assert.equal(response.body.entries.find((entry) => entry.id === 'op_private').resolutionNote, note)
  response = await request(`${route()}/signals/op_private/resolve`, 'POST', { status: 'withdrawn' })
  assert.equal(response.status, 200)
  response = await request(`${route()}/reviews`, 'PUT', { entries: [{ ...initial, updatedAt: '2099-01-01T00:00:00.000Z' }] })
  assert.equal(response.status, 200)
  assert.equal(response.body.entries.find((entry) => entry.id === 'op_private').status, 'withdrawn')
  assert.equal((await request(`${route()}/signals/op_private/resolve`, 'POST', { status: 'resolved' })).status, 400)
  assert.equal((await request(`${route()}/signals`, 'POST', { id: 'op_private', opinionKind: 'support', body: canary })).status, 400)
  assert.ok(!fs.readFileSync(reviewsFile(workspaceId, 'pg_private'), 'utf8').includes(canary))
})

test('protected review merge guards every content field and accepts encrypted size overhead only', async () => {
  for (const field of ['quote', 'body', 'markdown', 'resolutionNote']) {
    const before = fs.readFileSync(reviewsFile(workspaceId, 'pg_private'), 'utf8')
    const response = await request(`${route()}/reviews`, 'PUT', { entries: [{ id: `bad_${field}`, kind: 'opinion', [field]: canary }] })
    assert.equal(response.status, 400)
    assert.equal(fs.readFileSync(reviewsFile(workspaceId, 'pg_private'), 'utf8'), before)
  }
  assert.equal((await request(`${route()}/reviews`, 'PUT', { entries: [{ id: 'ch_metadata', kind: 'change', changedFields: ['markdown'] }] })).status, 200)
  const version = envelope('opaque-version')
  assert.equal((await request(`${route()}/reviews`, 'PUT', { entries: [{ id: 'rv_private', kind: 'version', status: 'open', markdown: version }] })).status, 200)
  const body = envelope('a'.repeat(105000))
  let response = await request(`${route()}/signals`, 'POST', { id: 'op_overhead', opinionKind: 'support', body })
  assert.equal(response.status, 200)
  assert.equal(response.body.entries.find((entry) => entry.id === 'op_overhead').body, body)
  response = await request(`${route()}/signals`, 'POST', { id: 'op_too_large', opinionKind: 'support', body: envelope('a'.repeat(128 * 1024)) })
  assert.equal(response.status, 400)
})
