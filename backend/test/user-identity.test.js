import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, it } from 'node:test'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tie-user-identity-'))
process.env.TIE_DATA_DIR = dataDir
process.env.NODE_ENV = 'test'
const { createApp } = await import('../src/app.js')
const { store } = await import('../src/store.js')
const password = 'test-secret-123'
let server
let base
let adminToken

before(async () => {
  server = createApp({ jwtSecret: 'test-only-user-identity-secret-123456' }).listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  base = `http://127.0.0.1:${server.address().port}`
  const created = await register('identity-admin@example.com', 'Identity Admin')
  assert.equal(created.status, 200)
  adminToken = created.body.accessToken
})

after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  fs.rmSync(dataDir, { recursive: true, force: true })
})

async function request(route, body, { method = 'POST', admin = false } = {}) {
  const response = await fetch(`${base}/api/v1/${route}`, {
    method,
    headers: { 'content-type': 'application/json', ...(admin ? { authorization: `Bearer ${adminToken}` } : {}) },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() }
}

function register(email, name) {
  return request('auth/register', { email, name, password })
}

function createUser(email, name) {
  return request('admin/users', { email, name, password }, { admin: true })
}

function updateUser(id, body) {
  return request(`admin/users/${id}`, body, { method: 'PATCH', admin: true })
}

it('rejects duplicate usernames after trimming and folding case', async () => {
  const first = await register('sanye-owner@example.com', 'Sanye')
  assert.equal(first.status, 200)
  for (const [index, name] of ['Sanye', ' sAnYe ', 'SANYE'].entries()) {
    const duplicate = await register(`sanye-duplicate-${index}@example.com`, name)
    assert.equal(duplicate.status, 409)
    assert.equal(duplicate.body.message, '用户名已存在')
  }
  const login = await request('auth/login', { username: ' sAnYe ', password })
  assert.equal(login.status, 200)
  assert.equal(login.body.user.id, first.body.user.id)
})

it('checks the email local-part when a username is omitted', async () => {
  assert.equal((await register('fallback@first.example')).status, 200)
  assert.equal((await register('fallback@second.example')).status, 409)
  assert.equal((await register('explicit-fallback@example.com', ' FALLBACK ')).status, 409)
})

it('allows exactly one simultaneous registration for a username', async () => {
  const responses = await Promise.all([
    register('parallel-one@example.com', 'Parallel'),
    register('parallel-two@example.com', ' PARALLEL '),
  ])
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409])
  const matching = store.loadUsers().filter((user) => user.name.trim().toLowerCase() === 'parallel')
  assert.equal(matching.length, 1)
})

it('prevents username and email collisions that would shadow login identifiers', async () => {
  const asName = await register('email-as-name@example.com', ' SANYE-OWNER@EXAMPLE.COM ')
  assert.equal(asName.status, 409)
  assert.equal(asName.body.message, '用户名与已有账号的邮箱冲突')
  assert.equal((await register('alias-owner@example.com', 'login-alias@example.com')).status, 200)
  const asEmail = await register(' LOGIN-ALIAS@EXAMPLE.COM ', 'Unrelated Name')
  assert.equal(asEmail.status, 409)
  assert.equal(asEmail.body.message, '邮箱与已有账号的用户名冲突')
  const ownEmail = await register('own-identifier@example.com', 'own-identifier@example.com')
  assert.equal(ownEmail.status, 200)
  const duplicateEmail = await register(' SANYE-OWNER@EXAMPLE.COM ', 'Another Name')
  assert.equal(duplicateEmail.status, 409)
  assert.equal(duplicateEmail.body.message, '邮箱已注册')
})

it('keeps admin creations unique, including concurrent public registration', async () => {
  assert.equal((await createUser('managed-duplicate@example.com', ' sanye ')).status, 409)
  assert.equal((await createUser('fallback@managed.example')).status, 409)
  assert.equal((await createUser('managed-cross@example.com', 'sanye-owner@example.com')).status, 409)
  assert.equal((await createUser('login-alias@example.com', 'Managed Cross')).status, 409)
  const managed = await Promise.all([
    createUser('managed-one@example.com', 'Managed Parallel'),
    createUser('managed-two@example.com', ' MANAGED PARALLEL '),
  ])
  assert.deepEqual(managed.map((response) => response.status).sort(), [201, 409])
  const mixed = await Promise.all([
    register('mixed-public@example.com', 'Mixed Parallel'),
    createUser('mixed-admin@example.com', ' MIXED PARALLEL '),
  ])
  assert.equal(mixed.filter((response) => [200, 201].includes(response.status)).length, 1)
  assert.equal(mixed.filter((response) => response.status === 409).length, 1)
  const unique = await Promise.all([
    createUser('managed-distinct-one@example.com', 'Managed Distinct One'),
    createUser('managed-distinct-two@example.com', 'Managed Distinct Two'),
  ])
  assert.deepEqual(unique.map((response) => response.status), [201, 201])
  for (const email of ['managed-distinct-one@example.com', 'managed-distinct-two@example.com']) {
    assert.ok(store.loadUsers().some((user) => user.email === email))
  }
})

it('checks changed admin identities and retains unchanged account identifiers', async () => {
  const created = await createUser('rename-target@example.com', 'Rename Target')
  assert.equal(created.status, 201)
  const id = created.body.id
  const original = await updateUser(id, { email: ' RENAME-TARGET@EXAMPLE.COM ', name: ' Rename Target ' })
  assert.equal(original.status, 200)
  for (const body of [
    { name: ' sANyE ' }, { name: 'sanye-owner@example.com' },
    { email: ' SANYE-OWNER@EXAMPLE.COM ' }, { email: 'LOGIN-ALIAS@EXAMPLE.COM' },
  ]) {
    assert.equal((await updateUser(id, body)).status, 409)
  }
  const saved = store.loadUsers().find((user) => user.id === id)
  assert.equal(saved.name, 'Rename Target')
  assert.equal(saved.email, 'rename-target@example.com')
  assert.equal((await updateUser(id, { name: 'Renamed Target' })).status, 200)
  assert.equal((await updateUser(id, { disabled: true })).status, 200)
  assert.equal((await register('disabled-name@example.com', ' RENAMED TARGET ')).status, 409)
})

it('checks concurrent password-changing renames against the latest saved users', async () => {
  const first = await createUser('rename-race-one@example.com', 'Rename Race One')
  const second = await createUser('rename-race-two@example.com', 'Rename Race Two')
  const responses = await Promise.all([
    updateUser(first.body.id, { name: 'Rename Race', password: 'changed-secret-123' }),
    updateUser(second.body.id, { name: ' RENAME RACE ', password: 'changed-secret-123' }),
  ])
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409])
  assert.equal(store.loadUsers().filter((user) => user.name.trim().toLowerCase() === 'rename race').length, 1)
  const renamed = await Promise.all([
    updateUser(first.body.id, { name: 'Final Race One', password: 'final-secret-123' }),
    updateUser(second.body.id, { name: 'Final Race Two', password: 'final-secret-123' }),
  ])
  assert.deepEqual(renamed.map((response) => response.status), [200, 200])
  assert.equal(store.loadUsers().find((user) => user.id === first.body.id).name, 'Final Race One')
  assert.equal(store.loadUsers().find((user) => user.id === second.body.id).name, 'Final Race Two')
})

it('preserves legacy duplicate names for email login and unrelated admin updates', async () => {
  const original = await register('legacy-one@example.com', 'Legacy Shared')
  assert.equal(original.status, 200)
  const users = store.loadUsers()
  const first = users.find((user) => user.id === original.body.user.id)
  const second = { ...first, id: 'usr_legacy_shared_fixture', email: 'legacy-two@example.com', name: ' legacy SHARED ' }
  users.push(second)
  store.saveUsers(users)
  assert.equal((await request('auth/login', { username: 'Legacy Shared', password })).status, 401)
  for (const user of [first, second]) {
    const response = await request('auth/login', { email: user.email, password })
    assert.equal(response.status, 200)
    assert.equal(response.body.user.id, user.id)
  }
  const updated = await updateUser(first.id, { name: ' Legacy Shared ', role: 'user', password: 'legacy-new-secret' })
  assert.equal(updated.status, 200)
  assert.equal((await updateUser(first.id, { disabled: true })).status, 200)
  assert.equal((await updateUser(first.id, { disabled: false })).status, 200)
  assert.equal((await updateUser(first.id, { email: 'legacy-renamed@example.com' })).status, 200)
  assert.equal((await request('auth/login', { email: 'legacy-renamed@example.com', password: 'legacy-new-secret' })).status, 200)
  assert.equal((await request('auth/login', { email: second.email, password })).status, 200)
  assert.equal((await updateUser(first.id, { name: ' Sanye ' })).status, 409)
})
