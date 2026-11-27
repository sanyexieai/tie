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
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j8eEAAAAASUVORK5CYII='
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

function documentEditor(page: Page) { return page.locator('main.editor-pane') }

async function saveDocument(page: Page, editor: Locator) {
  await page.keyboard.press('Control+s')
  await expect(editor.locator('.save-state')).not.toContainText(/未保存|保存中|失败/, { timeout: 10_000 })
}

async function expectSource(editor: Locator, markdown: string) {
  const input = await sourceEditor(editor)
  await expect.poll(async () => (await input.inputValue()).trim()).toBe(markdown.trim())
}

async function beginDocument(page: Page, mobile = false) {
  const editor = documentEditor(page)
  if (mobile) {
    await page.getByRole('button', { name: '新建加密页面', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '新建加密页面', exact: true })
    await dialog.getByRole('textbox', { name: '页面标题', exact: true }).fill(title)
    await dialog.getByLabel('解锁密码', { exact: true }).fill(password)
    await dialog.getByLabel('确认密码', { exact: true }).fill(password)
    await dialog.getByRole('button', { name: '创建页面', exact: true }).click()
    await expect(dialog).toBeHidden()
  } else {
    await expect(page.getByRole('button', { name: '选择页面类型', exact: true })).toHaveCount(0)
    await page.locator('.sidebar .new-page-button').click()
    await expect(editor.getByRole('textbox', { name: '页面标题', exact: true })).toHaveValue('无标题')
    await editor.getByRole('textbox', { name: '页面标题', exact: true }).fill(title)
    await saveDocument(page, editor)
    const row = page.getByRole('treeitem', { name: new RegExp(title) })
    await row.hover()
    await row.getByRole('button', { name: '页面操作', exact: true }).click()
    await page.getByRole('menuitem', { name: '转为加密页面', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '转为加密页面', exact: true })
    await dialog.getByLabel('加密密码', { exact: true }).fill(password)
    await dialog.getByLabel('确认加密密码', { exact: true }).fill(password)
    await dialog.getByRole('button', { name: '转为加密页面', exact: true }).click()
    await expect(dialog).toBeHidden()
  }
  await expect(editor.locator('.tiptap').or(editor.getByRole('textbox', { name: 'Markdown 源码', exact: true }))).toBeVisible()
  await (await sourceEditor(editor)).fill(firstMarkdown)
  await saveDocument(page, editor)
  return editor
}

async function restoreFirstRevision(page: Page, editor: Locator) {
  await editor.getByTitle('页面版本历史', { exact: true }).click()
  const history = editor.locator('.history-popover')
  const row = history.locator('.history-revision').first()
  await row.getByRole('button').first().click()
  await expect(history.locator('.revision-preview pre')).toContainText(firstMarkdown.trim())
  page.once('dialog', (dialog) => dialog.accept())
  await row.getByRole('button', { name: '恢复', exact: true }).click()
  await expect(history).toBeHidden()
}

async function sourceEditor(editor: Locator) {
  await expect(editor.getByRole('textbox', { name: '页面标题', exact: true })).toBeVisible()
  const textarea = editor.getByRole('textbox', { name: 'Markdown 源码', exact: true })
  if (!await textarea.isVisible()) await editor.getByRole('button', { name: /源码/ }).click()
  await expect(textarea).toBeVisible()
  return textarea
}

async function richEditor(editor: Locator) {
  await expect(editor.getByRole('textbox', { name: '页面标题', exact: true })).toBeVisible()
  if (await editor.getByRole('textbox', { name: 'Markdown 源码', exact: true }).isVisible()) await editor.getByRole('button', { name: /源码/ }).click()
  const rich = editor.locator('.tiptap')
  await expect(rich).toBeVisible()
  return rich
}

async function backendPages(backend: Backend) {
  return (await (await fetch(`${backend.url}/api/v1/workspaces/${backend.workspaceId}/pages`, {
    headers: { authorization: `Bearer ${backend.profile.accessToken}` },
  })).json()) as { id: string; title: string; parentId: string | null; markdown: string; tags: string[] }[]
}

async function holdPageDecryption(page: Page) {
  await page.evaluate(() => {
    const original = crypto.subtle.decrypt.bind(crypto.subtle)
    let release!: () => void
    let intercept = true
    const held = new Promise<void>((resolve) => { release = resolve })
    Object.assign(window, { __protectedDecryptStarted: false, __protectedDecryptFinished: false, __releaseProtectedDecrypt: () => release() })
    crypto.subtle.decrypt = async (...args: Parameters<SubtleCrypto['decrypt']>) => {
      if (intercept && typeof args[0] === 'object' && args[0].name === 'AES-GCM') {
        intercept = false
        Object.assign(window, { __protectedDecryptStarted: true })
        await held
        const plaintext = await original(...args)
        Object.assign(window, { __protectedDecryptFinished: true })
        return plaintext
      }
      return original(...args)
    }
  })
  return {
    started: () => expect.poll(() => page.evaluate(() => (window as Window & { __protectedDecryptStarted: boolean }).__protectedDecryptStarted)).toBe(true),
    release: () => page.evaluate(() => (window as Window & { __releaseProtectedDecrypt: () => void }).__releaseProtectedDecrypt()),
    finished: () => expect.poll(() => page.evaluate(() => (window as Window & { __protectedDecryptFinished: boolean }).__protectedDecryptFinished)).toBe(true),
  }
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
  await expectSource(editor, firstMarkdown)
  await expectBrowserStorageEncrypted(page)

  for (const name of ['服务器加密文档（改名）', title]) {
    page.once('dialog', (dialog) => dialog.accept(name))
    const row = tree.getByRole('treeitem', { name: /服务器加密文档/ })
    await row.hover()
    await row.getByRole('button', { name: '页面操作', exact: true }).click()
    await page.getByTitle('重命名页面', { exact: true }).click()
    await expect(editor.getByRole('textbox', { name: '页面标题', exact: true })).toHaveValue(name)
    await expectSource(editor, firstMarkdown)
  }

  await textarea.fill(secondMarkdown)
  await saveDocument(page, editor)
  await expectBrowserStorageEncrypted(page)
  await restoreFirstRevision(page, editor)
  await expectSource(editor, firstMarkdown)
  await expectBrowserStorageEncrypted(page)

  await editor.getByRole('button', { name: /源码/ }).click()
  await expect(editor.locator('.tiptap h2')).toHaveText('部署资料')
  await expect(editor.locator('.tiptap table')).toContainText('private-production-59182')
  await expect(editor.locator('.tiptap pre')).toContainText('private-token-59281')
  await page.screenshot({ path: '/tmp/tie-normal-protected-page.png', fullPage: true })
  await editor.getByRole('button', { name: '锁定页面', exact: true }).click()
  await expect(editor.getByRole('button', { name: '解锁页面', exact: true })).toBeVisible()
  for (const value of privateValues) await expect(page.locator('body')).not.toContainText(value)
  await editor.getByLabel('解锁密码', { exact: true }).fill('wrong-document-password')
  await editor.getByRole('button', { name: '解锁页面', exact: true }).click()
  await expect(editor.getByRole('alert')).toContainText('无法解密文档')
  await expect(editor.locator('.tiptap')).toHaveCount(0)
  await editor.getByLabel('解锁密码', { exact: true }).fill(password)
  await editor.getByRole('button', { name: '解锁页面', exact: true }).click()
  await expectSource(editor, firstMarkdown)

  await page.reload()
  await page.getByRole('dialog', { name: '绑定服务器', exact: true }).getByRole('button', { name: '关闭', exact: true }).click()
  await expect(editor.getByRole('button', { name: '解锁页面', exact: true })).toBeVisible()
  await expect(editor.locator('.tiptap')).toHaveCount(0)
  await editor.getByLabel('解锁密码', { exact: true }).fill(password)
  await editor.getByRole('button', { name: '解锁页面', exact: true }).click()
  await expectSource(editor, firstMarkdown)
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
  await saveDocument(page, editor)
  const firstProtected = writes.findIndex((write) => write.markdown.startsWith(marker))
  expect(firstProtected).toBeGreaterThanOrEqual(0)
  expect(writes.slice(firstProtected).every((write) => write.markdown.startsWith(marker))).toBe(true)
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
    const remoteEditor = documentEditor(second)
    await expect(remoteEditor.getByRole('button', { name: '解锁页面', exact: true })).toBeVisible()
    await expect(remoteEditor.locator('.tiptap')).toHaveCount(0)
    await remoteEditor.getByLabel('解锁密码', { exact: true }).fill(password)
    await remoteEditor.getByRole('button', { name: '解锁页面', exact: true }).click()
    await expectSource(remoteEditor, secondMarkdown)
    await restoreFirstRevision(second, remoteEditor)
    await expectSource(remoteEditor, firstMarkdown)
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
  const create = page.getByRole('button', { name: '新建加密页面', exact: true })
  await expect(back.or(create)).toBeVisible()
  if (await back.isVisible()) await back.click()
  const editor = await beginDocument(page, true)
  await expectSource(editor, firstMarkdown)
  await editor.getByRole('button', { name: /源码/ }).click()
  await expect(editor.locator('.tiptap table')).toContainText('private-production-59182')
  await page.screenshot({ path: '/tmp/tie-normal-protected-page-mobile.png', fullPage: true })
  await expectBrowserStorageEncrypted(page)
  await editor.getByRole('button', { name: '锁定页面', exact: true }).click()
  await editor.getByRole('button', { name: '返回列表', exact: true }).click()
  await page.getByRole('treeitem', { name: new RegExp(title) }).click()
  await expect(editor.getByRole('button', { name: '解锁页面', exact: true })).toBeVisible()
})

test('converts a server page through the normal editor and real CLI without uploading its password', async ({ page, backend }) => {
  const cli = process.env.TIE_TEST_CLI || fileURLToPath(new URL(`../src-tauri/target/debug/tie-cli${process.platform === 'win32' ? '.exe' : ''}`, import.meta.url))
  test.skip(!fs.existsSync(cli), 'This conversion uses the real Rust CLI; build tie-cli or provide TIE_TEST_CLI.')
  const headers = { authorization: `Bearer ${backend.profile.accessToken}`, 'content-type': 'application/json' }
  const configured = await fetch(`${backend.url}/api/v1/admin/settings`, { method: 'PUT', headers, body: JSON.stringify({ mcp: { enabled: false, cliPath: cli } }) })
  expect(configured.status).toBe(200)
  await seedBrowser(page.context(), backend.profile)
  await page.routeWebSocket('**/*', () => {})
  await page.goto('/')
  const editor = documentEditor(page)
  await expect(editor.getByRole('textbox', { name: '页面标题', exact: true })).toHaveValue('普通文档')
  await (await sourceEditor(editor)).fill('## 当前资料\n\nfixture-server-conversion-private-body\n')
  await saveDocument(page, editor)
  const before = (await backendPages(backend)).find((item) => item.id === 'pg_ordinary')!
  const writes: unknown[] = []
  page.on('request', (request) => {
    if (request.url().endsWith('/pg_ordinary/protection') && request.method() === 'PUT') writes.push(request.postDataJSON())
  })
  let loseResponse = true
  await page.route('**/pg_ordinary/protection', async (route) => {
    if (route.request().method() !== 'PUT' || !loseResponse) return route.continue()
    loseResponse = false
    const response = await route.fetch()
    expect(response.status()).toBe(200)
    await route.abort('failed')
  })
  const row = page.getByRole('treeitem', { name: /普通文档/ })
  await row.hover()
  await row.getByRole('button', { name: '页面操作', exact: true }).click()
  await page.getByRole('menuitem', { name: '转为加密页面', exact: true }).click()
  const encrypt = page.getByRole('dialog', { name: '转为加密页面', exact: true })
  await encrypt.getByLabel('加密密码', { exact: true }).fill(password)
  await encrypt.getByLabel('确认加密密码', { exact: true }).fill(password)
  await encrypt.getByRole('button', { name: '转为加密页面', exact: true }).click()
  await expect(encrypt.getByRole('alert')).toContainText('无法连接后台')
  expect((await backendPages(backend)).find((item) => item.id === before.id)!.markdown.startsWith(marker)).toBe(true)
  await encrypt.getByLabel('加密密码', { exact: true }).fill(password)
  await encrypt.getByLabel('确认加密密码', { exact: true }).fill(password)
  const retryDecryption = await holdPageDecryption(page)
  try {
    await encrypt.getByRole('button', { name: '转为加密页面', exact: true }).click()
    await retryDecryption.started()
    await expect.poll(() => page.evaluate(() => (document.querySelector('#app') as any).__vue_app__.config.globalProperties.$pinia._s.get('workspace').reloading)).toBe(false)
    const reloaded = page.waitForResponse((response) => response.request().method() === 'GET'
      && new URL(response.url()).pathname === `/api/v1/workspaces/${backend.workspaceId}/pages`)
    await page.evaluate(async () => {
      const workspace = (document.querySelector('#app') as any).__vue_app__.config.globalProperties.$pinia._s.get('workspace')
      await workspace.reloadWorkspace()
    })
    await reloaded
    await expect.poll(() => page.evaluate(() => (document.querySelector('#app') as any).__vue_app__.config.globalProperties.$pinia._s.get('workspace').reloading)).toBe(false)
    await expect(encrypt).toBeVisible()
    expect(await page.evaluate(() => (document.querySelector('#app') as any).__vue_app__.config.globalProperties.$pinia._s.get('workspace').activePage.markdown.startsWith('-----BEGIN TIE ENCRYPTED MARKDOWN-----'))).toBe(false)
  } finally { await retryDecryption.release() }
  await expect(encrypt).toBeHidden({ timeout: 15_000 })
  await expect(editor.locator('.tiptap').or(editor.getByRole('textbox', { name: 'Markdown 源码', exact: true }))).toBeVisible()
  expect(writes).toHaveLength(1)
  expect(JSON.stringify(writes[0])).not.toContain(password)
  expect(JSON.stringify(writes[0])).not.toContain('fixture-server-conversion-private-body')
  const encrypted = (await backendPages(backend)).find((item) => item.id === before.id)!
  expect(encrypted.markdown.startsWith(marker)).toBe(true)
  const bundle = await (await fetch(`${backend.url}/api/v1/workspaces/${backend.workspaceId}/pages/${before.id}/protection`, { headers })).json()
  expect(bundle.revisions.length).toBeGreaterThan(0)
  expect(bundle.revisions.every((entry: { page: { markdown: string } }) => entry.page.markdown.startsWith(marker))).toBe(true)
  for (const entry of fs.readdirSync(path.join(backend.data, 'workspaces', backend.workspaceId), { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile())) {
    const raw = fs.readFileSync(path.join(entry.parentPath, entry.name), 'utf8')
    expect(raw).not.toContain('fixture-server-conversion-private-body')
    expect(raw).not.toContain(password)
  }
  await row.hover()
  await row.getByRole('button', { name: '页面操作', exact: true }).click()
  await page.getByRole('menuitem', { name: '转为普通页面', exact: true }).click()
  const decrypt = page.getByRole('dialog', { name: '转为普通页面', exact: true })
  await decrypt.getByRole('button', { name: '转为普通页面', exact: true }).click()
  await expect(decrypt).toBeHidden({ timeout: 15_000 })
  const ordinary = (await backendPages(backend)).find((item) => item.id === before.id)!
  expect(ordinary.markdown).toBe(before.markdown)
  expect(ordinary.title).toBe(before.title)
  expect(ordinary.tags).toEqual(before.tags)
  expect(JSON.stringify(writes)).not.toContain(password)
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
  await saveDocument(page, editor)
  await page.reload()
  await page.getByRole('tree', { name: '我的页面', exact: true }).getByRole('treeitem', { name: new RegExp(latestTitle) }).click()
  await editor.getByLabel('解锁密码', { exact: true }).fill(password)
  await editor.getByRole('button', { name: '解锁页面', exact: true }).click()
  await expect(titleInput).toHaveValue(latestTitle)
  await expectSource(editor, firstMarkdown)
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
  await saveDocument(page, editor)
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
  await expect(editor.locator('.save-state')).toContainText(/失败|冲突/)
  await expect(textarea).toHaveValue(draft)
  const stored = await (await fetch(`${backend.url}/api/v1/workspaces/${backend.workspaceId}/pages/${first.id}`, { headers })).json()
  expect(stored.markdown).toBe(first.markdown)
  expect(JSON.stringify(stored)).not.toContain('private-local-edit-during-decryption-82174')
})

test('uses ordinary tags, favorite, find, outline and authorized body search on a protected page', async ({ page }) => {
  await openLocalApp(page)
  const editor = await beginDocument(page)
  const tag = editor.getByPlaceholder('添加标签，回车确认')
  await tag.fill('运维')
  await tag.press('Enter')
  await expect(editor.locator('.tag-row')).toContainText('# 运维')
  await editor.getByTitle('收藏页面', { exact: true }).click()
  await expect(editor.getByTitle('取消收藏页面', { exact: true })).toBeVisible()
  await page.keyboard.press('Control+f')
  await editor.getByRole('textbox', { name: '在当前页面查找', exact: true }).fill('private-owner-29581')
  await expect(editor.locator('.document-find')).toContainText('1/1')
  await editor.getByRole('textbox', { name: '替换为', exact: true }).fill('private-owner-replaced-27184')
  await editor.getByRole('button', { name: '全部替换', exact: true }).click()
  await expect.poll(async () => (await sourceEditor(editor)).inputValue()).toContain('private-owner-replaced-27184')
  await saveDocument(page, editor)
  await editor.getByTitle('关闭查找（Esc）', { exact: true }).click()
  await richEditor(editor)
  await expect(page.locator('.context-panel')).toBeVisible()
  await expect(page.locator('.context-panel').getByRole('button', { name: '部署资料', exact: true })).toBeVisible()
  await expect(editor.locator('.encrypted-caption')).toHaveCount(0)
  await expect(editor.getByRole('button', { name: '保存', exact: true })).toHaveCount(0)

  const search = page.locator('.quick-nav').getByRole('button', { name: /搜索/ })
  await search.click()
  await page.getByPlaceholder('搜索标题、标签和正文…').fill('private-token-59281')
  await expect(page.locator('.search-results').getByRole('button', { name: new RegExp(title) })).toBeVisible()
  await page.locator('.search-results').getByRole('button', { name: new RegExp(title) }).click()
  await expect(editor.getByRole('button', { name: '锁定页面', exact: true })).toBeVisible()
  await editor.getByRole('button', { name: '锁定页面', exact: true }).click()
  await search.click()
  await page.getByPlaceholder('搜索标题、标签和正文…').fill('private-token-59281')
  await expect(page.locator('.search-results').getByRole('button')).toHaveCount(0)
  await page.getByPlaceholder('搜索标题、标签和正文…').fill(title)
  await expect(page.locator('.search-results').getByRole('button', { name: new RegExp(title) })).toBeVisible()
  await expect(page.locator('.search-results')).not.toContainText('private-token-59281')
  const storage = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))
  for (const secret of [...privateValues, 'private-owner-replaced-27184']) expect(storage).not.toContain(secret)
})

test('keeps a real uploaded picture inside encrypted Markdown and never writes an ordinary asset', async ({ page, backend }) => {
  await seedBrowser(page.context(), backend.profile)
  await page.routeWebSocket('**/*', () => {})
  await page.goto('/')
  await expect(page.getByRole('textbox', { name: '页面标题', exact: true })).toHaveValue('普通文档')
  const assets: string[] = []
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (url.origin === backend.url && /\/(?:assets|files)\//.test(url.pathname)) assets.push(request.url())
  })
  const editor = await beginDocument(page)
  const rich = await richEditor(editor)
  await rich.click()
  await page.keyboard.press('Control+End')
  await page.keyboard.press('Enter')
  await page.keyboard.insertText('/上传图片')
  const chooser = page.waitForEvent('filechooser')
  await editor.getByRole('listbox', { name: '插入块', exact: true }).getByRole('button').filter({ hasText: '上传图片' }).click()
  await (await chooser).setFiles({ name: 'private-shot.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') })
  const image = editor.locator('img[src^="data:image/png;base64,"]')
  await expect(image).toBeVisible()
  await expect.poll(() => image.evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBe(1)
  await saveDocument(page, editor)
  const stored = (await backendPages(backend)).find((item) => item.title === title)!
  expect(stored.markdown.startsWith(marker)).toBe(true)
  expect(stored.markdown).not.toContain(png)
  expect(assets).toEqual([])
  await page.reload()
  await page.getByRole('treeitem', { name: new RegExp(title) }).click()
  await editor.getByLabel('解锁密码', { exact: true }).fill(password)
  await editor.getByRole('button', { name: '解锁页面', exact: true }).click()
  await richEditor(editor)
  await expect(image).toBeVisible()
  await expect(image).toHaveAttribute('src', `data:image/png;base64,${png}`)
  expect(assets).toEqual([])
  const files = fs.readdirSync(path.join(backend.data, 'workspaces', backend.workspaceId), { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile())
  for (const file of files) expect(fs.readFileSync(path.join(file.parentPath, file.name), 'utf8')).not.toContain(png)
})

test('creates a protected child through the ordinary page command with encryption inherited', async ({ page, backend }) => {
  await seedBrowser(page.context(), backend.profile)
  await page.routeWebSocket('**/*', () => {})
  await page.goto('/')
  await expect(page.getByRole('textbox', { name: '页面标题', exact: true })).toHaveValue('普通文档')
  const editor = await beginDocument(page)
  const parent = (await backendPages(backend)).find((item) => item.title === title)!
  const rich = await richEditor(editor)
  await rich.click()
  await page.keyboard.press('Control+End')
  await page.keyboard.press('Enter')
  await page.keyboard.insertText('/子页面')
  await editor.getByRole('listbox', { name: '插入块', exact: true }).getByRole('button').filter({ hasText: '子页面' }).filter({ hasNotText: '展开' }).click()
  await expect(editor.getByRole('textbox', { name: '页面标题', exact: true })).toHaveValue('无标题')
  const child = (await backendPages(backend)).find((item) => item.parentId === parent.id)!
  expect(child).toBeTruthy()
  expect(child.markdown.startsWith(marker)).toBe(true)
  await editor.getByRole('button', { name: '锁定页面', exact: true }).click()
  await editor.getByLabel('解锁密码', { exact: true }).fill(password)
  await editor.getByRole('button', { name: '解锁页面', exact: true }).click()
  await expect(editor.getByRole('textbox', { name: '页面标题', exact: true })).toHaveValue('无标题')
})

test('keeps history and refresh commands gated while a locked page is being unlocked', async ({ page, backend }) => {
  await seedBrowser(page.context(), backend.profile)
  await page.routeWebSocket('**/*', () => {})
  await page.goto('/')
  await expect(page.getByRole('textbox', { name: '页面标题', exact: true })).toHaveValue('普通文档')
  const editor = await beginDocument(page)
  const stored = (await backendPages(backend)).find((item) => item.title === title)!
  await editor.getByRole('button', { name: '锁定页面', exact: true }).click()
  await expect(editor.getByRole('form', { name: '解锁页面', exact: true })).toBeVisible()
  const reads: string[] = []
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (url.origin === backend.url && request.method() === 'GET'
      && url.pathname.startsWith(`/api/v1/workspaces/${backend.workspaceId}/pages/${stored.id}`)) reads.push(url.pathname)
  })
  const held = await holdPageDecryption(page)
  try {
    await editor.getByLabel('解锁密码', { exact: true }).fill(password)
    await editor.getByRole('button', { name: '解锁页面', exact: true }).click()
    await held.started()
    await page.evaluate(() => {
      for (const name of ['tie:open-page-history', 'tie:refresh-page', 'tie:find-in-page', 'tie:toggle-source-mode']) window.dispatchEvent(new Event(name))
    })
    await expect(editor.locator('.history-popover, .document-find')).toHaveCount(0)
    await expect(editor.getByRole('textbox', { name: 'Markdown 源码', exact: true })).toHaveCount(0)
    await expect(editor.getByRole('button', { name: '正在解锁…', exact: true })).toBeDisabled()
    expect(reads).toEqual([])
  } finally { await held.release() }
  await expectSource(editor, firstMarkdown)
  await expect(editor.getByRole('alert')).toHaveCount(0)
  expect(reads).toEqual([])
})

test('discards a completed decryption after leaving so body search cannot gain late authorization', async ({ page, backend }) => {
  await seedBrowser(page.context(), backend.profile)
  await page.routeWebSocket('**/*', () => {})
  await page.goto('/')
  await expect(page.getByRole('textbox', { name: '页面标题', exact: true })).toHaveValue('普通文档')
  const editor = await beginDocument(page)
  await editor.getByRole('button', { name: '锁定页面', exact: true }).click()
  const held = await holdPageDecryption(page)
  try {
    await editor.getByLabel('解锁密码', { exact: true }).fill(password)
    await editor.getByRole('button', { name: '解锁页面', exact: true }).click()
    await held.started()
    await page.getByRole('treeitem', { name: /普通文档/ }).click()
    await expect(editor.getByRole('textbox', { name: '页面标题', exact: true })).toHaveValue('普通文档')
  } finally { await held.release() }
  await held.finished()
  await page.locator('.quick-nav').getByRole('button', { name: /搜索/ }).click()
  await page.getByPlaceholder('搜索标题、标签和正文…').fill('private-token-59281')
  await expect(page.locator('.search-results').getByRole('button')).toHaveCount(0)
  for (const secret of privateValues) await expect(page.locator('body')).not.toContainText(secret)
  const storage = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))
  for (const secret of privateValues) expect(storage).not.toContain(secret)
})

test('uses ordinary discussions on unlocked protected pages while quotes, replies and processing remain encrypted', async ({ page, browser, backend }) => {
  const quote = 'private-discussion-quote-59317'
  const body = 'private-discussion-body-23817'
  const reply = 'private-discussion-reply-84726'
  const note = 'private-discussion-resolution-69281'
  const draftSecret = 'private-discussion-unsaved-84621'
  const secrets = [quote, body, reply, note, draftSecret]
  await seedBrowser(page.context(), backend.profile)
  await page.routeWebSocket('**/*', () => {})
  await page.goto('/')
  await expect(page.getByRole('textbox', { name: '页面标题', exact: true })).toHaveValue('普通文档')
  const requests: unknown[] = []
  page.on('request', (request) => {
    if (request.url().startsWith(backend.url) && /\/(?:signals|reviews)(?:\/|$)/.test(new URL(request.url()).pathname) && request.method() !== 'GET') requests.push(request.postDataJSON())
  })
  const editor = await beginDocument(page)
  await (await sourceEditor(editor)).fill(`## 共享讨论\n\n${quote}\n`)
  await saveDocument(page, editor)
  const rich = await richEditor(editor)
  const passage = rich.locator('p').filter({ hasText: quote })
  await passage.click()
  await page.keyboard.press('Home')
  await page.keyboard.press('Shift+End')
  await passage.click({ button: 'right' })
  await page.getByRole('menuitem', { name: '提出修正', exact: true }).click()
  const draft = page.locator('.pheromone-draft')
  await expect(draft.locator('blockquote')).toHaveText(quote)
  await draft.locator('textarea').fill(body)
  await draft.getByRole('button', { name: '留下', exact: true }).click()
  const first = page.locator('.pheromone-card').filter({ has: page.locator('.pheromone-body', { hasText: body }) })
  await expect(first).toBeVisible()
  await expect(rich.locator('[data-pheromone-id]')).toHaveText(quote)
  await first.getByRole('button', { name: '回复支持', exact: true }).click()
  await draft.locator('textarea').fill(reply)
  await draft.getByRole('button', { name: '留下', exact: true }).click()
  const second = page.locator('.pheromone-card').filter({ has: page.locator('.pheromone-body', { hasText: reply }) })
  await expect(second).toContainText('回复意见')
  await first.getByRole('textbox', { name: '处理说明', exact: true }).fill(note)
  await first.getByRole('button', { name: '已处理', exact: true }).click()
  await expect(first).toContainText(note)
  await expect(first).toContainText('已处理')
  await page.screenshot({ path: '/tmp/tie-normal-protected-discussion.png', fullPage: true })
  await second.getByRole('textbox', { name: '处理说明', exact: true }).fill(draftSecret)
  await first.getByRole('button', { name: '回复修正', exact: true }).click()
  await draft.locator('textarea').fill(draftSecret)
  await editor.getByRole('button', { name: '锁定页面', exact: true }).click()
  await expect(page.locator('.pheromone-card')).toHaveCount(0)
  await expect(draft).toHaveCount(0)
  await expect(page.locator('.pheromone-links path')).toHaveCount(0)
  for (const secret of secrets) await expect(page.locator('body')).not.toContainText(secret)
  await editor.getByLabel('解锁密码', { exact: true }).fill(password)
  await editor.getByRole('button', { name: '解锁页面', exact: true }).click()
  await expect(first).toContainText(note)
  await expect(second.getByRole('textbox', { name: '处理说明', exact: true })).toHaveValue('')
  await expect(draft).toHaveCount(0)

  const stored = (await backendPages(backend)).find((entry) => entry.title === title)!
  const reviews = await (await fetch(`${backend.url}/api/v1/workspaces/${backend.workspaceId}/pages/${stored.id}/reviews`, {
    headers: { authorization: `Bearer ${backend.profile.accessToken}` },
  })).json()
  const opinions = reviews.entries.filter((entry: { kind: string }) => entry.kind === 'opinion')
  expect(opinions).toHaveLength(2)
  expect(opinions.every((entry: { quote: string; body: string }) => entry.quote === '' && entry.body.startsWith(marker))).toBe(true)
  expect(opinions.find((entry: { resolutionNote?: string }) => entry.resolutionNote)?.resolutionNote.startsWith(marker)).toBe(true)
  for (const secret of secrets) {
    expect(JSON.stringify(reviews)).not.toContain(secret)
    expect(JSON.stringify(requests)).not.toContain(secret)
  }
  const root = path.join(backend.data, 'workspaces', backend.workspaceId)
  for (const file of fs.readdirSync(root, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile())) {
    const bytes = fs.readFileSync(path.join(file.parentPath, file.name), 'utf8')
    for (const secret of secrets) expect(bytes).not.toContain(secret)
  }
  const storage = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))
  for (const secret of secrets) expect(storage).not.toContain(secret)

  const context = await browser.newContext({ baseURL: 'http://127.0.0.1:4173' })
  try {
    await seedBrowser(context, backend.profile)
    await context.routeWebSocket('**/*', () => {})
    const remote = await context.newPage()
    await remote.goto('/')
    await remote.getByRole('tree', { name: '我的页面', exact: true }).getByRole('treeitem', { name: new RegExp(title) }).click()
    await remote.locator('.context-tabs').getByRole('button', { name: '变更', exact: true }).click()
    await expect(remote.locator('.pheromone-card')).toHaveCount(0)
    const remoteEditor = documentEditor(remote)
    await remoteEditor.getByLabel('解锁密码', { exact: true }).fill(password)
    await remoteEditor.getByRole('button', { name: '解锁页面', exact: true }).click()
    await expect(remote.locator('.pheromone-card').filter({ hasText: body })).toContainText(note)
    await expect(remote.locator('.pheromone-card').filter({ hasText: reply })).toContainText('回复意见')
  } finally { await context.close() }
})

test('authorizes an existing server encryption before encrypting the local copy without replacing server data', async ({ page, backend }) => {
  const cli = process.env.TIE_TEST_CLI || fileURLToPath(new URL(`../src-tauri/target/debug/tie-cli${process.platform === 'win32' ? '.exe' : ''}`, import.meta.url))
  const headers = { authorization: `Bearer ${backend.profile.accessToken}`, 'content-type': 'application/json' }
  const ordinary = (await backendPages(backend)).find((item) => item.id === 'pg_ordinary')!
  expect((await fetch(`${backend.url}/api/v1/admin/settings`, { method: 'PUT', headers, body: JSON.stringify({ mcp: { enabled: true, cliPath: cli } }) })).status).toBe(200)
  // Prepare the remote before opening the client: a client conversion schedules
  // a reload that would race this test's manually injected local storage source.
  const converted = await fetch(`${backend.url}/mcp`, {
    method: 'POST', headers: { ...headers, 'x-tie-workspace': backend.workspaceId },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'tie_page_protection',
      arguments: { id_or_title: ordinary.id, action: 'convert', encrypted: true, password } } }),
  })
  expect(converted.status).toBe(200)
  expect((await converted.json()).result.isError).toBe(false)
  const serverCiphertext = (await backendPages(backend)).find((item) => item.id === ordinary.id)!.markdown
  expect(serverCiphertext.startsWith(marker)).toBe(true)
  await seedBrowser(page.context(), backend.profile)
  await page.routeWebSocket('**/*', () => {})
  await page.goto('/')
  const editor = documentEditor(page)
  await expect(editor.getByRole('button', { name: '解锁页面', exact: true })).toBeVisible()
  await page.evaluate(async () => {
    const store = (document.querySelector('#app') as any).__vue_app__.config.globalProperties.$pinia._s.get('workspace')
    await store.initializeBackground()
  })
  const serverWrites: unknown[] = []
  page.on('request', (request) => {
    if (request.url().endsWith('/pg_ordinary/protection') && request.method() === 'PUT') serverWrites.push(request.postDataJSON())
  })
  await page.evaluate(({ ordinary, workspaceId }) => {
    const store = (document.querySelector('#app') as any).__vue_app__.config.globalProperties.$pinia._s.get('workspace')
    const source = { id: 'source-demo-local', name: '本机资料库', kind: 'local', path: '', available: true }
    const local = { ...ordinary, storageSourceId: source.id, storageSourceIds: [source.id, `backend:${workspaceId}`] }
    const workspace = { id: 'demo', name: '本机资料库', sources: [source, ...store.workspace.sources] }
    localStorage.setItem('tie-demo-workspace-v1', JSON.stringify({ workspace, pages: [local] }))
    localStorage.setItem('tie-demo-page-history-v1', JSON.stringify({ [local.id]: [{ id: 'rev_local_only', page: { ...local, markdown: 'fixture-local-only-history-preserved', updatedAt: '2026-11-24T00:00:00Z' } }] }))
    store.workspace = workspace
    store.pages = [local]
    store.activePageId = local.id
    store.syncConflicts = new Map([[local.id, { pageId: local.id, sourceId: source.id, kind: 'protection', localEncrypted: false, remoteEncrypted: true,
      localUpdatedAt: '2026-11-26T00:00:00Z', remoteUpdatedAt: '2026-11-27T00:00:00Z' }]])
  }, { ordinary, workspaceId: backend.workspaceId })
  await expect(editor.getByRole('button', { name: '处理保护状态', exact: true })).toBeVisible()
  await editor.getByRole('button', { name: '处理保护状态', exact: true }).click()
  const conflict = page.getByRole('dialog', { name: '页面保护状态不同', exact: true })
  await expect(conflict.getByRole('button', { name: /覆盖|载入/ })).toHaveCount(0)
  await page.screenshot({ path: '/tmp/tie-protection-conflict.png', fullPage: true })
  await conflict.getByRole('button', { name: '解锁并加密本机', exact: true }).click()
  const align = page.getByRole('dialog', { name: '解锁并加密本机', exact: true })
  await align.getByLabel('服务器页面密码', { exact: true }).fill('wrong-fixture-password')
  await align.getByRole('button', { name: '解锁并加密本机', exact: true }).click()
  await expect(align.getByRole('alert')).toBeVisible()
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('tie-demo-workspace-v1')!).pages[0].markdown)).toBe(ordinary.markdown)
  expect((await backendPages(backend)).find((item) => item.id === ordinary.id)!.markdown).toBe(serverCiphertext)
  await align.getByLabel('服务器页面密码', { exact: true }).fill(password)
  await align.getByRole('button', { name: '解锁并加密本机', exact: true }).click()
  await expect(align).toBeHidden({ timeout: 15_000 })
  const local = await page.evaluate(() => ({ snapshot: JSON.parse(localStorage.getItem('tie-demo-workspace-v1')!), history: JSON.parse(localStorage.getItem('tie-demo-page-history-v1')!) }))
  expect(local.snapshot.pages[0].markdown).toBe(serverCiphertext)
  expect(local.history[ordinary.id].some((entry: { id: string }) => entry.id === 'rev_local_only')).toBe(true)
  expect(local.history[ordinary.id].every((entry: { page: { markdown: string } }) => entry.page.markdown.startsWith(marker))).toBe(true)
  expect(JSON.stringify(local)).not.toContain('fixture-local-only-history-preserved')
  expect((await backendPages(backend)).find((item) => item.id === ordinary.id)!.markdown).toBe(serverCiphertext)
  expect(serverWrites).toHaveLength(0)
  expect(await page.evaluate(() => {
    const store = (document.querySelector('#app') as any).__vue_app__.config.globalProperties.$pinia._s.get('workspace')
    const conflict = store.syncConflicts.get('pg_ordinary')
    return { pending: Boolean(conflict), protection: conflict?.kind === 'protection' }
  })).toEqual({ pending: true, protection: false })
})
