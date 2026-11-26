import { expect, test as base, type Page } from '@playwright/test'
import { once } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

type Backend = { url: string; data: string; profile: Record<string, unknown>; workspaceId: string; accessToken: string }
const privateValue = 'special-credential-page-private-value-92841'
const replacementValue = 'special-credential-page-replaced-value-59182'
const test = base.extend<{ backend: Backend }>({
  backend: async ({}, use) => {
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'tie-credential-pages-'))
    process.env.TIE_DATA_DIR = data
    process.env.NODE_ENV = 'test'
    delete process.env.TIE_VAULT_KEY_FILE
    const { createApp } = await import(pathToFileURL(fileURLToPath(new URL('../backend/src/app.js', import.meta.url))).href)
    const { closeLive } = await import(pathToFileURL(fileURLToPath(new URL('../backend/src/live.js', import.meta.url))).href)
    const server = createApp({ jwtSecret: 'credential-pages-browser-test-secret-over-32-characters' }).listen(0, '127.0.0.1')
    try {
      await once(server, 'listening')
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Fixture backend did not bind a port')
      const url = `http://127.0.0.1:${address.port}`
      const response = await fetch(`${url}/api/v1/auth/register`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Credential Owner', email: 'credential-owner@example.test', password: 'credential-browser-test-password' }),
      })
      expect(response.status).toBe(200)
      const session = await response.json()
      const headers = { authorization: `Bearer ${session.accessToken}`, 'content-type': 'application/json' }
      const workspaces = await (await fetch(`${url}/api/v1/workspaces`, { headers })).json()
      const workspaceId = workspaces[0].id
      const stamp = '2026-11-26T00:00:00.000Z'
      const ordinary = await fetch(`${url}/api/v1/workspaces/${workspaceId}/pages/pg_ordinary`, {
        method: 'PUT', headers,
        body: JSON.stringify({ id: 'pg_ordinary', title: '普通文档', markdown: '# 普通文档\n\n这里只放普通文字。', icon: '', tags: [], parentId: null, sortKey: 0, createdAt: stamp, updatedAt: stamp, deletedAt: null }),
      })
      expect(ordinary.status).toBe(200)
      const profile = { endpoint: url, accessToken: session.accessToken, refreshToken: session.refreshToken,
        accessExpiresAt: session.accessExpiresAt, user: session.user }
      await use({ url, data, profile, workspaceId, accessToken: session.accessToken })
    } finally {
      closeLive()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      fs.rmSync(data, { recursive: true, force: true })
    }
  },
})

async function openApp(page: Page, backend: Backend, mobile = false) {
  await page.addInitScript((profile) => {
    localStorage.clear()
    localStorage.setItem('tie-backend-profile-v1', JSON.stringify(profile))
    const copied: string[] = []
    Object.assign(window, { __credentialCopied: copied })
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value: string) => { copied.push(value) } } })
  }, backend.profile)
  await page.routeWebSocket('**/*', () => {})
  await page.goto('/')
  if (mobile) {
    const back = page.getByRole('button', { name: '返回列表', exact: true })
    const create = page.getByRole('button', { name: '新建操作凭据', exact: true })
    await expect(back.or(create)).toBeVisible()
    if (await back.isVisible()) await back.click()
    await expect(create).toBeVisible()
  } else await expect(page.getByRole('textbox', { name: '页面标题', exact: true })).toHaveValue('普通文档')
}

async function createCredential(page: Page, backend: Backend) {
  await page.getByRole('button', { name: '新建操作凭据', exact: true }).click()
  const editor = page.getByRole('main', { name: '凭据页面', exact: true })
  await expect(editor).toBeVisible()
  await editor.getByLabel('凭据名称', { exact: true }).fill('服务器部署密钥')
  await editor.getByLabel('密钥', { exact: true }).fill(privateValue)
  const saved = page.waitForResponse((response) => response.url() === `${backend.url}/api/v1/me/secrets` && response.request().method() === 'POST')
  await editor.getByRole('button', { name: '保存凭据', exact: true }).click()
  const response = await saved
  expect(response.status()).toBe(201)
  const metadata = await response.json()
  expect(metadata.action).toBeNull()
  expect(metadata).not.toHaveProperty('value')
  expect(metadata).not.toHaveProperty('encryptedValue')
  await expect(page.getByRole('list', { name: '凭据页面', exact: true }).getByRole('button', { name: '服务器部署密钥', exact: true })).toBeVisible()
  await expect(editor.getByLabel('密钥', { exact: true })).toHaveValue('')
  return { editor, metadata: metadata as { id: string; secretRef: string } }
}

async function holdCredentialList(page: Page, backend: Backend) {
  let release!: () => void
  let requested!: () => void
  let first = true
  const held = new Promise<void>((resolve) => { release = resolve })
  const started = new Promise<void>((resolve) => { requested = resolve })
  await page.route(`${backend.url}/api/v1/me/secrets**`, async (route) => {
    if (!first || route.request().method() !== 'GET' || new URL(route.request().url()).pathname !== '/api/v1/me/secrets') return route.continue()
    first = false
    const response = await route.fetch()
    requested()
    await held
    await route.fulfill({ response })
  })
  return { started, release }
}

test('adds and maintains a credential as a special page without writing an ordinary document', async ({ page, backend }) => {
  const ordinaryWrites: unknown[] = []
  const credentialUpdates: unknown[] = []
  const valueRequests: string[] = []
  page.on('request', (request) => {
    const route = new URL(request.url()).pathname
    if (/\/workspaces\/[^/]+\/pages(?:\/[^/]+)?$/.test(route) && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method())) ordinaryWrites.push(request.postDataJSON())
    if (/\/secrets\/[^/]+\/value$/.test(route) && request.method() === 'GET') valueRequests.push(route)
    if (/\/secrets\/[^/]+$/.test(route) && request.method() === 'PUT') credentialUpdates.push(request.postDataJSON())
  })
  await openApp(page, backend)
  const { editor, metadata } = await createCredential(page, backend)
  expect(valueRequests).toEqual([])
  await expect(page.locator('.context-panel')).toHaveCount(0)
  await page.screenshot({ path: '/tmp/tie-credential-page-preview.png', fullPage: true })
  await editor.getByRole('button', { name: '查看密钥', exact: true }).click()
  await expect(editor.locator('[data-credential-value]')).toHaveText(privateValue)
  await editor.getByRole('button', { name: '隐藏密钥', exact: true }).click()
  await expect(editor.locator('[data-credential-value]')).toHaveCount(0)
  await editor.getByRole('button', { name: '复制密钥', exact: true }).click()
  await expect.poll(() => page.evaluate(() => (window as Window & { __credentialCopied: string[] }).__credentialCopied)).toEqual([privateValue])

  await editor.getByText('Agent 使用与授权', { exact: true }).click()
  await editor.getByLabel('配置固定 HTTP 操作', { exact: true }).check()
  await editor.getByLabel('固定 HTTPS 地址', { exact: true }).fill('https://api.example.com/status')
  const invalidFields = await editor.locator('form').evaluate((element) => Array.from((element as HTMLFormElement).elements)
    .filter((input) => 'validity' in input && !(input as HTMLInputElement).validity.valid)
    .map((input) => ({ id: input.id, message: (input as HTMLInputElement).validationMessage })))
  expect(invalidFields).toEqual([])
  const configured = page.waitForResponse((response) => response.url() === `${backend.url}/api/v1/me/secrets/${metadata.id}` && response.request().method() === 'PUT')
  await editor.getByRole('button', { name: '保存凭据', exact: true }).click()
  const configuredResponse = await configured
  expect(configuredResponse.status(), JSON.stringify(await configuredResponse.json())).toBe(200)
  const authorize = editor.getByRole('button', { name: '授权此操作', exact: true })
  await expect(authorize).toBeEnabled()
  await authorize.click()
  await expect(editor.getByRole('region', { name: '凭据授权', exact: true })).toContainText('已授权')
  const updatesBeforeNoopSave = credentialUpdates.length
  await expect(editor.getByRole('button', { name: '保存凭据', exact: true })).toBeDisabled()
  await page.keyboard.press('Control+s')
  await page.waitForLoadState('networkidle')
  expect(credentialUpdates).toHaveLength(updatesBeforeNoopSave)

  await editor.getByLabel('凭据名称', { exact: true }).fill('服务器部署凭据')
  const updated = page.waitForRequest((request) => request.url() === `${backend.url}/api/v1/me/secrets/${metadata.id}` && request.method() === 'PUT')
  await editor.getByRole('button', { name: '保存凭据', exact: true }).click()
  expect((await updated).postDataJSON()).not.toHaveProperty('value')
  await expect(page.getByRole('list', { name: '凭据页面', exact: true })).toContainText('服务器部署凭据')
  await editor.getByLabel('密钥', { exact: true }).fill(replacementValue)
  const replaced = page.waitForRequest((request) => request.url() === `${backend.url}/api/v1/me/secrets/${metadata.id}` && request.method() === 'PUT')
  await editor.getByRole('button', { name: '保存凭据', exact: true }).click()
  expect((await replaced).postDataJSON().value).toBe(replacementValue)
  await expect(editor.getByLabel('密钥', { exact: true })).toHaveValue('')
  await expect(editor.locator('[data-credential-value]')).toHaveCount(0)
  await editor.getByRole('button', { name: '复制密钥', exact: true }).click()
  await expect.poll(() => page.evaluate(() => (window as Window & { __credentialCopied: string[] }).__credentialCopied)).toEqual([privateValue, replacementValue])
  expect(ordinaryWrites).toEqual([])
  expect(await page.evaluate((values) => [localStorage, sessionStorage].some((storage) => Object.values(storage).some((value) => values.some((secret) => String(value).includes(secret)))), [privateValue, replacementValue])).toBe(false)
  const files = fs.readdirSync(path.join(backend.data, 'workspaces', backend.workspaceId, 'pages'))
  expect(files).toHaveLength(1)
  expect(files[0]).toContain('普通文档')
  const storedVault = fs.readFileSync(path.join(backend.data, 'vault.json'), 'utf8')
  expect(storedVault).not.toContain(privateValue)
  expect(storedVault).not.toContain(replacementValue)
  page.once('dialog', (dialog) => dialog.accept())
  await editor.getByRole('button', { name: '删除凭据', exact: true }).click()
  await expect(page.getByRole('list', { name: '凭据页面', exact: true })).not.toContainText('服务器部署凭据')
})

for (const leave of ['ordinary page', 'logout'] as const) {
  test(`discards a delayed credential copy after switching to ${leave}`, async ({ page, backend }) => {
    await openApp(page, backend)
    const { editor, metadata } = await createCredential(page, backend)
    let release!: () => void
    let requested!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    const started = new Promise<void>((resolve) => { requested = resolve })
    await page.route(`${backend.url}/api/v1/me/secrets/${metadata.id}/value`, async (route) => {
      const response = await route.fetch()
      requested()
      await held
      await route.fulfill({ response })
    })
    await editor.getByRole('button', { name: '复制密钥', exact: true }).click()
    await started
    try {
      if (leave === 'ordinary page') {
        await page.getByRole('treeitem', { name: /普通文档/ }).click()
        await expect(page.getByRole('textbox', { name: '页面标题', exact: true })).toHaveValue('普通文档')
      } else {
        await page.locator('.sidebar-storage-trigger').click()
        await page.getByRole('dialog', { name: '设置', exact: true }).getByRole('button', { name: '服务器', exact: true }).click()
        await page.getByRole('dialog', { name: '绑定服务器', exact: true }).getByRole('button', { name: '解除绑定', exact: true }).click()
      }
    } finally { release() }
    await page.waitForLoadState('networkidle')
    expect(await page.evaluate(() => (window as Window & { __credentialCopied: string[] }).__credentialCopied)).toEqual([])
    await expect(page.locator('[data-credential-value]')).toHaveCount(0)
    await expect(page.locator('body')).not.toContainText(privateValue)
  })
}

test('a delayed metadata list cannot overwrite a created credential or resurrect a deleted one', async ({ page, backend }) => {
  await openApp(page, backend)
  const staleBeforeCreate = await holdCredentialList(page, backend)
  let saved: Awaited<ReturnType<typeof createCredential>>
  try {
    saved = await createCredential(page, backend)
    await staleBeforeCreate.started
  } finally { staleBeforeCreate.release() }
  await page.waitForLoadState('networkidle')
  const list = page.getByRole('list', { name: '凭据页面', exact: true })
  await expect(list.getByRole('button', { name: '服务器部署密钥', exact: true })).toBeVisible()

  await page.locator('.credential-section-toggle').click()
  const staleBeforeDelete = await holdCredentialList(page, backend)
  await page.locator('.credential-section-toggle').click()
  await staleBeforeDelete.started
  try {
    page.once('dialog', (dialog) => dialog.accept())
    const deleted = page.waitForResponse((response) => response.url() === `${backend.url}/api/v1/me/secrets/${saved!.metadata.id}` && response.request().method() === 'DELETE')
    await saved!.editor.getByRole('button', { name: '删除凭据', exact: true }).click()
    expect((await deleted).status()).toBe(204)
    await expect(list).not.toContainText('服务器部署密钥')
  } finally { staleBeforeDelete.release() }
  await page.waitForLoadState('networkidle')
  await expect(list).not.toContainText('服务器部署密钥')
})

test('new credential pages retain the selected workspace and support a multiline value', async ({ page, backend }) => {
  const response = await fetch(`${backend.url}/api/v1/workspaces`, { method: 'POST',
    headers: { authorization: `Bearer ${backend.accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name: '第二个凭据工作区' }),
  })
  expect(response.status).toBe(201)
  const second = await response.json()
  await openApp(page, backend)
  await createCredential(page, backend)
  await page.getByRole('combobox', { name: '凭据工作区', exact: true }).selectOption(second.id)
  await page.getByRole('button', { name: '新建操作凭据', exact: true }).click()
  const editor = page.getByRole('main', { name: '凭据页面', exact: true })
  await expect(page.getByRole('combobox', { name: '凭据工作区', exact: true })).toHaveValue(second.id)
  await expect(editor).toContainText('第二个凭据工作区')
  await editor.getByLabel('凭据名称', { exact: true }).fill('多行部署凭据')
  await editor.getByLabel('多行输入', { exact: true }).check()
  await editor.getByLabel('密钥', { exact: true }).fill(`${privateValue}\nsecond line`)
  const saved = page.waitForResponse((result) => result.url() === `${backend.url}/api/v1/me/secrets` && result.request().method() === 'POST')
  await editor.getByRole('button', { name: '保存凭据', exact: true }).click()
  const record = await (await saved).json()
  expect(record.workspaceId).toBe(second.id)
  await expect(page.getByRole('list', { name: '凭据页面', exact: true })).toContainText('多行部署凭据')
  await page.getByRole('combobox', { name: '凭据工作区', exact: true }).selectOption(backend.workspaceId)
  const list = page.getByRole('list', { name: '凭据页面', exact: true })
  await expect(list).toContainText('服务器部署密钥')
  await expect(list).not.toContainText('多行部署凭据')
  await expect(page.locator('[data-credential-value]')).toHaveCount(0)
})

test('opens and saves a credential page from the mobile page list', async ({ page, backend }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await openApp(page, backend, true)
  await page.getByRole('button', { name: '新建操作凭据', exact: true }).click()
  const editor = page.getByRole('main', { name: '凭据页面', exact: true })
  await editor.getByLabel('凭据名称', { exact: true }).fill('手机凭据')
  await editor.getByLabel('密钥', { exact: true }).fill(privateValue)
  await editor.getByRole('button', { name: '保存凭据', exact: true }).click()
  await expect(editor.getByRole('button', { name: '查看密钥', exact: true })).toBeVisible()
  await editor.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(page.getByRole('list', { name: '凭据页面', exact: true }).getByRole('button', { name: '手机凭据', exact: true })).toBeVisible()
})
