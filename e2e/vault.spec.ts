import { expect, test as base, type Page } from '@playwright/test'
import { once } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

type Backend = { url: string; data: string; accessToken: string; refreshToken: string; userId: string; workspaceId: string; secondWorkspaceId: string; tokenId: string }
const secretValue = 'vault-browser-private-fixture-92841'
const test = base.extend<{ backend: Backend }>({
  backend: async ({}, use) => {
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'tie-vault-browser-'))
    process.env.TIE_DATA_DIR = data
    process.env.NODE_ENV = 'test'
    delete process.env.TIE_VAULT_KEY_FILE
    const { createApp } = await import(pathToFileURL(fileURLToPath(new URL('../backend/src/app.js', import.meta.url))).href)
    const server = createApp({ jwtSecret: 'vault-browser-test-secret-over-32-characters' }).listen(0, '127.0.0.1')
    try {
      await once(server, 'listening')
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Fixture backend did not bind a port')
      const url = `http://127.0.0.1:${address.port}`
      const response = await fetch(`${url}/api/v1/auth/register`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Vault Owner', email: 'vault-owner@example.test', password: 'vault-browser-test-password' }),
      })
      expect(response.status).toBe(200)
      const session = await response.json()
      const headers = { authorization: `Bearer ${session.accessToken}`, 'content-type': 'application/json' }
      const workspaces = await (await fetch(`${url}/api/v1/workspaces`, { headers })).json()
      const token = await (await fetch(`${url}/api/v1/me/mcp-tokens`, {
        method: 'POST', headers, body: JSON.stringify({ name: 'Vault Agent', workspaceId: workspaces[0].id, reveal: false }),
      })).json()
      const secondWorkspace = await (await fetch(`${url}/api/v1/workspaces`, { method: 'POST', headers, body: JSON.stringify({ name: '另一个工作区' }) })).json()
      await use({ url, data, accessToken: session.accessToken, refreshToken: session.refreshToken, userId: session.user.id, workspaceId: workspaces[0].id, secondWorkspaceId: secondWorkspace.id, tokenId: token.record.id })
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      fs.rmSync(data, { recursive: true, force: true })
    }
  },
})

async function openVault(page: Page, backend: Backend) {
  await page.addInitScript((session) => {
    sessionStorage.setItem('tie.me.token', JSON.stringify(session))
    const copied: string[] = []
    Object.defineProperty(window, '__vaultCopied', { value: copied })
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value: string) => { copied.push(value) } } })
  }, { accessToken: backend.accessToken, refreshToken: backend.refreshToken })
  await page.route('**/*', (route) => new URL(route.request().url()).origin === backend.url ? route.continue() : route.abort())
  await page.goto(`${backend.url}/me/`)
  await page.getByRole('button', { name: '凭据库', exact: true }).click()
  await expect(page.getByRole('heading', { name: '凭据库', exact: true })).toBeVisible()
  await expect(page.getByRole('table', { name: '凭据列表' })).toContainText('没有匹配的凭据')
}

async function createSecret(page: Page) {
  await page.getByRole('button', { name: '新增凭据', exact: true }).click()
  const editor = page.getByRole('dialog', { name: '新增凭据', exact: true })
  await editor.getByLabel('名称', { exact: true }).fill('Production API')
  await editor.getByLabel('说明', { exact: true }).fill('固定读取服务状态')
  await editor.getByLabel('服务', { exact: true }).fill('Fixture API')
  await editor.getByLabel('环境', { exact: true }).fill('production')
  await editor.getByLabel('标签', { exact: true }).fill('deploy, status')
  await editor.getByLabel('固定 HTTP 地址', { exact: true }).fill('https://api.example.com/status')
  await editor.getByLabel('密钥', { exact: true }).fill(secretValue)
  await editor.getByLabel('允许返回的字段（每行一个）', { exact: true }).fill('status\ndata.id')
  const saved = page.waitForResponse((response) => response.url().endsWith('/api/v1/me/secrets') && response.request().method() === 'POST')
  await editor.getByRole('button', { name: '保存凭据', exact: true }).click()
  const response = await saved
  expect(response.status()).toBe(201)
  const record = await response.json()
  expect(record).not.toHaveProperty('value')
  expect(record).not.toHaveProperty('target')
  await expect(editor).toHaveCount(0)
  await expect(page.getByRole('table', { name: '凭据列表' })).toContainText('Production API')
  return record as { id: string; secretRef: string }
}

test('maintains metadata, reveals only explicitly, and grants token or session use with a fixed target', async ({ page, backend }) => {
  const valueRequests: string[] = []
  const grants: { principal: { type: string; id: string }; maxUses: number | null; expiresAt: string }[] = []
  page.on('request', (request) => {
    if (/\/secrets\/[^/]+\/value$/.test(new URL(request.url()).pathname)) valueRequests.push(request.url())
    if (/\/secrets\/[^/]+\/grants$/.test(new URL(request.url()).pathname) && request.method() === 'POST') grants.push(request.postDataJSON())
  })
  await openVault(page, backend)
  const secret = await createSecret(page)
  const row = page.getByRole('table', { name: '凭据列表' }).getByRole('row').filter({ hasText: 'Production API' })
  await expect(row).not.toContainText(secretValue)
  expect(valueRequests).toEqual([])
  await row.getByRole('button', { name: '详情与授权 Production API', exact: true }).click()
  let detail = page.getByRole('dialog', { name: '详情与授权 · Production API', exact: true })
  await expect(detail).toContainText('GET https://api.example.com/status')
  await expect(detail).toContainText('status、data.id')
  await page.screenshot({ path: '/tmp/tie-vault-ui-grant.png', fullPage: true })
  await detail.getByRole('button', { name: '授权此操作', exact: true }).click()
  await expect(detail).toHaveCount(0)
  await expect(page.getByRole('table', { name: '凭据授权' })).toContainText('登录会话')
  expect(grants[0]).toMatchObject({ principal: { type: 'session', id: 'current' }, maxUses: 1 })
  expect(Date.parse(grants[0]!.expiresAt) - Date.now()).toBeGreaterThan(3_500_000)
  const anotherLogin = await fetch(`${backend.url}/api/v1/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'vault-owner@example.test', password: 'vault-browser-test-password' }),
  })
  expect(anotherLogin.status).toBe(200)
  const sessionsResponse = await fetch(`${backend.url}/api/v1/me/secret-sessions`, { headers: { authorization: `Bearer ${backend.accessToken}` } })
  const sessions = await sessionsResponse.json() as { id: string; current: boolean; expiresAt: string }[]
  const clientSession = sessions.find((session) => !session.current)!
  expect(clientSession).toBeTruthy()
  expect(sessionsResponse.headers.get('cache-control')).toBe('no-store')
  for (const session of sessions) expect(Object.keys(session).sort()).toEqual(['current', 'expiresAt', 'id'])
  await row.getByRole('button', { name: '详情与授权 Production API', exact: true }).click()
  detail = page.getByRole('dialog', { name: '详情与授权 · Production API', exact: true })
  await detail.getByRole('combobox', { name: '授权给', exact: true }).selectOption(`session:${clientSession.id}`)
  await expect(detail.locator('#vault-principal-id')).toContainText(clientSession.id)
  await detail.getByRole('button', { name: '授权此操作', exact: true }).click()
  await expect(detail).toHaveCount(0)
  expect(grants[1]).toMatchObject({ principal: { type: 'session', id: clientSession.id }, maxUses: 1 })
  await row.getByRole('button', { name: '详情与授权 Production API', exact: true }).click()
  detail = page.getByRole('dialog', { name: '详情与授权 · Production API', exact: true })
  await detail.getByRole('combobox', { name: '授权给', exact: true }).selectOption(`mcp-token:${backend.tokenId}`)
  await detail.getByRole('combobox', { name: '有效期', exact: true }).selectOption('168')
  await detail.getByRole('combobox', { name: '使用次数', exact: true }).selectOption('continuous')
  await detail.getByRole('button', { name: '授权此操作', exact: true }).click()
  await expect(detail).toHaveCount(0)
  const tokenGrant = page.getByRole('table', { name: '凭据授权' }).getByRole('row').filter({ hasText: 'Vault Agent' })
  await expect(tokenGrant).toContainText('持续')
  expect(grants[2]).toMatchObject({ principal: { type: 'mcp-token', id: backend.tokenId }, maxUses: null })
  expect(Date.parse(grants[2]!.expiresAt) - Date.now()).toBeGreaterThan(6 * 86_400_000)
  const vault = await import(pathToFileURL(fileURLToPath(new URL('../backend/src/vault.js', import.meta.url))).href)
  const caller = { userId: backend.userId, workspaceId: backend.workspaceId, principal: { type: 'mcp-token', id: backend.tokenId } }
  // Seed a completed audit entry through the real model without calling an external service.
  const used = vault.authorizeUse(caller, { secretRef: secret.secretRef })
  vault.finishUse(used.eventId, { status: 'succeeded', httpStatus: 200 })
  await page.getByRole('button', { name: '刷新记录', exact: true }).click()
  await expect(page.getByRole('table', { name: '凭据使用记录' })).toContainText('成功 · HTTP 200')
  await expect(page.getByRole('table', { name: '凭据使用记录' })).toContainText('GET https://api.example.com')
  await expect(page.getByRole('table', { name: '凭据使用记录' })).toContainText('凭据版本：1')
  await expect(page.getByRole('table', { name: '凭据使用记录' })).toContainText(used.grantId)
  await tokenGrant.getByRole('button', { name: '撤销授权', exact: true }).click()
  await expect(tokenGrant).toContainText('已撤销')
  expect(() => vault.authorizeUse(caller, { secretRef: secret.secretRef })).toThrow()
  expect(() => vault.authorizeUse(caller, { secretRef: secret.secretRef, unexpected: true })).toThrow()
  const stored = JSON.parse(fs.readFileSync(path.join(backend.data, 'vault.json'), 'utf8'))
  const legacyDenial = stored.usage.at(-1)
  legacyDenial.principal = null
  for (const field of ['action', 'version', 'grantId']) delete legacyDenial[field]
  fs.writeFileSync(path.join(backend.data, 'vault.json'), JSON.stringify(stored))
  await page.getByRole('button', { name: '刷新记录', exact: true }).click()
  await expect(page.getByRole('table', { name: '凭据使用记录' })).toContainText('拒绝')
  await expect(page.getByRole('table', { name: '凭据使用记录' })).toContainText('未识别调用者')
  await row.getByRole('button', { name: '编辑 Production API', exact: true }).click()
  const editor = page.getByRole('dialog', { name: '编辑凭据', exact: true })
  await expect(editor.getByLabel('密钥（留空保留）', { exact: true })).toHaveValue('')
  await editor.getByRole('textbox', { name: '说明', exact: true }).fill('更新说明，保留密钥')
  const updated = page.waitForRequest((request) => request.url().endsWith(`/secrets/${secret.id}`) && request.method() === 'PUT')
  await editor.getByRole('button', { name: '保存凭据', exact: true }).click()
  expect((await updated).postDataJSON()).not.toHaveProperty('value')
  await expect(editor).toHaveCount(0)
  expect(valueRequests).toEqual([])
  await row.getByRole('button', { name: '查看密钥 Production API', exact: true }).click()
  await expect(row.locator('[data-vault-value]')).toHaveText(secretValue)
  await row.getByRole('button', { name: '隐藏密钥 Production API', exact: true }).click()
  await expect(row.locator('[data-vault-value]')).toBeEmpty()
  await row.getByRole('button', { name: '复制密钥 Production API', exact: true }).click()
  await expect(row.locator('[data-vault-feedback]')).toHaveText('密钥已复制。')
  expect(valueRequests).toHaveLength(2)
  expect(await page.evaluate(() => (window as Window & { __vaultCopied: string[] }).__vaultCopied)).toEqual([secretValue])
  expect(await page.evaluate((value) => [localStorage, sessionStorage].some((storage) => Object.values(storage).some((saved) => String(saved).includes(value))), secretValue)).toBe(false)
  expect(fs.readFileSync(path.join(backend.data, 'vault.json'), 'utf8')).not.toContain(secretValue)
  await page.getByLabel('搜索凭据说明', { exact: true }).fill('does-not-match')
  await page.getByRole('button', { name: '搜索', exact: true }).click()
  await expect(page.getByRole('table', { name: '凭据列表' })).toContainText('没有匹配的凭据')
  await page.getByLabel('搜索凭据说明', { exact: true }).fill('Fixture API')
  await page.getByRole('button', { name: '搜索', exact: true }).click()
  await expect(row).toBeVisible()
  page.once('dialog', (dialog) => dialog.accept())
  await row.getByRole('button', { name: '删除 Production API', exact: true }).click()
  await expect(page.getByRole('table', { name: '凭据列表' })).toContainText('没有匹配的凭据')
})

test('discarding the account view prevents a delayed secret value from being copied after logout', async ({ page, backend }) => {
  await openVault(page, backend)
  const secret = await createSecret(page)
  let release!: () => void
  let requested!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  const started = new Promise<void>((resolve) => { requested = resolve })
  await page.route(`${backend.url}/api/v1/me/secrets/${secret.id}/value`, async (route) => {
    const response = await route.fetch()
    requested()
    await held
    await route.fulfill({ response })
  })
  await page.getByRole('button', { name: '复制密钥 Production API', exact: true }).click()
  await started
  try {
    await page.getByRole('button', { name: '退出', exact: true }).click()
    await expect(page.locator('#main')).toBeEmpty()
  } finally { release() }
  await page.waitForLoadState('networkidle')
  expect(await page.evaluate(() => (window as Window & { __vaultCopied: string[] }).__vaultCopied)).toEqual([])
  await expect(page.locator('[data-vault-value]')).toHaveCount(0)
  expect(await page.evaluate(() => sessionStorage.getItem('tie.me.token'))).toBeNull()
})

test('switching workspaces discards an in-flight value before the new workspace finishes loading', async ({ page, backend }) => {
  await openVault(page, backend)
  const secret = await createSecret(page)
  let releaseValue!: () => void
  let valueRequested!: () => void
  const valueHeld = new Promise<void>((resolve) => { releaseValue = resolve })
  const valueStarted = new Promise<void>((resolve) => { valueRequested = resolve })
  await page.route(`${backend.url}/api/v1/me/secrets/${secret.id}/value`, async (route) => {
    const response = await route.fetch()
    valueRequested()
    await valueHeld
    await route.fulfill({ response })
  })
  let releaseList!: () => void
  let listRequested!: () => void
  const listHeld = new Promise<void>((resolve) => { releaseList = resolve })
  const listStarted = new Promise<void>((resolve) => { listRequested = resolve })
  await page.route(`${backend.url}/api/v1/me/secrets?**`, async (route) => {
    if (new URL(route.request().url()).searchParams.get('workspaceId') !== backend.secondWorkspaceId) return route.continue()
    listRequested()
    await listHeld
    await route.fulfill({ json: [] })
  })
  await page.getByRole('button', { name: '复制密钥 Production API', exact: true }).click()
  await valueStarted
  try {
    await page.getByRole('combobox', { name: '凭据库工作区', exact: true }).selectOption(backend.secondWorkspaceId)
    await listStarted
    await expect(page.locator('[data-secret-id]')).toHaveCount(0)
    const completedValue = page.waitForResponse((response) => response.url().endsWith(`/secrets/${secret.id}/value`))
    releaseValue()
    await (await completedValue).finished()
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
    expect(await page.evaluate(() => (window as Window & { __vaultCopied: string[] }).__vaultCopied)).toEqual([])
    await expect(page.locator('[data-vault-value]')).toHaveCount(0)
  } finally { releaseValue(); releaseList() }
  await expect(page.getByRole('table', { name: '凭据列表' })).toContainText('没有匹配的凭据')
})
