import fs from 'node:fs'
import jwt from 'jsonwebtoken'
import { WebSocketServer } from 'ws'
import { store } from './store.js'

const clients = new Set()
const watchers = new Map()
const pending = new Map()
let attached = false

export function notifyWorkspace(workspaceId) {
  if (!workspaceId) return
  const previous = pending.get(workspaceId)
  if (previous) clearTimeout(previous)
  pending.set(workspaceId, setTimeout(() => {
    pending.delete(workspaceId)
    const message = JSON.stringify({ type: 'workspace', workspaceId })
    for (const socket of clients) {
      if (socket.readyState !== 1) continue
      if (!socket.workspaceIds?.has(workspaceId)) continue
      socket.send(message)
    }
  }, 150))
}

export function watchWorkspace(workspaceId) {
  if (!attached || !workspaceId || watchers.has(workspaceId)) return
  const dir = store.workspaceDir(workspaceId)
  fs.mkdirSync(dir, { recursive: true })
  try {
    const watcher = fs.watch(dir, { recursive: true }, (_event, name) => {
      const file = String(name || '').replaceAll('\\', '/')
      if (!file || relevantWorkspaceFile(file)) notifyWorkspace(workspaceId)
    })
    watcher.on('error', () => {})
    watchers.set(workspaceId, watcher)
  } catch {
    // 目录暂时不可监听时，保存接口仍会通知。
  }
}

function relevantWorkspaceFile(file) {
  return /^pages\/.+\.md$/.test(file)
    || /^\.tie\/meta\/[A-Za-z0-9_-]+$/.test(file)
    || /^\.tie\/reviews\/[A-Za-z0-9_-]+\.json$/.test(file)
    || /^\.tie\/assets\/[A-Za-z0-9_-]+(?:\/[^/]+)?$/.test(file)
    || /^\.tie\/files\/(?:index\.json|file_[A-Za-z0-9_-]+(?:\/[^/]+)?)$/.test(file)
}

function watchAllWorkspaces() {
  for (const workspace of store.loadWorkspaces()) watchWorkspace(workspace.id)
}

export function closeLive() {
  attached = false
  for (const timer of pending.values()) clearTimeout(timer)
  pending.clear()
  for (const watcher of watchers.values()) watcher.close()
  watchers.clear()
  clients.clear()
}

export function attachLive(server, jwtSecret) {
  attached = true
  watchAllWorkspaces()
  const wss = new WebSocketServer({ server, path: '/api/v1/live' })
  wss.on('connection', (socket) => {
    socket.workspaceIds = new Set()
    const authTimer = setTimeout(() => {
      if (!socket.userId) socket.close(4001, '需要登录')
    }, 8000)
    socket.on('message', (raw) => {
      let message
      try { message = JSON.parse(String(raw)) } catch { return }
      if (message?.type === 'ping' && socket.userId) {
        socket.send(JSON.stringify({ type: 'pong' }))
        return
      }
      if (message?.type !== 'hello') return
      try {
        const payload = jwt.verify(String(message.token ?? ''), jwtSecret)
        const user = store.loadUsers().find((item) => item.id === payload.sub)
        if (!user || user.disabled) {
          socket.close(4003, '账号不可用')
          return
        }
        socket.userId = user.id
        clearTimeout(authTimer)
        const ids = store.loadWorkspaces().filter((item) => item.ownerId === user.id).map((item) => item.id)
        socket.workspaceIds = new Set(ids)
        for (const id of ids) watchWorkspace(id)
        socket.send(JSON.stringify({ type: 'ready', workspaceIds: ids }))
      } catch {
        socket.close(4001, '登录已失效')
      }
    })
    socket.on('close', () => {
      clearTimeout(authTimer)
      clients.delete(socket)
    })
    clients.add(socket)
  })
  return wss
}
