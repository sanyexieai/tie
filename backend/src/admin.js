import bcrypt from 'bcryptjs'
import fs from 'node:fs'
import path from 'node:path'
import { enabledAdmins, newId, nowIso, publicUser, userRole } from './accounts.js'
import { deleteWorkspacePages, ensureWorkspaceSolution, getWorkspacePage, listWorkspacePages, saveWorkspacePage } from './workspace-pages.js'
import { deleteMcpTokensForUser, deleteMcpTokensForWorkspace } from './mcp-tokens.js'
import { watchWorkspace } from './live.js'
import { store } from './store.js'

function fail(message, status = 400) {
  const error = new Error(message)
  error.status = status
  throw error
}

function directorySize(dir) {
  if (!fs.existsSync(dir)) return 0
  let total = 0
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) total += directorySize(full)
    else total += fs.statSync(full).size
  }
  return total
}

function summarizePage(page) {
  return {
    id: page.id,
    title: page.title || '无标题',
    updatedAt: page.updatedAt ?? null,
    deletedAt: page.deletedAt ?? null,
    tags: Array.isArray(page.tags) ? page.tags : [],
  }
}

function ownerOf(users, ownerId) {
  return users.find((item) => item.id === ownerId) ?? null
}

function workspaceRecord(workspace, users) {
  const owner = ownerOf(users, workspace.ownerId)
  let pages = []
  try {
    pages = listWorkspacePages(workspace.id)
  } catch {
    pages = []
  }
  return {
    id: workspace.id,
    name: workspace.name,
    ownerId: workspace.ownerId,
    ownerEmail: owner?.email ?? null,
    ownerName: owner?.name ?? null,
    createdAt: workspace.createdAt,
    storage: 'disk',
    pageCount: pages.length,
    activePageCount: pages.filter((page) => !page.deletedAt).length,
    trashedPageCount: pages.filter((page) => page.deletedAt).length,
    bytes: directorySize(store.workspaceDir(workspace.id)),
    serverPath: path.resolve(store.workspaceDir(workspace.id)),
  }
}

function createWorkspace(name, ownerId) {
  const trimmed = String(name ?? '').trim()
  if (!trimmed) fail('工作区名称不能为空')
  const users = store.loadUsers()
  const owner = users.find((item) => item.id === ownerId)
  if (!owner) fail('用户不存在', 404)
  if (owner.disabled) fail('不能给已停用的用户新建工作区', 409)
  const workspace = { id: newId('ws'), name: trimmed, ownerId: owner.id, createdAt: nowIso() }
  const workspaces = store.loadWorkspaces()
  workspaces.push(workspace)
  store.saveWorkspaces(workspaces)
  fs.mkdirSync(store.workspacePagesDir(workspace.id), { recursive: true })
  fs.mkdirSync(path.join(store.workspaceDir(workspace.id), '.tie'), { recursive: true })
  ensureWorkspaceSolution(workspace.id, workspace.name)
  watchWorkspace(workspace.id)
  return workspaceRecord(workspace, users)
}

function removeWorkspaceFiles(workspaceId) {
  const dir = store.workspaceDir(workspaceId)
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true })
}

function assertStillHasAdmin(users) {
  if (enabledAdmins(users).length === 0) fail('至少保留一名可用的管理员', 409)
}

export function mountAdmin(app, { auth, adminOnly, handleError }) {
  const guard = [auth, adminOnly]

  app.get('/api/v1/admin/overview', ...guard, (_req, res) => {
    const users = store.loadUsers()
    const workspaces = store.loadWorkspaces()
    let pages = 0
    let activePages = 0
    let trashedPages = 0
    for (const workspace of workspaces) {
      try {
        const list = listWorkspacePages(workspace.id)
        pages += list.length
        activePages += list.filter((page) => !page.deletedAt).length
        trashedPages += list.filter((page) => page.deletedAt).length
      } catch {
        // 单个工作区读失败时跳过，概览仍返回其余数字
      }
    }
    const recentUsers = [...users]
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .slice(0, 5)
      .map((item) => ({
        ...publicUser(item),
        workspaceCount: workspaces.filter((workspace) => workspace.ownerId === item.id).length,
      }))
    const recentWorkspaces = [...workspaces]
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .slice(0, 5)
      .map((item) => workspaceRecord(item, users))
    res.json({
      users: users.length,
      admins: users.filter((item) => userRole(item) === 'admin').length,
      disabledUsers: users.filter((item) => item.disabled).length,
      workspaces: workspaces.length,
      providers: store.loadProviders().length,
      pages,
      activePages,
      trashedPages,
      bytes: directorySize(store.root),
      recentUsers,
      recentWorkspaces,
    })
  })

  app.get('/api/v1/admin/users', ...guard, (req, res) => {
    const query = String(req.query.q ?? '').trim().toLowerCase()
    const status = String(req.query.status ?? '').trim()
    const workspaces = store.loadWorkspaces()
    const users = store.loadUsers()
      .filter((item) => {
        if (status === 'disabled' && !item.disabled) return false
        if (status === 'admin' && userRole(item) !== 'admin') return false
        if (status === 'active' && item.disabled) return false
        if (!query) return true
        return item.email.toLowerCase().includes(query) || String(item.name ?? '').toLowerCase().includes(query)
      })
      .map((item) => ({
        ...publicUser(item),
        workspaceCount: workspaces.filter((workspace) => workspace.ownerId === item.id).length,
      }))
    res.json(users)
  })

  app.post('/api/v1/admin/users', ...guard, async (req, res) => {
    try {
      const email = String(req.body.email ?? '').trim().toLowerCase()
      const password = String(req.body.password ?? '')
      const name = String(req.body.name ?? '').trim() || email.split('@')[0]
      const role = req.body.role === 'admin' ? 'admin' : 'user'
      if (!email || !email.includes('@') || password.length < 6) fail('邮箱或密码无效')
      const users = store.loadUsers()
      if (users.some((item) => item.email === email)) fail('邮箱已注册', 409)
      const user = {
        id: newId('usr'),
        email,
        name,
        passwordHash: await bcrypt.hash(password, 10),
        role,
        disabled: false,
        createdAt: nowIso(),
      }
      users.push(user)
      store.saveUsers(users)
      res.status(201).json(publicUser(user))
    } catch (error) { handleError(res, error) }
  })

  app.patch('/api/v1/admin/users/:userId', ...guard, async (req, res) => {
    try {
      const users = store.loadUsers()
      const user = users.find((item) => item.id === req.params.userId)
      if (!user) fail('用户不存在', 404)
      const self = user.id === req.account.id
      if (req.body.email !== undefined) {
        const email = String(req.body.email ?? '').trim().toLowerCase()
        if (!email || !email.includes('@')) fail('邮箱无效')
        if (users.some((item) => item.email === email && item.id !== user.id)) fail('邮箱已注册', 409)
        user.email = email
      }
      if (req.body.name !== undefined) {
        const name = String(req.body.name ?? '').trim()
        if (!name) fail('名称不能为空')
        user.name = name
      }
      if (req.body.role !== undefined) {
        const role = req.body.role === 'admin' ? 'admin' : 'user'
        if (self && role !== 'admin') fail('不能降级自己的管理员账号', 409)
        user.role = role
      }
      if (req.body.disabled !== undefined) {
        const disabled = Boolean(req.body.disabled)
        if (self && disabled) fail('不能停用自己的账号', 409)
        user.disabled = disabled
      }
      if (req.body.password !== undefined && String(req.body.password) !== '') {
        const password = String(req.body.password)
        if (password.length < 6) fail('密码至少 6 位')
        user.passwordHash = await bcrypt.hash(password, 10)
      }
      assertStillHasAdmin(users)
      store.saveUsers(users)
      res.json(publicUser(user))
    } catch (error) { handleError(res, error) }
  })

  app.delete('/api/v1/admin/users/:userId', ...guard, (req, res) => {
    try {
      const users = store.loadUsers()
      const user = users.find((item) => item.id === req.params.userId)
      if (!user) fail('用户不存在', 404)
      if (user.id === req.account.id) fail('不能删除自己的账号', 409)
      const remaining = users.filter((item) => item.id !== user.id)
      assertStillHasAdmin(remaining)
      const owned = store.loadWorkspaces().filter((item) => item.ownerId === user.id)
      for (const workspace of owned) removeWorkspaceFiles(workspace.id)
      store.saveWorkspaces(store.loadWorkspaces().filter((item) => item.ownerId !== user.id))
      store.saveProviders(store.loadProviders().filter((item) => item.ownerId !== user.id))
      deleteMcpTokensForUser(user.id)
      store.saveUsers(remaining)
      res.status(204).end()
    } catch (error) { handleError(res, error) }
  })

  app.get('/api/v1/admin/users/:userId', ...guard, (req, res) => {
    const users = store.loadUsers()
    const user = users.find((item) => item.id === req.params.userId)
    if (!user) return res.status(404).json({ message: '用户不存在' })
    const workspaces = store.loadWorkspaces()
      .filter((item) => item.ownerId === user.id)
      .map((item) => workspaceRecord(item, users))
    res.json({
      ...publicUser(user),
      workspaceCount: workspaces.length,
      workspaces,
    })
  })

  app.get('/api/v1/admin/workspaces', ...guard, (req, res) => {
    const query = String(req.query.q ?? '').trim().toLowerCase()
    const users = store.loadUsers()
    const items = store.loadWorkspaces()
      .map((item) => workspaceRecord(item, users))
      .filter((item) => {
        if (!query) return true
        return [item.name, item.id, item.ownerEmail, item.ownerName]
          .some((value) => String(value ?? '').toLowerCase().includes(query))
      })
    res.json(items)
  })

  app.post('/api/v1/admin/workspaces', ...guard, (req, res) => {
    try {
      res.status(201).json(createWorkspace(req.body.name, String(req.body.ownerId ?? '').trim()))
    } catch (error) { handleError(res, error) }
  })

  app.get('/api/v1/admin/workspaces/:workspaceId', ...guard, (req, res) => {
    const workspace = store.loadWorkspaces().find((item) => item.id === req.params.workspaceId)
    if (!workspace) return res.status(404).json({ message: '工作区不存在' })
    const record = workspaceRecord(workspace, store.loadUsers())
    let pages = []
    try {
      pages = listWorkspacePages(workspace.id).map(summarizePage)
    } catch (error) {
      return res.status(500).json({ message: error.message ?? '无法读取页面' })
    }
    res.json({
      ...record,
      pages,
      notice: null,
    })
  })

  app.patch('/api/v1/admin/workspaces/:workspaceId', ...guard, (req, res) => {
    try {
      const workspaces = store.loadWorkspaces()
      const workspace = workspaces.find((item) => item.id === req.params.workspaceId)
      if (!workspace) fail('工作区不存在', 404)
      let changed = false
      if (req.body.name !== undefined) {
        const name = String(req.body.name ?? '').trim()
        if (!name) fail('工作区名称不能为空')
        workspace.name = name
        changed = true
      }
      if (req.body.ownerId !== undefined) {
        const ownerId = String(req.body.ownerId ?? '').trim()
        const owner = store.loadUsers().find((item) => item.id === ownerId)
        if (!owner) fail('用户不存在', 404)
        if (owner.disabled) fail('不能把工作区交给已停用的用户', 409)
        workspace.ownerId = owner.id
        changed = true
      }
      if (!changed) fail('没有要修改的内容')
      store.saveWorkspaces(workspaces)
      res.json(workspaceRecord(workspace, store.loadUsers()))
    } catch (error) { handleError(res, error) }
  })

  app.delete('/api/v1/admin/workspaces/:workspaceId', ...guard, (req, res) => {
    const workspaces = store.loadWorkspaces()
    const workspace = workspaces.find((item) => item.id === req.params.workspaceId)
    if (!workspace) return res.status(404).json({ message: '工作区不存在' })
    removeWorkspaceFiles(workspace.id)
    store.saveWorkspaces(workspaces.filter((item) => item.id !== workspace.id))
    deleteMcpTokensForWorkspace(workspace.id)
    res.status(204).end()
  })

  app.get('/api/v1/admin/workspaces/:workspaceId/pages/:pageId', ...guard, (req, res) => {
    const workspace = store.loadWorkspaces().find((item) => item.id === req.params.workspaceId)
    if (!workspace) return res.status(404).json({ message: '工作区不存在' })
    try {
      const page = getWorkspacePage(workspace.id, req.params.pageId)
      res.json({ ...summarizePage(page), markdown: page.markdown ?? '' })
    } catch {
      res.status(404).json({ message: '页面不存在' })
    }
  })

  app.post('/api/v1/admin/workspaces/:workspaceId/pages/:pageId/restore', ...guard, (req, res) => {
    const workspace = store.loadWorkspaces().find((item) => item.id === req.params.workspaceId)
    if (!workspace) return res.status(404).json({ message: '工作区不存在' })
    try {
      const page = getWorkspacePage(workspace.id, req.params.pageId)
      if (!page.deletedAt) return res.json(summarizePage(page))
      const saved = saveWorkspacePage(workspace.id, { ...page, deletedAt: null, updatedAt: nowIso() })
      res.json(summarizePage(saved))
    } catch (error) {
      if (error.message === '页面不存在') return res.status(404).json({ message: '页面不存在' })
      handleError(res, error)
    }
  })

  app.delete('/api/v1/admin/workspaces/:workspaceId/pages/:pageId', ...guard, (req, res) => {
    const workspace = store.loadWorkspaces().find((item) => item.id === req.params.workspaceId)
    if (!workspace) return res.status(404).json({ message: '工作区不存在' })
    try {
      getWorkspacePage(workspace.id, req.params.pageId)
    } catch {
      return res.status(404).json({ message: '页面不存在' })
    }
    deleteWorkspacePages(workspace.id, [req.params.pageId])
    res.status(204).end()
  })

  app.get('/api/v1/admin/providers', ...guard, (_req, res) => {
    const users = store.loadUsers()
    const workspaces = store.loadWorkspaces()
    res.json(store.loadProviders().map((item) => {
      const owner = ownerOf(users, item.ownerId)
      const config = item.publicConfig ?? {}
      return {
        id: item.id,
        name: item.name,
        kind: item.kind,
        ownerId: item.ownerId,
        ownerEmail: owner?.email ?? null,
        workspaceId: item.workspaceId ?? null,
        endpoint: config.endpoint ?? null,
        bucket: config.bucket ?? null,
        createdAt: item.createdAt,
        usedBy: workspaces.filter((workspace) => workspace.storageProviderId === item.id).map((workspace) => workspace.id),
      }
    }))
  })

  app.delete('/api/v1/admin/providers/:providerId', ...guard, (req, res) => {
    const providers = store.loadProviders()
    const provider = providers.find((item) => item.id === req.params.providerId)
    if (!provider) return res.status(404).json({ message: '存储连接不存在' })
    const workspaces = store.loadWorkspaces().map((item) => {
      if (item.storageProviderId !== provider.id) return item
      const next = { ...item }
      delete next.storageProviderId
      return next
    })
    store.saveWorkspaces(workspaces)
    store.saveProviders(providers.filter((item) => item.id !== provider.id))
    res.status(204).end()
  })
}
