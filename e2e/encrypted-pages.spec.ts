import { expect, test as base, type BrowserContext, type Locator, type Page } from '@playwright/test'
import { once } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const marker = '-----BEGIN TIE ENCRYPTED MARKDOWN-----'
const password = 'fixture-only-encrypted-document-password-94812'
const title = '服务器加密文档'
const firstMarkdown = '## 部署资料\n\n账号：`private-owner-29581`\n\n```sh\nexport TOKEN=private-token-59281\n```\n\n| 服务 | 环境 |\n| --- | --- |\n| Tie | private-production-59182 |\n'
const secondMarkdown = `${firstMarkdown}\n第二版：private-revision-23841\n`
const privateValues = ['private-owner-29581', 'private-token-59281', 'private-production-59182', 'private-revision-23841', password]
type Backend = { url: string; data: string; workspaceId: string; profile: Record<string, unknown> }

const test = base.extend<{ backend: Backend }>({
  backend: async ({}, use) => {
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'tie-encrypted-pages-'))
    process.env.TIE_DATA_DIR = data
    process.env.NODE_ENV = 'test'
    const { createApp } = await import(pathToFileURL(fileURLToPath(new URL('../backend/src/app.js', import.meta.url))).href)
    const { closeLive } = await import(pathToFileURL(fileURLToPath(new URL('../backend/src/live.js', import.meta.url))).href)
    const server = createApp({ jwtSecret: 'encrypted-pages-browser-test-secret-over-32-characters' }).listen(0, '127.0.0.1')
    try {
      await once(server, 'listening')
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Fixture backend did not bind a port')
      const url = `http://127.0.0.1:${address.port}`
      const registered = await fetch(`${url}/api/v1/auth/register`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Encrypted Owner', email: 'encrypted-owner@example.test', password: 'encrypted-browser-login-password' }),
      })
      expect(registered.status).toBe(200)
      const session = await registered.json()
      const headers = { authorization: `Bearer ${session.accessToken}`, 'content-type': 'application/json' }
      const workspaces = await (await fetch(`${url}/api/v1/workspaces`, { headers })).json()
      const workspaceId = workspaces[0].id
      const stamp = '2026-11-26T00:00:00.000Z'
      const ordinary = await fetch(`${url}/api/v1/workspaces/${workspaceId}/pages/pg_ordinary`, {
        method: 'PUT', headers,
        body: JSON.stringify({ id: 'pg_ordinary', title: '普通文档', markdown: '# 普通文档\n\n普通正文。', icon: '', tags: [], parentId: null, sortKey: 0, createdAt: stamp, updatedAt: stamp, deletedAt: null }),
      })
      expect(ordinary.status).toBe(200)
      await use({ url, data, workspaceId, profile: { endpoint: url, user: session.user, accessToken: session.accessToken,
        refreshToken: session.refreshToken, accessExpiresAt: session.accessExpiresAt } })
    } finally {
      closeLive()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      fs.rmSync(data, { recursive: true, force: true })
    }
  },
})

async function seedBrowser(context: BrowserContext, profile?: Record<string, unknown>) {
  await context.addInitScript((profile) => {
    if (sessionStorage.getItem('encrypted-page-test-initialized')) return
    localStorage.clear()
    if (profile) localStorage.setItem('tie-backend-profile-v1', JSON.stringify(profile))
    sessionStorage.setItem('encrypted-page-test-initialized', 'yes')
  }, profile)
}

async function openLocalApp(page: Page) {
  await seedBrowser(page.context())
  await page.route('**/health', (route) => route.fulfill({ json: { ok: true, service: 'tie-backend', mcp: { enabled: false, running: false, url: null } } }))
  await page.goto('/')
  const onboarding = page.getByRole('dialog', { name: '绑定服务器', exact: true })
  await expect(onboarding).toBeVisible()
  await onboarding.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(page.getByRole('textbox', { name: '页面标题', exact: true })).toHaveValue('欢迎使用 Tie')
}

async function beginDocument(page: Page, mobile = false) {
  if (mobile) {
    await page.getByRole('button', { name: '新建凭据页面', exact: true }).click()
  } else {
    await page.getByRole('button', { name: '选择页面类型', exact: true }).click()
    await page.getByRole('menuitem', { name: '凭据页面', exact: true }).click()
  }
  const editor = page.getByRole('main', { name: '加密 Markdown 页面', exact: true })
  await expect(editor).toBeVisible()
  await editor.getByRole('textbox', { name: '页面标题', exact: true }).fill(title)
  await editor.getByLabel('解锁密码', { exact: true }).fill(password)
  await editor.getByLabel('确认密码', { exact: true }).fill(password)
  await editor.getByRole('button', { name: '开始编写', exact: true }).click()
  await expect(editor.locator('.tiptap')).toBeVisible()
  await editor.getByRole('button', { name: /源码/ }).click()
  await editor.getByRole('textbox', { name: 'Markdown 源码', exact: true }).fill(firstMarkdown)
  await editor.getByRole('button', { name: '保存', exact: true }).click()
  await expect(editor.locator('.save-state').getByText('已保存', { exact: true })).toBeVisible()
  await expect(editor.getByRole('button', { name: '保存', exact: true })).toBeDisabled()
  return editor
}

async function sourceEditor(editor: Locator) {
  const textarea = editor.getByRole('textbox', { name: 'Markdown 源码', exact: true })
  if (!await textarea.isVisible()) await editor.getByRole('button', { name: /源码/ }).click()
  await expect(textarea).toBeVisible()
  return textarea
}

async function expectBrowserStorageEncrypted(page: Page) {
  const storage = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))
  for (const value of privateValues) expect(storage).not.toContain(value)
  const snapshot = await page.evaluate(() => JSON.parse(localStorage.getItem('tie-demo-workspace-v1') || '{"pages":[]}'))
  const encrypted = snapshot.pages.find((entry: { title: string }) => entry.title === title)
  expect(encrypted.markdown.startsWith(marker)).toBe(true)
  const revisions = await page.evaluate(() => JSON.parse(localStorage.getItem('tie-demo-page-history-v1') || '{}'))
  for (const revision of revisions[encrypted.id] ?? []) expect(revision.page.markdown.startsWith(marker)).toBe(true)
  return encrypted.id as string
}

test('writes encrypted Markdown locally, restores encrypted history, and unlocks again after refresh', async ({ page }) => {
  await openLocalApp(page)
  const editor = await beginDocument(page)
  const tree = page.getByRole('tree', { name: '我的页面', exact: true })
  await expect(tree.getByRole('treeitem', { name: new RegExp(title) })).toContainText('🔒')
  const textarea = await sourceEditor(editor)
  await expect(textarea).toHaveValue(firstMarkdown)
  await expectBrowserStorageEncrypted(page)

  for (const name of ['服务器加密文档（改名）', title]) {
    page.once('dialog', (dialog) => dialog.accept(name))
    const row = tree.getByRole('treeitem', { name: /服务器加密文档/ })
    await row.hover()
    await row.getByRole('button', { name: '页面操作', exact: true }).click()
    await page.getByTitle('重命名页面', { exact: true }).click()
    await expect(editor.getByRole('textbox', { name: '页面标题', exact: true })).toHaveValue(name)
    await expect(textarea).toHaveValue(firstMarkdown)
  }

  await textarea.fill(secondMarkdown)
  await expect(editor.locator('.save-state').getByText('已保存', { exact: true })).toBeVisible({ timeout: 10_000 })
  await expectBrowserStorageEncrypted(page)
  await editor.getByRole('button', { name: '页面版本历史', exact: true }).click()
  const history = editor.getByLabel('加密页面历史', { exact: true })
  await history.getByRole('button', { name: new RegExp(`${title} ·`) }).first().click()
  await expect(history.locator('pre')).toHaveText(firstMarkdown)
  await history.getByRole('button', { name: '恢复此版本', exact: true }).click()
  await expect(history).toBeHidden()
  await expect(textarea).toHaveValue(firstMarkdown)
  await expectBrowserStorageEncrypted(page)

  await editor.getByRole('button', { name: /源码/ }).click()
  await expect(editor.locator('.tiptap h2')).toHaveText('部署资料')
  await expect(editor.locator('.tiptap table')).toContainText('private-production-59182')
  await expect(editor.locator('.tiptap pre')).toContainText('private-token-59281')
  await page.screenshot({ path: '/tmp/tie-encrypted-page-preview.png', fullPage: true })
  await editor.getByRole('button', { name: '锁定页面', exact: true }).click()
  await expect(editor.getByRole('button', { name: '解锁页面', exact: true })).toBeVisible()
  for (const value of privateValues) await expect(page.locator('body')).not.toContainText(value)
  await editor.getByLabel('解锁密码', { exact: true }).fill('wrong-document-password')
  await editor.getByRole('button', { name: '解锁页面', exact: true }).click()
  await expect(editor.getByRole('alert')).toContainText('无法解密文档')
  await expect(editor.locator('.tiptap')).toHaveCount(0)
  await editor.getByLabel('解锁密码', { exact: true }).fill(password)
  await editor.getByRole('button', { name: '解锁页面', exact: true }).click()
  await expect(await sourceEditor(editor)).toHaveValue(firstMarkdown)

  await page.reload()
  await page.getByRole('dialog', { name: '绑定服务器', exact: true }).getByRole('button', { name: '关闭', exact: true }).click()
  await expect(editor.getByRole('button', { name: '解锁页面', exact: true })).toBeVisible()
  await expect(editor.locator('.tiptap')).toHaveCount(0)
  await editor.getByLabel('解锁密码', { exact: true }).fill(password)
  await editor.getByRole('button', { name: '解锁页面', exact: true }).click()
  await expect(await sourceEditor(editor)).toHaveValue(firstMarkdown)
  await expectBrowserStorageEncrypted(page)
})

test('syncs only ciphertext to the real backend and unlocks the same document on another browser', async ({ page, browser, backend }) => {
  await seedBrowser(page.context(), backend.profile)
  await page.routeWebSocket('**/*', () => {})
  await page.goto('/')
  await expect(page.getByRole('textbox', { name: '页面标题', exact: true })).toHaveValue('普通文档')
  const writes: { markdown: string }[] = []
  page.on('request', (request) => {
    const route = new URL(request.url())
    if (route.origin === backend.url && /\/pages\/[^/]+$/.test(route.pathname) && request.method() === 'PUT') writes.push(request.postDataJSON())
  })
  const editor = await beginDocument(page)
  await expect.poll(() => writes.length).toBeGreaterThan(0)
  const textarea = await sourceEditor(editor)
  await textarea.fill(secondMarkdown)
  await expect.poll(() => writes.length, { timeout: 10_000 }).toBeGreaterThan(1)
  await expect(editor.locator('.save-state').getByText('已保存', { exact: true })).toBeVisible()
  await expect(editor.getByRole('button', { name: '保存', exact: true })).toBeDisabled()
  expect(writes.every((write) => write.markdown.startsWith(marker))).toBe(true)
  for (const value of privateValues) expect(JSON.stringify(writes)).not.toContain(value)
  const root = path.join(backend.data, 'workspaces', backend.workspaceId)
  const files = fs.readdirSync(root, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile())
  for (const file of files) {
    const bytes = fs.readFileSync(path.join(file.parentPath, file.name), 'utf8')
    for (const value of privateValues) expect(bytes).not.toContain(value)
  }
  const context = await browser.newContext({ baseURL: 'http://127.0.0.1:4173' })
  try {
    const login = await fetch(`${backend.url}/api/v1/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'encrypted-owner@example.test', password: 'encrypted-browser-login-password' }),
    })
    expect(login.status).toBe(200)
    const session = await login.json()
    expect(session.accessToken).not.toBe(backend.profile.accessToken)
    await seedBrowser(context, { endpoint: backend.url, user: session.user, accessToken: session.accessToken,
      refreshToken: session.refreshToken, accessExpiresAt: session.accessExpiresAt })
    await context.routeWebSocket('**/*', () => {})
    const second = await context.newPage()
    await second.goto('/')
    await second.getByRole('tree', { name: '我的页面', exact: true }).getByRole('treeitem', { name: new RegExp(title) }).click()
    const remoteEditor = second.getByRole('main', { name: '加密 Markdown 页面', exact: true })
    await expect(remoteEditor.getByRole('button', { name: '解锁页面', exact: true })).toBeVisible()
    await expect(remoteEditor.locator('.tiptap')).toHaveCount(0)
    await remoteEditor.getByLabel('解锁密码', { exact: true }).fill(password)
    await remoteEditor.getByRole('button', { name: '解锁页面', exact: true }).click()
    await expect(await sourceEditor(remoteEditor)).toHaveValue(secondMarkdown)
    await remoteEditor.getByRole('button', { name: '页面版本历史', exact: true }).click()
    const history = remoteEditor.getByLabel('加密页面历史', { exact: true })
    await history.getByRole('button', { name: new RegExp(`${title} ·`) }).first().click()
    await expect(history.locator('pre')).toHaveText(firstMarkdown)
    await history.getByRole('button', { name: '恢复此版本', exact: true }).click()
    await expect(history).toBeHidden()
    await expect(await sourceEditor(remoteEditor)).toHaveValue(firstMarkdown)
  } finally { await context.close() }
})

test('opens a local encrypted Markdown document on mobile without a server login', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await seedBrowser(page.context())
  await page.route('**/health', (route) => route.fulfill({ json: { ok: true, service: 'tie-backend', mcp: { enabled: false } } }))
  await page.goto('/')
  const onboarding = page.getByRole('dialog', { name: '绑定服务器', exact: true })
  await expect(onboarding).toBeVisible()
  await onboarding.getByRole('button', { name: '关闭', exact: true }).click()
  const back = page.getByRole('button', { name: '返回列表', exact: true })
  const create = page.getByRole('button', { name: '新建凭据页面', exact: true })
  await expect(back.or(create)).toBeVisible()
  if (await back.isVisible()) await back.click()
  const editor = await beginDocument(page, true)
  await expect(await sourceEditor(editor)).toHaveValue(firstMarkdown)
  await editor.getByRole('button', { name: /源码/ }).click()
  await expect(editor.locator('.tiptap table')).toContainText('private-production-59182')
  await page.screenshot({ path: '/tmp/tie-encrypted-page-mobile.png', fullPage: true })
  await expectBrowserStorageEncrypted(page)
  await editor.getByRole('button', { name: '锁定页面', exact: true }).click()
  await editor.getByRole('button', { name: '返回列表', exact: true }).click()
  await page.getByRole('treeitem', { name: new RegExp(title) }).click()
  await expect(editor.getByRole('button', { name: '解锁页面', exact: true })).toBeVisible()
})

test('keeps newer title edits while an earlier encrypted autosave response is delayed', async ({ page, backend }) => {
  await seedBrowser(page.context(), backend.profile)
  await page.routeWebSocket('**/*', () => {})
  await page.goto('/')
  await expect(page.getByRole('textbox', { name: '页面标题', exact: true })).toHaveValue('普通文档')
  const editor = await beginDocument(page)
  const titleInput = editor.getByRole('textbox', { name: '页面标题', exact: true })
  const earlierTitle = `${title} B`
  const latestTitle = `${title} C`
  let release!: () => void
  let requested!: () => void
  let held = false
  const responseHeld = new Promise<void>((resolve) => { release = resolve })
  const requestStarted = new Promise<void>((resolve) => { requested = resolve })
  await page.route(`${backend.url}/api/v1/workspaces/${backend.workspaceId}/pages/*`, async (route) => {
    if (held || route.request().method() !== 'PUT' || route.request().postDataJSON().title !== earlierTitle) return route.continue()
    held = true
    const response = await route.fetch()
    requested()
    await responseHeld
    await route.fulfill({ response })
  })
  try {
    await titleInput.fill(earlierTitle)
    await requestStarted
    await titleInput.fill(latestTitle)
  } finally { release() }
  await expect(titleInput).toHaveValue(latestTitle)
  await expect(editor.getByRole('alert')).toHaveCount(0)
  await expect.poll(async () => {
    const response = await fetch(`${backend.url}/api/v1/workspaces/${backend.workspaceId}/pages`, {
      headers: { authorization: `Bearer ${backend.profile.accessToken}` },
    })
    const pages = await response.json() as { title: string }[]
    return pages.some((item) => item.title === latestTitle)
  }, { timeout: 10_000 }).toBe(true)
  await expect(editor.locator('.save-state').getByText('已保存', { exact: true })).toBeVisible()
  await page.reload()
  await page.getByRole('tree', { name: '我的页面', exact: true }).getByRole('treeitem', { name: new RegExp(latestTitle) }).click()
  await editor.getByLabel('解锁密码', { exact: true }).fill(password)
  await editor.getByRole('button', { name: '解锁页面', exact: true }).click()
  await expect(titleInput).toHaveValue(latestTitle)
  await expect(await sourceEditor(editor)).toHaveValue(firstMarkdown)
  await expect(editor.getByRole('alert')).toHaveCount(0)
})

test('preserves a local draft typed while a remote encrypted version is being decrypted', async ({ page, backend }) => {
  await seedBrowser(page.context(), backend.profile)
  await page.routeWebSocket('**/*', () => {})
  await page.goto('/')
  await expect(page.getByRole('textbox', { name: '页面标题', exact: true })).toHaveValue('普通文档')
  const editor = await beginDocument(page)
  const headers = { authorization: `Bearer ${backend.profile.accessToken}`, 'content-type': 'application/json' }
  const list = await (await fetch(`${backend.url}/api/v1/workspaces/${backend.workspaceId}/pages`, { headers })).json()
  const first = list.find((item: { title: string }) => item.title === title)
  expect(first.markdown.startsWith(marker)).toBe(true)
  const textarea = await sourceEditor(editor)
  await textarea.fill(secondMarkdown)
  await expect(editor.locator('.save-state').getByText('已保存', { exact: true })).toBeVisible()
  await page.evaluate(() => {
    const original = crypto.subtle.deriveKey.bind(crypto.subtle)
    let resume!: () => void
    let intercept = true
    const held = new Promise<void>((resolve) => { resume = resolve })
    Object.assign(window, { __encryptedDeriveStarted: false, __resumeEncryptedDerive: () => resume() })
    crypto.subtle.deriveKey = async (...args: Parameters<SubtleCrypto['deriveKey']>) => {
      if (intercept && typeof args[0] === 'object' && args[0].name === 'PBKDF2') {
        intercept = false
        Object.assign(window, { __encryptedDeriveStarted: true })
        await held
      }
      return original(...args)
    }
  })
  const changed = await fetch(`${backend.url}/api/v1/workspaces/${backend.workspaceId}/pages/${first.id}`, {
    method: 'PUT', headers, body: JSON.stringify({ ...first, updatedAt: new Date().toISOString() }),
  })
  expect(changed.status).toBe(200)
  const draft = `${secondMarkdown}\nprivate-local-edit-during-decryption-82174\n`
  try {
    await page.getByRole('button', { name: '同步并载入工作区', exact: true }).click()
    await expect.poll(() => page.evaluate(() => (window as Window & { __encryptedDeriveStarted: boolean }).__encryptedDeriveStarted)).toBe(true)
    await textarea.fill(draft)
  } finally {
    await page.evaluate(() => (window as Window & { __resumeEncryptedDerive: () => void }).__resumeEncryptedDerive())
  }
  await expect(editor.getByRole('alert')).toContainText('当前草稿尚未覆盖新版本')
  await expect(textarea).toHaveValue(draft)
  const stored = await (await fetch(`${backend.url}/api/v1/workspaces/${backend.workspaceId}/pages/${first.id}`, { headers })).json()
  expect(stored.markdown).toBe(first.markdown)
  expect(JSON.stringify(stored)).not.toContain('private-local-edit-during-decryption-82174')
})
