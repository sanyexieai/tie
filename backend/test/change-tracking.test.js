import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { spawn } from 'node:child_process'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tie-changes-test-'))
process.env.TIE_DATA_DIR = dataDir
process.env.TIE_ALLOW_WEAK_SECRET = '1'
const { createApp } = await import('../src/app.js')
const { closeLive } = await import('../src/live.js')
const { readReviews } = await import('../src/reviews.js')
let server, endpoint, token, workspaceId, userId
const origin = { clientId: 'tie-web', clientName: 'Tie 网页', clientVersion: '1.0.59',
  deviceId: 'dev_test_a', deviceName: '测试电脑 A', platform: 'Windows', actor: '测试用户', userId: 'forged' }
const stamp = '2026-11-26T00:00:00.000Z'
let page = { id: 'pg_changes', title: '变更测试', icon: '', parentId: null, sortKey: 0,
  markdown: '# 变更测试', tags: [], createdAt: stamp, updatedAt: stamp, deletedAt: null }

async function request(route, method = 'GET', body, headers = {}) {
  const response = await fetch(`${endpoint}${route}`, {
    method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  return { status: response.status, body: text ? JSON.parse(text) : null }
}
const route = () => `/api/v1/workspaces/${workspaceId}/pages/${page.id}`
const headers = { 'x-tie-origin': encodeURIComponent(JSON.stringify(origin)) }

before(async () => {
  server = createApp({ jwtSecret: 'test-changes-secret-long-enough-123' }).listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  endpoint = `http://127.0.0.1:${server.address().port}`
  const account = await request('/api/v1/auth/register', 'POST', { name: '测试用户', email: 'changes@example.test', password: 'testing123' })
  token = account.body.accessToken
  userId = account.body.user.id
  const workspace = await request('/api/v1/workspaces', 'POST', { name: '变更记录库' })
  workspaceId = workspace.body.id
})
after(async () => {
  closeLive()
  await new Promise((resolve) => server.close(resolve))
  fs.rmSync(dataDir, { recursive: true, force: true })
})

test('HTTP edits record real changes with client/device and authoritative account, replication adds none', async () => {
  assert.equal((await request(route(), 'PUT', page, headers)).status, 200)
  page = { ...page, markdown: '# 变更测试\n\n第一处修改', updatedAt: '2026-11-26T00:00:01.000Z' }
  assert.equal((await request(route(), 'PUT', page, headers)).status, 200)
  await request(route(), 'PUT', { ...page, updatedAt: '2026-11-26T00:00:02.000Z' }, headers)
  page = { ...page, title: '改名', updatedAt: '2026-11-26T00:00:03.000Z' }
  await request(route(), 'PUT', page, headers)
  page = { ...page, deletedAt: '2026-11-26T00:00:04.000Z', updatedAt: '2026-11-26T00:00:04.000Z' }
  await request(route(), 'PUT', page, headers)
  page = { ...page, deletedAt: null, updatedAt: '2026-11-26T00:00:05.000Z' }
  await request(route(), 'PUT', page, headers)
  page = { ...page, markdown: '# 复制过来的版本', updatedAt: '2026-11-26T00:00:06.000Z' }
  await request(route(), 'PUT', page, { ...headers, 'x-tie-replication': '1' })
  const reviews = (await request(`${route()}/reviews`)).body.entries
  assert.deepEqual(reviews.map((item) => item.type), ['create', 'update', 'update', 'trash', 'restore'])
  assert.deepEqual(reviews[1].changedFields, ['markdown'])
  assert.deepEqual(reviews[2].changedFields, ['title'])
  for (const item of reviews) {
    assert.equal(item.origin.deviceId, origin.deviceId)
    assert.equal(item.origin.deviceName, origin.deviceName)
    assert.equal(item.origin.clientName, origin.clientName)
    assert.equal(item.origin.userId, userId)
  }
  const unknown = { ...page, id: 'pg_unknown' }
  assert.equal((await request(`/api/v1/workspaces/${workspaceId}/pages/pg_unknown`, 'PUT', unknown)).status, 200)
  const [entry] = (await request(`/api/v1/workspaces/${workspaceId}/pages/pg_unknown/reviews`)).body.entries
  assert.equal(entry.origin.deviceId, '')
  assert.equal(entry.origin.deviceName, '')
  const malformed = await request(route(), 'PUT', page, { 'x-tie-origin': '%zz' })
  assert.equal(malformed.status, 400)
})

test('shared signals reply, require a saved adoption, and retain withdrawal after stale sync', async () => {
  let result = await request(`${route()}/signals`, 'POST', { id: 'op_first', opinionKind: 'correction', quote: '旧表述', body: '请修正这里', baseUpdatedAt: page.updatedAt }, headers)
  assert.equal(result.status, 200)
  const open = result.body.entries.find((item) => item.id === 'op_first')
  assert.equal(open.origin.deviceId, origin.deviceId)
  result = await request(`${route()}/signals`, 'POST', { id: 'op_reply', opinionKind: 'support', body: '同意修正', replyTo: 'op_first' }, headers)
  assert.equal(result.body.entries.find((item) => item.id === 'op_reply').replyTo, 'op_first')
  result = await request(`${route()}/signals/op_first/resolve`, 'POST', { status: 'adopted', appliedUpdatedAt: page.updatedAt }, headers)
  assert.equal(result.status, 400)
  page = { ...page, markdown: '# 已按意见修改', updatedAt: '2026-11-26T00:00:07.000Z' }
  assert.equal((await request(route(), 'PUT', page, headers)).status, 200)
  result = await request(`${route()}/signals/op_first/resolve`, 'POST', { status: 'adopted', appliedUpdatedAt: page.updatedAt, resolutionNote: '正文已保存' }, headers)
  assert.equal(result.status, 200)
  let signal = result.body.entries.find((item) => item.id === 'op_first')
  assert.equal(signal.status, 'adopted')
  assert.equal(signal.appliedUpdatedAt, page.updatedAt)
  assert.equal(signal.resolutionOrigin.deviceId, origin.deviceId)
  result = await request(`${route()}/signals/op_first/resolve`, 'POST', { status: 'withdrawn' }, headers)
  assert.equal(result.status, 200)
  result = await request(`${route()}/reviews`, 'PUT', { entries: [{ ...open, updatedAt: '2099-01-01T00:00:00.000Z' }] })
  signal = result.body.entries.find((item) => item.id === 'op_first')
  assert.equal(signal.status, 'withdrawn')
  assert.equal((await request(`${route()}/signals/op_first/resolve`, 'POST', { status: 'resolved' }, headers)).status, 400)
})

test('independent CLI-style processes merge reviews without dropping concurrent entries', async () => {
  const modulePath = new URL('../src/reviews.js', import.meta.url).href
  const code = `import {saveMergedReviews} from ${JSON.stringify(modulePath)};
    for(let i=0;i<12;i++) saveMergedReviews(process.argv[1], 'pg_parallel', [{id:process.argv[2]+'_'+i,kind:'change',at:new Date().toISOString(),origin:{deviceId:process.argv[2]}}]);`
  const processes = Array.from({ length: 4 }, (_, i) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code, workspaceId, `dev_${i}`], { env: { ...process.env, TIE_DATA_DIR: dataDir }, stdio: ['ignore', 'ignore', 'pipe'] })
    let error = ''
    child.stderr.on('data', (part) => { error += part })
    child.on('error', reject)
    child.on('exit', (status) => status === 0 ? resolve() : reject(new Error(error)))
  }))
  await Promise.all(processes)
  assert.equal(readReviews(workspaceId, 'pg_parallel').entries.length, 48)
})
