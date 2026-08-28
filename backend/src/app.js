import bcrypt from 'bcryptjs'
import cors from 'cors'
import express from 'express'
import jwt from 'jsonwebtoken'
import crypto from 'node:crypto'
import fs from 'node:fs'
import { parsePage } from './page-format.js'
import { store } from './store.js'
import {
  archiveProviderRevision,
  createS3Client,
  deleteProviderPages,
  getProviderAsset,
  getProviderPage,
  getProviderRevision,
  listProviderPageIds,
  listProviderRevisions,
  listProviderAssetNames,
  putProviderAsset,
  putProviderPage,
} from './s3.js'
import {
  deleteWorkspacePageAssets,
  listWorkspacePageAssets,
  readWorkspacePageAsset,
  saveWorkspacePageAsset,
} from './workspace-assets.js'
import {
  deleteWorkspacePages,
  getWorkspacePage,
  listWorkspacePages,
  listWorkspaceRevisions,
  readWorkspaceRevision,
  saveWorkspacePage,
} from './workspace-pages.js'
import { assertAssetPayload, mimeFromAssetName, sanitizeAssetName } from './assets.js'
import { suggestTags } from './ai.js'
import { assertProductionReady, createCorsMiddleware, resolveJwtSecret } from './config.js'

export function createApp(options = {}) {
  const jwtSecret = resolveJwtSecret(options)
  assertProductionReady({ jwtSecret })
  const app = express()

  app.use(createCorsMiddleware())
  app.use(express.json({ limit: '12mb' }))

function nowIso() { return new Date().toISOString() }
function newId(prefix) { return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}` }

function auth(req, res, next) {
  const header = req.headers.authorization ?? ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : null
  if (!token) return res.status(401).json({ message: '未登录' })
  try {
    req.user = jwt.verify(token, jwtSecret)
    next()
  } catch {
    return res.status(401).json({ message: '登录已失效' })
  }
}

function publicProvider(provider) {
  const { credentials, ...rest } = provider
  return { ...rest, credentialRef: credentials ? provider.id : null }
}

function findProvider(providerId, userId) {
  return store.loadProviders().find((item) => item.id === providerId && item.ownerId === userId)
}

function findWorkspace(workspaceId, userId) {
  return store.loadWorkspaces().find((item) => item.id === workspaceId && item.ownerId === userId)
}

async function loadProviderPage(provider, pageId) {
  const bucket = String(provider.publicConfig.bucket ?? '')
  const client = createS3Client(provider.publicConfig, provider.credentials)
  const content = await getProviderPage(client, bucket, pageId)
  const page = parsePage(content)
  return { ...page, storageSourceId: `backend-s3:${provider.id}` }
}

async function saveProviderPageRecord(provider, page, expectedUpdatedAt) {
  const bucket = String(provider.publicConfig.bucket ?? '')
  const client = createS3Client(provider.publicConfig, provider.credentials)
  if (expectedUpdatedAt) {
    try {
      const current = await loadProviderPage(provider, page.id)
      if (current.updatedAt !== expectedUpdatedAt) {
        return resConflict()
      }
      if (current.markdown !== page.markdown || current.title !== page.title) {
        await archiveProviderRevision(client, bucket, current)
      }
    } catch (error) {
      if (error?.name !== 'NoSuchKey' && !String(error?.message ?? '').includes('NoSuchKey')) {
        if (expectedUpdatedAt) throw error
      }
    }
  }
  const next = { ...page, storageSourceId: `backend-s3:${provider.id}`, updatedAt: page.updatedAt || nowIso() }
  await putProviderPage(client, bucket, next)
  return next
}

function resConflict() {
  const error = new Error('页面已在其他设备更新，请重新载入后再保存')
  error.status = 409
  throw error
}

function handleError(res, error) {
  const status = error.status ?? 500
  res.status(status).json({ message: error.message ?? '服务器错误' })
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'tie-backend', time: nowIso() })
})

app.post('/api/v1/auth/register', async (req, res) => {
  try {
    const email = String(req.body.email ?? '').trim().toLowerCase()
    const password = String(req.body.password ?? '')
    const name = String(req.body.name ?? '').trim() || email.split('@')[0]
    if (!email || password.length < 6) return res.status(400).json({ message: '邮箱或密码无效' })
    const users = store.loadUsers()
    if (users.some((user) => user.email === email)) return res.status(409).json({ message: '邮箱已注册' })
    const user = { id: newId('usr'), email, name, passwordHash: await bcrypt.hash(password, 10), createdAt: nowIso() }
    users.push(user)
    store.saveUsers(users)
    const accessToken = jwt.sign({ sub: user.id, email: user.email }, jwtSecret, { expiresIn: '30d' })
    res.json({ accessToken, tokenType: 'Bearer', user: { id: user.id, email: user.email, name: user.name, createdAt: user.createdAt } })
  } catch (error) { handleError(res, error) }
})

app.post('/api/v1/auth/login', async (req, res) => {
  try {
    const email = String(req.body.email ?? '').trim().toLowerCase()
    const password = String(req.body.password ?? '')
    const user = store.loadUsers().find((item) => item.email === email)
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      return res.status(401).json({ message: '邮箱或密码错误' })
    }
    const accessToken = jwt.sign({ sub: user.id, email: user.email }, jwtSecret, { expiresIn: '30d' })
    res.json({ accessToken, tokenType: 'Bearer', user: { id: user.id, email: user.email, name: user.name, createdAt: user.createdAt } })
  } catch (error) { handleError(res, error) }
})

app.get('/api/v1/me', auth, (req, res) => {
  const user = store.loadUsers().find((item) => item.id === req.user.sub)
  if (!user) return res.status(401).json({ message: '用户不存在' })
  res.json({ id: user.id, email: user.email, name: user.name, createdAt: user.createdAt })
})

app.get('/api/v1/workspaces', auth, (req, res) => {
  const workspaces = store.loadWorkspaces().filter((item) => item.ownerId === req.user.sub)
  res.json(workspaces)
})

app.post('/api/v1/workspaces', auth, (req, res) => {
  const name = String(req.body.name ?? '').trim()
  if (!name) return res.status(400).json({ message: '工作区名称不能为空' })
  const workspace = { id: newId('ws'), name, ownerId: req.user.sub, createdAt: nowIso() }
  const workspaces = store.loadWorkspaces()
  workspaces.push(workspace)
  store.saveWorkspaces(workspaces)
  res.status(201).json(workspace)
})

app.patch('/api/v1/workspaces/:workspaceId', auth, (req, res) => {
  const workspace = findWorkspace(req.params.workspaceId, req.user.sub)
  if (!workspace) return res.status(404).json({ message: '工作区不存在' })
  const name = String(req.body.name ?? '').trim()
  if (!name) return res.status(400).json({ message: '工作区名称不能为空' })
  workspace.name = name
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
  res.status(204).end()
})

app.get('/api/v1/providers', auth, (req, res) => {
  const providers = store.loadProviders()
    .filter((item) => item.ownerId === req.user.sub)
    .map(publicProvider)
  res.json(providers)
})

app.post('/api/v1/providers', auth, (req, res) => {
  const name = String(req.body.name ?? '').trim()
  const kind = String(req.body.kind ?? 's3')
  const publicConfig = req.body.publicConfig ?? {}
  const credentials = req.body.credentials ?? null
  if (!name) return res.status(400).json({ message: 'Provider 名称不能为空' })
  if (kind === 's3' && (!publicConfig.endpoint || !publicConfig.bucket || !credentials?.accessKey || !credentials?.secretKey)) {
    return res.status(400).json({ message: 'S3 Provider 需要 endpoint、bucket 和凭据' })
  }
  const provider = {
    id: newId('prov'),
    workspaceId: String(req.body.workspaceId ?? ''),
    ownerId: req.user.sub,
    name,
    kind,
    publicConfig,
    credentials: kind === 's3' ? credentials : null,
    createdAt: nowIso(),
  }
  const providers = store.loadProviders()
  providers.push(provider)
  store.saveProviders(providers)
  res.status(201).json(publicProvider(provider))
})

app.patch('/api/v1/providers/:providerId', auth, (req, res) => {
  const provider = findProvider(req.params.providerId, req.user.sub)
  if (!provider) return res.status(404).json({ message: 'Provider 不存在' })
  const name = req.body.name !== undefined ? String(req.body.name).trim() : provider.name
  if (!name) return res.status(400).json({ message: 'Provider 名称不能为空' })
  provider.name = name
  if (req.body.publicConfig && typeof req.body.publicConfig === 'object') {
    provider.publicConfig = { ...provider.publicConfig, ...req.body.publicConfig }
  }
  if (req.body.credentials?.accessKey && req.body.credentials?.secretKey) {
    provider.credentials = req.body.credentials
  }
  const providers = store.loadProviders().map((item) => item.id === provider.id ? provider : item)
  store.saveProviders(providers)
  res.json(publicProvider(provider))
})

app.delete('/api/v1/providers/:providerId', auth, (req, res) => {
  const provider = findProvider(req.params.providerId, req.user.sub)
  if (!provider) return res.status(404).json({ message: 'Provider 不存在' })
  store.saveProviders(store.loadProviders().filter((item) => item.id !== provider.id))
  res.status(204).end()
})

app.get('/api/v1/providers/:providerId/health', auth, async (req, res) => {
  try {
    const provider = findProvider(req.params.providerId, req.user.sub)
    if (!provider || provider.kind !== 's3') return res.status(404).json({ message: 'Provider 不存在' })
    const client = createS3Client(provider.publicConfig, provider.credentials)
    await listProviderPageIds(client, String(provider.publicConfig.bucket ?? ''))
    res.json({ ok: true })
  } catch (error) { handleError(res, error) }
})

app.get('/api/v1/workspaces/:workspaceId/pages', auth, (req, res) => {
  const workspace = findWorkspace(req.params.workspaceId, req.user.sub)
  if (!workspace) return res.status(404).json({ message: '工作区不存在' })
  res.json(listWorkspacePages(workspace.id, `backend:${workspace.id}`))
})

app.get('/api/v1/workspaces/:workspaceId/pages/:pageId', auth, (req, res) => {
  const workspace = findWorkspace(req.params.workspaceId, req.user.sub)
  if (!workspace) return res.status(404).json({ message: '工作区不存在' })
  try {
    res.json(getWorkspacePage(workspace.id, req.params.pageId, `backend:${workspace.id}`))
  } catch (error) { handleError(res, error) }
})

app.put('/api/v1/workspaces/:workspaceId/pages/:pageId', auth, (req, res) => {
  const workspace = findWorkspace(req.params.workspaceId, req.user.sub)
  if (!workspace) return res.status(404).json({ message: '工作区不存在' })
  try {
    const expectedUpdatedAt = req.headers['if-unmodified-since']
    const saved = saveWorkspacePage(workspace.id, {
      ...req.body,
      id: req.params.pageId,
      storageSourceId: `backend:${workspace.id}`,
    }, expectedUpdatedAt)
    res.json(saved)
  } catch (error) { handleError(res, error) }
})

app.post('/api/v1/workspaces/:workspaceId/pages', auth, (req, res) => {
  const workspace = findWorkspace(req.params.workspaceId, req.user.sub)
  if (!workspace) return res.status(404).json({ message: '工作区不存在' })
  deleteWorkspacePages(workspace.id, req.body.pageIds ?? [])
  res.status(204).end()
})

app.get('/api/v1/workspaces/:workspaceId/pages/:pageId/revisions', auth, (req, res) => {
  const workspace = findWorkspace(req.params.workspaceId, req.user.sub)
  if (!workspace) return res.status(404).json({ message: '工作区不存在' })
  res.json(listWorkspaceRevisions(workspace.id, req.params.pageId))
})

app.get('/api/v1/workspaces/:workspaceId/pages/:pageId/revisions/:revisionId', auth, (req, res) => {
  const workspace = findWorkspace(req.params.workspaceId, req.user.sub)
  if (!workspace) return res.status(404).json({ message: '工作区不存在' })
  try {
    res.json(readWorkspaceRevision(workspace.id, req.params.pageId, req.params.revisionId, `backend:${workspace.id}`))
  } catch (error) { handleError(res, error) }
})

app.put('/api/v1/workspaces/:workspaceId/pages/:pageId/assets/:assetName', auth, express.raw({ type: 'application/octet-stream', limit: '20mb' }), (req, res) => {
  const workspace = findWorkspace(req.params.workspaceId, req.user.sub)
  if (!workspace) return res.status(404).json({ message: '工作区不存在' })
  try {
    const data = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body ?? [])
    const assetName = saveWorkspacePageAsset(workspace.id, req.params.pageId, req.params.assetName, data)
    res.status(201).json({ assetName })
  } catch (error) { handleError(res, error) }
})

app.get('/api/v1/workspaces/:workspaceId/pages/:pageId/assets/:assetName', auth, (req, res) => {
  const workspace = findWorkspace(req.params.workspaceId, req.user.sub)
  if (!workspace) return res.status(404).json({ message: '工作区不存在' })
  try {
    const data = readWorkspacePageAsset(workspace.id, req.params.pageId, req.params.assetName)
    res.setHeader('content-type', mimeFromAssetName(req.params.assetName))
    res.send(data)
  } catch (error) { handleError(res, error) }
})

app.get('/api/v1/workspaces/:workspaceId/pages/:pageId/assets', auth, (req, res) => {
  const workspace = findWorkspace(req.params.workspaceId, req.user.sub)
  if (!workspace) return res.status(404).json({ message: '工作区不存在' })
  res.json({ assets: listWorkspacePageAssets(workspace.id, req.params.pageId) })
})

app.get('/api/v1/providers/:providerId/pages', auth, async (req, res) => {
  try {
    const provider = findProvider(req.params.providerId, req.user.sub)
    if (!provider || provider.kind !== 's3') return res.status(404).json({ message: 'Provider 不存在' })
    const client = createS3Client(provider.publicConfig, provider.credentials)
    const bucket = String(provider.publicConfig.bucket ?? '')
    const pageIds = await listProviderPageIds(client, bucket)
    const pages = []
    for (const pageId of pageIds) {
      pages.push(await loadProviderPage(provider, pageId))
    }
    res.json(pages)
  } catch (error) { handleError(res, error) }
})

app.get('/api/v1/providers/:providerId/pages/:pageId', auth, async (req, res) => {
  try {
    const provider = findProvider(req.params.providerId, req.user.sub)
    if (!provider || provider.kind !== 's3') return res.status(404).json({ message: 'Provider 不存在' })
    res.json(await loadProviderPage(provider, req.params.pageId))
  } catch (error) { handleError(res, error) }
})

app.put('/api/v1/providers/:providerId/pages/:pageId', auth, async (req, res) => {
  try {
    const provider = findProvider(req.params.providerId, req.user.sub)
    if (!provider || provider.kind !== 's3') return res.status(404).json({ message: 'Provider 不存在' })
    const expectedUpdatedAt = req.headers['if-unmodified-since']
    const saved = await saveProviderPageRecord(provider, { ...req.body, id: req.params.pageId }, expectedUpdatedAt)
    res.json(saved)
  } catch (error) { handleError(res, error) }
})

app.post('/api/v1/providers/:providerId/pages', auth, async (req, res) => {
  try {
    const provider = findProvider(req.params.providerId, req.user.sub)
    if (!provider || provider.kind !== 's3') return res.status(404).json({ message: 'Provider 不存在' })
    const client = createS3Client(provider.publicConfig, provider.credentials)
    await deleteProviderPages(client, String(provider.publicConfig.bucket ?? ''), req.body.pageIds ?? [])
    res.status(204).end()
  } catch (error) { handleError(res, error) }
})

app.get('/api/v1/providers/:providerId/pages/:pageId/revisions', auth, async (req, res) => {
  try {
    const provider = findProvider(req.params.providerId, req.user.sub)
    if (!provider || provider.kind !== 's3') return res.status(404).json({ message: 'Provider 不存在' })
    const client = createS3Client(provider.publicConfig, provider.credentials)
    res.json(await listProviderRevisions(client, String(provider.publicConfig.bucket ?? ''), req.params.pageId))
  } catch (error) { handleError(res, error) }
})

app.get('/api/v1/providers/:providerId/pages/:pageId/revisions/:revisionId', auth, async (req, res) => {
  try {
    const provider = findProvider(req.params.providerId, req.user.sub)
    if (!provider || provider.kind !== 's3') return res.status(404).json({ message: 'Provider 不存在' })
    const client = createS3Client(provider.publicConfig, provider.credentials)
    const bucket = String(provider.publicConfig.bucket ?? '')
    const content = await getProviderRevision(client, bucket, req.params.pageId, req.params.revisionId)
    const page = parsePage(content)
    res.json({ ...page, storageSourceId: `backend-s3:${provider.id}` })
  } catch (error) { handleError(res, error) }
})

app.put('/api/v1/providers/:providerId/pages/:pageId/assets/:assetName', auth, express.raw({ type: 'application/octet-stream', limit: '20mb' }), async (req, res) => {
  try {
    const provider = findProvider(req.params.providerId, req.user.sub)
    if (!provider || provider.kind !== 's3') return res.status(404).json({ message: 'Provider 不存在' })
    const data = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body ?? [])
    const assetName = sanitizeAssetName(req.params.assetName)
    assertAssetPayload(data)
    const client = createS3Client(provider.publicConfig, provider.credentials)
    const bucket = String(provider.publicConfig.bucket ?? '')
    await putProviderAsset(client, bucket, req.params.pageId, assetName, data, mimeFromAssetName(assetName))
    res.status(201).json({ assetName })
  } catch (error) { handleError(res, error) }
})

app.get('/api/v1/providers/:providerId/pages/:pageId/assets/:assetName', auth, async (req, res) => {
  try {
    const provider = findProvider(req.params.providerId, req.user.sub)
    if (!provider || provider.kind !== 's3') return res.status(404).json({ message: 'Provider 不存在' })
    const assetName = sanitizeAssetName(req.params.assetName)
    const client = createS3Client(provider.publicConfig, provider.credentials)
    const bucket = String(provider.publicConfig.bucket ?? '')
    const data = await getProviderAsset(client, bucket, req.params.pageId, assetName)
    res.setHeader('content-type', mimeFromAssetName(assetName))
    res.send(data)
  } catch (error) {
    if (error?.name === 'NoSuchKey' || String(error?.message ?? '').includes('NoSuchKey')) {
      return res.status(404).json({ message: '附件不存在' })
    }
    handleError(res, error)
  }
})

app.get('/api/v1/providers/:providerId/pages/:pageId/assets', auth, async (req, res) => {
  try {
    const provider = findProvider(req.params.providerId, req.user.sub)
    if (!provider || provider.kind !== 's3') return res.status(404).json({ message: 'Provider 不存在' })
    const client = createS3Client(provider.publicConfig, provider.credentials)
    const bucket = String(provider.publicConfig.bucket ?? '')
    const assets = await listProviderAssetNames(client, bucket, req.params.pageId)
    res.json({ assets })
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
