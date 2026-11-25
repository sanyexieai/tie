import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, it } from 'node:test'
import { hash } from 'argon2'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tie-auth-compat-'))
process.env.TIE_DATA_DIR = dataDir
process.env.NODE_ENV = 'test'
const { createApp } = await import('../src/app.js')
const { store } = await import('../src/store.js')
let server
let base
before(async () => {
  server = createApp({ jwtSecret: 'test-only-auth-compat-secret-123456' }).listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  base = `http://127.0.0.1:${server.address().port}`
})
after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  fs.rmSync(dataDir, { recursive: true, force: true })
})

async function post(route, body) {
  return fetch(`${base}/api/v1/auth/${route}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
}

it('keeps concurrent registrations and gives only the first account admin role', async () => {
  const responses = await Promise.all(['one', 'two'].map((name) => post('register', {
    email: `${name}@example.com`, name, password: 'test-secret-123',
  })))
  assert.deepEqual(responses.map((response) => response.status), [200, 200])
  assert.equal(store.loadUsers().length, 2)
  assert.equal(store.loadUsers().filter((user) => user.role === 'admin').length, 1)
})

it('rejects duplicate simultaneous registrations without replacing an account', async () => {
  const responses = await Promise.all([1, 2].map(() => post('register', {
    email: 'same@example.com', password: 'test-secret-123',
  })))
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409])
  assert.equal(store.loadUsers().filter((user) => user.email === 'same@example.com').length, 1)
})

it('logs in an existing Argon2 account with its original password', async () => {
  const users = store.loadUsers()
  users.push({
    id: 'legacy-user', email: 'legacy@example.com', name: 'Legacy', role: 'user',
    passwordHash: await hash('legacy-test-password'), createdAt: '2026-09-01T00:00:00Z',
  })
  store.saveUsers(users)
  const response = await post('login', { email: 'legacy@example.com', password: 'legacy-test-password' })
  assert.equal(response.status, 200)
  assert.ok((await response.json()).accessToken)
  assert.equal((await post('login', { email: 'legacy@example.com', password: 'wrong-password' })).status, 401)
})
