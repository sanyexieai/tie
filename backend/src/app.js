import bcrypt from 'bcryptjs'
import cors from 'cors'
import express from 'express'
import jwt from 'jsonwebtoken'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { store } from './store.js'
import { watchWorkspace } from './live.js'
import * as workspaceStorage from './workspace-storage.js'
import { ensureWorkspaceSolution } from './workspace-pages.js'
import { readReviews, saveMergedReviews } from './reviews.js'
import {
  listWorkspaceFiles,
  getWorkspaceFile,
  upsertWorkspaceFileMeta,
  saveWorkspaceFileBlob,
  readWorkspaceFileBlob,
} from './workspace-files.js'
import { mimeFromAssetName } from './assets.js'
import { suggestTags } from './ai.js'
import { assertProductionReady, createCorsMiddleware, resolveJwtSecret } from './config.js'
import { handleMcpRequest, mcpStatus, mcpUrlForRequest } from './mcp-http.js'
import { applySettingsPatch, detectCli, loadSettings, publicSettings } from './settings.js'
import { createMcpToken, deleteMcpToken, deleteMcpTokensForWorkspace, listMcpTokens, revealMcpToken } from './mcp-tokens.js'
import { assertUniqueUserIdentity, findUserByLogin, publicUser, roleForNewUser, userRole, verifyPassword } from './accounts.js'
import { issueSession, revokeSession, rotateSession } from './sessions.js'
import { mountAdmin } from './admin.js'
import { fileURLToPath } from 'node:url'
import { assertResourceId } from './resource-id.js'
import { mountVault } from './vault-routes.js'

export function createApp(options = {}) {
  const jwtSecret = resolveJwtSecret(options)
  assertProductionReady({ jwtSecret })
  const app = express()
  const adminDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'admin')
  const meDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'me')

  app.use(createCorsMiddleware())
  app.use((req, res, next) => {
    const path = req.originalUrl || req.url || ''
    if (path === '/mcp' || path.startsWith('/mcp/') || path.startsWith('/mcp?')) {
      handleMcpRequest(req, res, jwtSecret)
      return
    }
    next()
  })
  app.use(express.json({ limit: '12mb' }))
  for (const name of ['pageId', 'revisionId']) {
    app.param(name, (_req, res, next, value) => {
      try {
        assertResourceId(value)
        next()
      } catch (error) {
        res.status(error.status).json({ message: error.message })
      }
    })
  }

function nowIso() { return new Date().toISOString() }
function newId(prefix) { return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}` }

function auth(req, res, next) {
  const header = req.headers.authorization ?? ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : null
  if (!token) return res.status(401).json({ message: '未登录' })
  try {
    req.user = jwt.verify(token, jwtSecret)
  } catch {
    return res.status(401).json({ message: '登录已失效' })
  }
  const account = store.loadUsers().find((item) => item.id === req.user.sub)
  if (!account) return res.status(401).json({ message: '用户不存在' })
  if (account.disabled) return res.status(403).json({ message: '账号已停用' })
  req.account = account
  next()
}

function adminOnly(req, res, next) {
  if (userRole(req.account) !== 'admin') return res.status(403).json({ message: '需要管理员权限' })
  next()
}

function findWorkspace(workspaceId, userId) {
  return store.loadWorkspaces().find((item) => item.id === workspaceId && item.ownerId === userId)
}

function writeWorkspace(ownerId, name, extra = {}) {
  const workspace = { id: newId('ws'), name, ownerId, createdAt: nowIso(), ...extra }
  const workspaces = store.loadWorkspaces()
  workspaces.push(workspace)
  store.saveWorkspaces(workspaces)
  fs.mkdirSync(store.workspacePagesDir(workspace.id), { recursive: true })
  fs.mkdirSync(path.join(store.workspaceDir(workspace.id), '.tie'), { recursive: true })
  ensureWorkspaceSolution(workspace.id, workspace.name)
  watchWorkspace(workspace.id)
  return workspace
}

function ensureDefaultWorkspace(ownerId) {
  const owned = store.loadWorkspaces().filter((item) => item.ownerId === ownerId)
  if (owned.length) return owned
  return [writeWorkspace(ownerId, '我的工作区', { default: true })]
}

function handleError(res, error) {
  const status = error.status ?? 500
  res.status(status).json({ message: error.message ?? '服务器错误' })
}

app.use((req, res, next) => {
  if ((req.originalUrl || req.url) === '/admin') return res.redirect(302, '/admin/')
  next()
})
app.use('/admin', express.static(adminDir, { index: 'index.html', redirect: false }))
app.use((req, res, next) => {
  if ((req.originalUrl || req.url) === '/me') return res.redirect(302, '/me/')
  next()
})
app.use('/me', express.static(meDir, { index: 'index.html', redirect: false }))

app.get('/health', (req, res) => {
  const mcp = mcpStatus()
  res.json({
    ok: true,
    service: 'tie-backend',
    time: nowIso(),
    mcp: {
      enabled: mcp.enabled,
      running: mcp.running,
      url: mcpUrlForRequest(req),
      error: mcp.error,
      transport: mcp.transport,
    },
  })
})

app.post('/api/v1/auth/register', async (req, res) => {
  try {
    const email = String(req.body.email ?? '').trim().toLowerCase()
    const password = String(req.body.password ?? '')
    const name = String(req.body.name ?? '').trim() || email.split('@')[0]
    if (!email || password.length < 6) return res.status(400).json({ message: '邮箱或密码无效' })
    const passwordHash = await bcrypt.hash(password, 10)
    const users = store.loadUsers()
    assertUniqueUserIdentity(users, { email, name })
    const user = {
      id: newId('usr'),
      email,
      name,
      passwordHash,
      role: roleForNewUser(users),
      disabled: false,
      createdAt: nowIso(),
    }
    users.push(user)
    store.saveUsers(users)
    ensureDefaultWorkspace(user.id)
    res.json(issueSession(user, jwtSecret))
  } catch (error) { handleError(res, error) }
})

app.post('/api/v1/auth/login', async (req, res) => {
  try {
    const identifier = String(req.body.email ?? req.body.username ?? '').trim()
    const password = String(req.body.password ?? '')
    if (!identifier || !password) return res.status(400).json({ message: '请填写用户名或邮箱，以及密码' })
    const found = findUserByLogin(store.loadUsers(), identifier)
    if (found.reason === 'ambiguous') return res.status(401).json({ message: '有多个同名账号，请用邮箱登录' })
    const user = found.user
    if (!user || !(await verifyPassword(password, user.passwordHash))) {
      return res.status(401).json({ message: '用户名、邮箱或密码错误' })
    }
    if (user.disabled) return res.status(403).json({ message: '账号已停用' })
    res.json(issueSession(user, jwtSecret))
  } catch (error) { handleError(res, error) }
})

app.post('/api/v1/auth/refresh', (req, res) => {
  try {
    res.json(rotateSession(req.body?.refreshToken, jwtSecret))
  } catch (error) { handleError(res, error) }
})

app.post('/api/v1/auth/logout', (req, res) => {
  revokeSession(req.body?.refreshToken)
  res.status(204).end()
})

app.get('/api/v1/me', auth, (req, res) => {
  res.json(publicUser(req.account))
})

mountAdmin(app, { auth, adminOnly, handleError })
mountVault(app, { auth })

app.get('/api/v1/admin/settings', auth, adminOnly, (_req, res) => {
  const settings = loadSettings()
  res.json(publicSettings(settings, detectCli(settings.mcp.cliPath)))
})

app.put('/api/v1/admin/settings', auth, adminOnly, (req, res) => {
  const settings = applySettingsPatch(req.body ?? {})
  res.json(publicSettings(settings, detectCli(settings.mcp.cliPath)))
})

app.use('/api/v1/me/mcp-tokens', (_req, res, next) => {
  res.set('Cache-Control', 'no-store')
  next()
})

app.get('/api/v1/me/mcp-tokens', auth, (req, res) => {
  res.json(listMcpTokens(req.user.sub))
})

app.post('/api/v1/me/mcp-tokens', auth, (req, res) => {
  if (req.body?.reveal !== undefined && typeof req.body.reveal !== 'boolean') {
    return res.status(400).json({ message: 'reveal 必须为布尔值' })
  }
  const workspaceId = String(req.body.workspaceId ?? '').trim()
  const workspace = findWorkspace(workspaceId, req.user.sub)
  if (!workspace) return res.status(404).json({ message: '工作区不存在' })
  const name = String(req.body.name ?? '').trim() || workspace.name
  const created = createMcpToken({ userId: req.user.sub, name, workspaceId }, jwtSecret)
  res.status(201).json(req.body.reveal === false ? { record: created.record } : created)
})

app.get('/api/v1/me/mcp-tokens/:tokenId/secret', auth, (req, res) => {
  try {
    const token = revealMcpToken(req.user.sub, req.params.tokenId, jwtSecret)
    if (!token) return res.status(404).json({ message: '令牌不存在' })
    res.json({ token })
  } catch (error) { handleError(res, error) }
})

app.delete('/api/v1/me/mcp-tokens/:tokenId', auth, (req, res) => {
  if (!deleteMcpToken(req.user.sub, req.params.tokenId)) return res.status(404).json({ message: '令牌不存在' })
  res.status(204).end()
})

app.get('/api/v1/workspaces', auth, (req, res) => {
  ensureDefaultWorkspace(req.user.sub)
  const workspaces = store.loadWorkspaces().filter((item) => item.ownerId === req.user.sub)
  res.json(workspaces)
})

app.post('/api/v1/workspaces', auth, (req, res) => {
  const name = String(req.body.name ?? '').trim()
  if (!name) return res.status(400).json({ message: '工作区名称不能为空' })
  res.status(201).json(writeWorkspace(req.user.sub, name))
})

app.patch('/api/v1/workspaces/:workspaceId', auth, (req, res) => {
  const workspace = findWorkspace(req.params.workspaceId, req.user.sub)
  if (!workspace) return res.status(404).json({ message: '工作区不存在' })
  if (req.body.name !== undefined) {
    const name = String(req.body.name ?? '').trim()
    if (!name) return res.status(400).json({ message: '工作区名称不能为空' })
    workspace.name = name
  }
  const workspaces = store.loadWorkspaces().map((item) => item.id === workspace.id ? workspace : item)
  store.saveWorkspaces(workspaces)
  res.json(workspace)
})

app.delete('/api/v1/workspaces/:workspaceId', auth, (req, res) => {
  const workspace = findWorkspace(req.params.workspaceId, req.user.sub)
  if (!workspace) return res.status(404).json({ message: '工作区不存在' })
  const dir = store.workspaceDir(workspace.id)
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true })
  store.saveWorkspaces(store.loadWorkspaces().filter((item) => item.id !== workspace.id))
  deleteMcpTokensForWorkspace(workspace.id)
  res.status(204).end()
})

app.get('/api/v1/providers', auth, (_req, res) => {
  res.json([])
})

app.post('/api/v1/providers', auth, (_req, res) => {
  res.status(410).json({ message: '对象存储已停用，工作区只保存在服务器磁盘' })
})

app.get('/api/v1/workspaces/:workspaceId/pages', auth, async (req, res) => {
  const workspace = findWorkspace(req.params.workspaceId, req.user.sub)
  if (!workspace) return res.status(404).json({ message: '工作区不存在' })
  try {
    res.json(await workspaceStorage.listPages(workspace))
  } catch (error) { handleError(res, error) }
})

app.get('/api/v1/workspaces/:workspaceId/pages/:pageId', auth, async (req, res) => {
  const workspace = findWorkspace(req.params.workspaceId, req.user.sub)
  if (!workspace) return res.status(404).json({ message: '工作区不存在' })
  try {
    res.json(await workspaceStorage.getPage(workspace, req.params.pageId))
  } catch (error) { handleError(res, error) }
})

app.put('/api/v1/workspaces/:workspaceId/pages/:pageId', auth, async (req, res) => {
  const workspace = findWorkspace(req.params.workspaceId, req.user.sub)
  if (!workspace) return res.status(404).json({ message: '工作区不存在' })
  try {
    const expectedUpdatedAt = req.headers['if-unmodified-since']
    const saved = await workspaceStorage.savePage(
      workspace,
      { ...req.body, id: req.params.pageId },
      expectedUpdatedAt,
    )
    res.json(saved)
  } catch (error) { handleError(res, error) }
})

app.post('/api/v1/workspaces/:workspaceId/pages', auth, async (req, res) => {
  const workspace = findWorkspace(req.params.workspaceId, req.user.sub)
  if (!workspace) return res.status(404).json({ message: '工作区不存在' })
  try {
    await workspaceStorage.removePages(workspace, req.body.pageIds ?? [])
    res.status(204).end()
  } catch (error) { handleError(res, error) }
})

app.get('/api/v1/workspaces/:workspaceId/pages/:pageId/reviews', auth, (req, res) => {
  const workspace = findWorkspace(req.params.workspaceId, req.user.sub)
  if (!workspace) return res.status(404).json({ message: '工作区不存在' })
  try {
    res.json(readReviews(workspace.id, req.params.pageId))
  } catch (error) { handleError(res, error) }
})

app.put('/api/v1/workspaces/:workspaceId/pages/:pageId/reviews', auth, (req, res) => {
  const workspace = findWorkspace(req.params.workspaceId, req.user.sub)
  if (!workspace) return res.status(404).json({ message: '工作区不存在' })
  try {
    const incoming = Array.isArray(req.body?.entries) ? req.body.entries : []
    res.json(saveMergedReviews(workspace.id, req.params.pageId, incoming))
  } catch (error) { handleError(res, error) }
})

app.get('/api/v1/workspaces/:workspaceId/pages/:pageId/revisions', auth, async (req, res) => {
  const workspace = findWorkspace(req.params.workspaceId, req.user.sub)
  if (!workspace) return res.status(404).json({ message: '工作区不存在' })
  try {
    res.json(await workspaceStorage.listRevisions(workspace, req.params.pageId))
  } catch (error) { handleError(res, error) }
})

app.get('/api/v1/workspaces/:workspaceId/pages/:pageId/revisions/:revisionId', auth, async (req, res) => {
  const workspace = findWorkspace(req.params.workspaceId, req.user.sub)
  if (!workspace) return res.status(404).json({ message: '工作区不存在' })
  try {
    res.json(await workspaceStorage.readRevision(workspace, req.params.pageId, req.params.revisionId))
  } catch (error) { handleError(res, error) }
})

app.put('/api/v1/workspaces/:workspaceId/pages/:pageId/assets/:assetName', auth, express.raw({ type: 'application/octet-stream', limit: '20mb' }), async (req, res) => {
  const workspace = findWorkspace(req.params.workspaceId, req.user.sub)
  if (!workspace) return res.status(404).json({ message: '工作区不存在' })
  try {
    const data = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body ?? [])
    const assetName = await workspaceStorage.saveAsset(workspace, req.params.pageId, req.params.assetName, data)
    res.status(201).json({ assetName })
  } catch (error) { handleError(res, error) }
})

app.get('/api/v1/workspaces/:workspaceId/pages/:pageId/assets/:assetName', auth, async (req, res) => {
  const workspace = findWorkspace(req.params.workspaceId, req.user.sub)
  if (!workspace) return res.status(404).json({ message: '工作区不存在' })
  try {
    const data = await workspaceStorage.readAsset(workspace, req.params.pageId, req.params.assetName)
    res.setHeader('content-type', mimeFromAssetName(req.params.assetName))
    res.send(data)
  } catch (error) { handleError(res, error) }
})

app.get('/api/v1/workspaces/:workspaceId/pages/:pageId/assets', auth, async (req, res) => {
  const workspace = findWorkspace(req.params.workspaceId, req.user.sub)
  if (!workspace) return res.status(404).json({ message: '工作区不存在' })
  try {
    res.json({ assets: await workspaceStorage.listAssets(workspace, req.params.pageId) })
  } catch (error) { handleError(res, error) }
})

app.get('/api/v1/workspaces/:workspaceId/files', auth, (req, res) => {
  const workspace = findWorkspace(req.params.workspaceId, req.user.sub)
  if (!workspace) return res.status(404).json({ message: '工作区不存在' })
  res.json({ files: listWorkspaceFiles(workspace.id) })
})

app.get('/api/v1/workspaces/:workspaceId/files/:fileId', auth, (req, res) => {
  const workspace = findWorkspace(req.params.workspaceId, req.user.sub)
  if (!workspace) return res.status(404).json({ message: '工作区不存在' })
  try {
    res.json(getWorkspaceFile(workspace.id, req.params.fileId))
  } catch (error) { handleError(res, error) }
})

app.put('/api/v1/workspaces/:workspaceId/files/:fileId', auth, (req, res) => {
  const workspace = findWorkspace(req.params.workspaceId, req.user.sub)
  if (!workspace) return res.status(404).json({ message: '工作区不存在' })
  try {
    res.json(upsertWorkspaceFileMeta(workspace.id, { ...req.body, id: req.params.fileId }))
  } catch (error) { handleError(res, error) }
})

app.put('/api/v1/workspaces/:workspaceId/files/:fileId/blob/:blobName', auth, express.raw({ type: 'application/octet-stream', limit: '20mb' }), (req, res) => {
  const workspace = findWorkspace(req.params.workspaceId, req.user.sub)
  if (!workspace) return res.status(404).json({ message: '工作区不存在' })
  try {
    const data = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body ?? [])
    const blobName = saveWorkspaceFileBlob(workspace.id, req.params.fileId, req.params.blobName, data)
    res.status(201).json({ blobName })
  } catch (error) { handleError(res, error) }
})

app.get('/api/v1/workspaces/:workspaceId/files/:fileId/blob', auth, (req, res) => {
  const workspace = findWorkspace(req.params.workspaceId, req.user.sub)
  if (!workspace) return res.status(404).json({ message: '工作区不存在' })
  try {
    const blob = readWorkspaceFileBlob(workspace.id, req.params.fileId)
    res.setHeader('content-type', 'application/octet-stream')
    res.setHeader('content-disposition', `attachment; filename="${blob.name}"`)
    res.send(blob.data)
  } catch (error) { handleError(res, error) }
})

app.post('/api/v1/ai/suggest-tags', auth, async (req, res) => {
  try {
    const result = await suggestTags({
      title: String(req.body.title ?? ''),
      markdown: String(req.body.markdown ?? ''),
      existingTags: Array.isArray(req.body.existingTags) ? req.body.existingTags : [],
      workspaceTags: Array.isArray(req.body.workspaceTags) ? req.body.workspaceTags : [],
    })
    res.json(result)
  } catch (error) { handleError(res, error) }
  })

  return app
}
