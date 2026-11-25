import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import { WebSocket } from 'ws'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tie-backend-live-'))
process.env.TIE_DATA_DIR = dataDir
process.env.TIE_JWT_SECRET = 'tie-test-secret-for-ci-with-enough-length'
process.env.TIE_ALLOW_WEAK_SECRET = '1'

const { createApp } = await import('../src/app.js')
const { attachLive, closeLive } = await import('../src/live.js')

describe('workspace live', { concurrency: 1 }, () => {
  /** @type {import('node:http').Server | null} */
  let server = null
  /** @type {import('ws').WebSocketServer | null} */
  let wss = null
  /** @type {string} */
  let baseUrl = ''
  /** @type {string} */
  let token = ''
  /** @type {string} */
  let workspaceId = ''

  before(async () => {
    server = createApp({ jwtSecret: process.env.TIE_JWT_SECRET }).listen(0, '127.0.0.1')
    await new Promise((resolve) => server.once('listening', resolve))
    wss = attachLive(server, process.env.TIE_JWT_SECRET)
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('无法启动测试服务器')
    baseUrl = `http://127.0.0.1:${address.port}`
    const register = await fetch(`${baseUrl}/api/v1/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'live@example.com', password: 'secret123', name: 'Live' }),
    })
    const body = await register.json()
    token = body.accessToken
    const workspaces = await fetch(`${baseUrl}/api/v1/workspaces`, {
      headers: { authorization: `Bearer ${token}` },
    })
    workspaceId = (await workspaces.json())[0].id
  })

  after(async () => {
    closeLive()
    for (const client of wss?.clients ?? []) client.terminate()
    await new Promise((resolve) => wss?.close(() => resolve(undefined)))
    await new Promise((resolve, reject) => server?.close((error) => error ? reject(error) : resolve(undefined)))
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  function listen() {
    const socket = new WebSocket(baseUrl.replace('http://', 'ws://') + '/api/v1/live')
    const messages = []
    const ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('登录通知超时')), 3000)
      socket.on('message', (raw) => {
        const message = JSON.parse(String(raw))
        messages.push(message)
        if (message.type === 'ready') {
          clearTimeout(timer)
          resolve(undefined)
        }
      })
    })
    socket.on('open', () => socket.send(JSON.stringify({ type: 'hello', token })))
    return { socket, messages, ready }
  }

  it('notifies a logged-in client when the workspace file changes', async () => {
    const { socket, messages, ready } = listen()
    await ready
    const pagePath = path.join(dataDir, 'workspaces', workspaceId, 'pages', '来自MCP.md')
    fs.mkdirSync(path.dirname(pagePath), { recursive: true })
    fs.writeFileSync(pagePath, '# 来自MCP\n\n正文\n')
    const message = await waitFor(messages, (item) => item.type === 'workspace' && item.workspaceId === workspaceId)
    assert.equal(message.workspaceId, workspaceId)
    socket.close()
  })

  it('notifies when a page is saved through the api', async () => {
    const { socket, messages, ready } = listen()
    await ready
    const saved = await fetch(`${baseUrl}/api/v1/workspaces/${workspaceId}/pages/pg_live_api`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        id: 'pg_live_api',
        title: '接口写入',
        icon: '',
        markdown: '# 接口写入\n\n正文',
        tags: [],
        parentId: null,
        sortKey: 0,
        createdAt: '2026-11-25T00:00:00.000Z',
        updatedAt: '2026-11-25T00:00:00.000Z',
        deletedAt: null,
      }),
    })
    assert.equal(saved.status, 200)
    const message = await waitFor(messages, (item) => item.type === 'workspace')
    assert.equal(message.workspaceId, workspaceId)
    socket.close()
  })
})

function waitFor(messages, match) {
  const found = messages.find(match)
  if (found) return Promise.resolve(found)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('没有收到工作区更新')), 3000)
    const started = messages.length
    const poll = setInterval(() => {
      const next = messages.slice(started).find(match)
      if (!next) return
      clearInterval(poll)
      clearTimeout(timer)
      resolve(next)
    }, 20)
  })
}
