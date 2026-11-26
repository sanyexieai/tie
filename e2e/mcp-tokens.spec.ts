import { expect, test as base, type Page } from '@playwright/test'
import { once } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

type Session = {
  accessToken: string
  refreshToken: string
  accessExpiresAt: string
  user: { id: string; name: string; email: string; createdAt: string }
}
type Backend = {
  url: string
  data: string
  session: Session
  workspaceId: string
}
const test = base.extend<{ backend: Backend }>({
  backend: async ({}, use) => {
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'tie-mcp-token-browser-'))
    process.env.TIE_DATA_DIR = data
    process.env.NODE_ENV = 'test'
    const entry = fileURLToPath(new URL('../backend/src/app.js', import.meta.url))
    const { createApp } = await import(pathToFileURL(entry).href)
    const server = createApp({ jwtSecret: 'mcp-token-browser-test-secret-over-32-characters' }).listen(0, '127.0.0.1')
    try {
      await once(server, 'listening')
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Test backend did not bind a port')
      const url = `http://127.0.0.1:${address.port}`
      const registered = await fetch(`${url}/api/v1/auth/register`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Token Owner', email: 'token-owner@example.test', password: 'browser-test-password' }),
      })
      expect(registered.status).toBe(200)
      const session = await registered.json() as Session
      const response = await fetch(`${url}/api/v1/workspaces`, { headers: { authorization: `Bearer ${session.accessToken}` } })
      const workspaces = await response.json() as { id: string }[]
      await use({ url, data, session, workspaceId: workspaces[0]!.id })
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      fs.rmSync(data, { recursive: true, force: true })
    }
  },
})

async function listTokens(backend: Backend) {
  const response = await fetch(`${backend.url}/api/v1/me/mcp-tokens`, {
    headers: { authorization: `Bearer ${backend.session.accessToken}` },
  })
  return response.json() as Promise<{ id: string; name: string; canReveal: boolean }[]>
}

async function issueToken(backend: Backend, name: string) {
  const response = await fetch(`${backend.url}/api/v1/me/mcp-tokens`, {
    method: 'POST', headers: { authorization: `Bearer ${backend.session.accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name, workspaceId: backend.workspaceId }),
  })
  expect(response.status).toBe(201)
  return response.json() as Promise<{ record: { id: string }; token: string }>
}

async function prepareMe(page: Page, backend: Backend) {
  await page.addInitScript((session) => {
    sessionStorage.setItem('tie.me.token', JSON.stringify(session))
    const copied: string[] = []
    Object.defineProperty(window, '__tieCopiedTokens', { value: copied })
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true, value: { writeText: async (text: string) => { copied.push(text) } },
    })
  }, backend.session)
  await page.goto(`${backend.url}/me/`)
  await expect(page.locator('#who')).toContainText('Token Owner')
  await expect(page.locator('#main h3').filter({ hasText: /^MCP 令牌$/ })).toBeVisible()
}

test('the server dialog signs and revokes tokens without fetching or exposing their secrets', async ({ page, backend }) => {
  const secretRequests: string[] = []
  const issuedBodies: unknown[] = []
  page.on('request', (request) => {
    if (/\/mcp-tokens\/[^/]+\/secret$/.test(new URL(request.url()).pathname)) secretRequests.push(request.url())
    if (request.method() === 'POST' && request.url().endsWith('/api/v1/me/mcp-tokens')) issuedBodies.push(request.postDataJSON())
  })
  await page.addInitScript((profile) => {
    localStorage.clear()
    localStorage.setItem('tie-backend-profile-v1', JSON.stringify(profile))
    localStorage.setItem('tie-backend-servers-v1', JSON.stringify([{ id: 'token-test', endpoint: profile.endpoint, defaultPrompt: false }]))
  }, { ...backend.session, endpoint: backend.url })
  await page.routeWebSocket('**/*', () => {})
  await page.goto('/')
  await page.locator('.sidebar-storage-trigger').click()
  await page.getByRole('dialog', { name: '设置', exact: true }).getByRole('button', { name: '服务器', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '绑定服务器', exact: true })
  const toggle = dialog.getByRole('button', { name: 'MCP 令牌', exact: true })
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await toggle.click()
  const panel = dialog.getByRole('group', { name: 'MCP 令牌管理' })
  await expect(panel).toContainText('还没有 MCP 令牌')
  await panel.getByLabel('令牌名称', { exact: true }).fill('Dialog Agent')
  const issued = page.waitForResponse((response) => response.request().method() === 'POST' && response.url().endsWith('/api/v1/me/mcp-tokens'))
  await panel.getByRole('button', { name: '签发令牌', exact: true }).click()
  const response = await issued
  expect(response.status()).toBe(201)
  const body = await response.json()
  expect(Object.keys(body)).toEqual(['record'])
  expect(body.record.canReveal).toBe(true)
  expect(issuedBodies).toEqual([{ name: 'Dialog Agent', workspaceId: backend.workspaceId, reveal: false }])
  await expect(panel.locator('strong')).toHaveText('Dialog Agent')
  await expect(panel).toContainText('已签发')
  await expect(panel).not.toContainText(/tmcp_/)
  await expect(panel.getByRole('button', { name: /^(查看|复制|隐藏)$/ })).toHaveCount(0)
  expect((await listTokens(backend)).map((token) => token.name)).toEqual(['Dialog Agent'])
  const popupReady = page.waitForEvent('popup')
  await panel.getByRole('button', { name: '前往我的账号查看与复制', exact: true }).click()
  const popup = await popupReady
  await expect(popup).toHaveURL(`${backend.url}/me/`)
  await popup.close()
  await panel.getByRole('button', { name: '作废 Dialog Agent', exact: true }).click()
  await expect(panel).toContainText('还没有 MCP 令牌')
  expect(await listTokens(backend)).toEqual([])
  expect(secretRequests).toEqual([])
})

test('my account reveals and copies existing tokens only on request and can issue and revoke them', async ({ page, backend }) => {
  const issued = await issueToken(backend, 'Existing Agent')
  let secretRequests = 0
  page.on('request', (request) => {
    if (request.url().endsWith(`/${issued.record.id}/secret`)) secretRequests += 1
  })
  await prepareMe(page, backend)
  const row = page.getByRole('row').filter({ hasText: 'Existing Agent' })
  await expect(row.locator('[data-token-secret]')).toBeHidden()
  expect(secretRequests).toBe(0)
  const secretResponse = page.waitForResponse((response) => response.url().endsWith(`/${issued.record.id}/secret`))
  await row.getByRole('button', { name: '查看', exact: true }).click()
  expect((await secretResponse).headers()['cache-control']).toBe('no-store')
  await expect(row.locator('[data-token-secret]')).toHaveText(issued.token)
  await row.getByRole('button', { name: '隐藏', exact: true }).click()
  await expect(row.locator('[data-token-secret]')).toBeEmpty()
  await expect(row.locator('[data-token-secret]')).toBeHidden()
  await row.getByRole('button', { name: '复制', exact: true }).click()
  await expect(row.locator('[data-token-feedback]')).toHaveText('令牌已复制。')
  expect(await page.evaluate(() => (window as Window & { __tieCopiedTokens: string[] }).__tieCopiedTokens)).toEqual([issued.token])
  expect(secretRequests).toBe(2)
  await page.reload()
  await expect(row.locator('[data-token-secret]')).toBeHidden()
  expect(secretRequests).toBe(2)
  await page.locator('#token input[name="name"]').fill('Account Agent')
  await page.locator('#token button[type="submit"]').click()
  await expect(page.locator('#issued code')).toContainText(/^tmcp_/)
  expect((await listTokens(backend)).map((token) => token.name)).toEqual(['Existing Agent', 'Account Agent'])
  await row.getByRole('button', { name: '作废', exact: true }).click()
  await expect(row).toHaveCount(0)
  expect((await listTokens(backend)).map((token) => token.name)).toEqual(['Account Agent'])
})

test('legacy token secrets explain reissuing without automatically revoking the existing authorization', async ({ page, backend }) => {
  const issued = await issueToken(backend, 'Legacy Agent')
  await prepareMe(page, backend)
  const row = page.getByRole('row').filter({ hasText: 'Legacy Agent' })
  await expect(row.getByRole('button', { name: '查看', exact: true })).toBeVisible()
  const tokenFile = path.join(backend.data, 'mcp-tokens.json')
  const records = JSON.parse(fs.readFileSync(tokenFile, 'utf8')) as { id: string; encryptedToken?: unknown }[]
  delete records.find((record) => record.id === issued.record.id)!.encryptedToken
  fs.writeFileSync(tokenFile, JSON.stringify(records))
  await row.getByRole('button', { name: '查看', exact: true }).click()
  await expect(row.locator('[data-token-feedback]')).toContainText('重新签发')
  await expect(row.locator('[data-token-feedback]')).toContainText('原令牌仍可继续使用')
  expect((await listTokens(backend)).map((token) => token.id)).toEqual([issued.record.id])
  await page.reload()
  await expect(row).toContainText('旧令牌无法恢复，请重新签发；原授权仍有效')
  await expect(row.getByRole('button', { name: /^(查看|复制)$/ })).toHaveCount(0)
  await expect(row.getByRole('button', { name: '作废', exact: true })).toBeVisible()
})

test('logging out discards an in-flight token secret without copying or showing it', async ({ page, backend }) => {
  const issued = await issueToken(backend, 'Delayed Agent')
  await prepareMe(page, backend)
  let releaseSecret!: () => void
  const released = new Promise<void>((resolve) => { releaseSecret = resolve })
  let secretRequested!: () => void
  const requested = new Promise<void>((resolve) => { secretRequested = resolve })
  await page.route(`${backend.url}/api/v1/me/mcp-tokens/${issued.record.id}/secret`, async (route) => {
    const response = await route.fetch()
    secretRequested()
    await released
    await route.fulfill({ response })
  })
  const row = page.getByRole('row').filter({ hasText: 'Delayed Agent' })
  await row.getByRole('button', { name: '复制', exact: true }).click()
  await requested
  try {
    await page.locator('#logout').click()
    await expect(page.locator('#login')).toBeVisible()
    await expect(page.locator('#main')).toBeEmpty()
  } finally { releaseSecret() }
  await page.waitForLoadState('networkidle')
  expect(await page.evaluate(() => (window as Window & { __tieCopiedTokens: string[] }).__tieCopiedTokens)).toEqual([])
  expect(await page.evaluate(() => sessionStorage.getItem('tie.me.token'))).toBeNull()
  await expect(page.locator('#main')).toBeEmpty()
  await expect(page.locator('[data-token-secret]')).toHaveCount(0)
})
