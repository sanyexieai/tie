import { expect, test, type Page } from '@playwright/test'

const endpoint = 'https://mcp-handoff.example.test'
const mcpUrl = `${endpoint}/mcp`

type McpStatus = { enabled: boolean; running: boolean; url: string | null }

async function openBrowserAgentSettings(page: Page, mcp: McpStatus) {
  const user = { id: 'usr_http', name: 'HTTP User', email: 'http@example.test', createdAt: '' }
  const workspace = { id: 'ws_http', name: 'HTTP 知识库', default: true, ownerId: user.id }
  const remotePage = {
    id: 'pg_http', title: '只在服务器的知识', icon: '', parentId: null, sortKey: 0,
    markdown: '# 只在服务器的知识\n\n通过浏览器访问远程工作区。', tags: [],
    createdAt: '2026-11-25T00:00:00Z', updatedAt: '2026-11-25T00:00:00Z', deletedAt: null,
  }
  const unexpectedRequests: string[] = []
  const backendWrites: string[] = []
  const pageErrors: string[] = []
  const health = {
    requests: 0, status: 200, pending: null as Promise<void> | null,
    body: { ok: true, service: 'tie-backend', mcp },
  }
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.addInitScript((profile) => {
    localStorage.clear()
    localStorage.setItem('tie-backend-profile-v1', JSON.stringify(profile))
    localStorage.setItem('tie-backend-servers-v1', JSON.stringify([
      { id: 'http-fixture', endpoint: profile.endpoint, defaultPrompt: false },
    ]))
    const copied: string[] = []
    Object.defineProperty(window, '__tieCopiedMcpPrompts', { value: copied })
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (text: string) => { copied.push(text) } },
    })
  }, {
    endpoint, user, accessToken: 'browser-session-fixture', refreshToken: null,
    accessExpiresAt: new Date(Date.now() + 600_000).toISOString(),
  })
  await page.route('**/*', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.origin === 'http://127.0.0.1:4173') return route.continue()
    if (url.origin !== endpoint) {
      unexpectedRequests.push(request.url())
      return route.abort()
    }
    const headers = {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': '*',
      'access-control-allow-methods': 'GET,OPTIONS',
    }
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers })
    if (request.method() !== 'GET') backendWrites.push(`${request.method()} ${url.pathname}`)
    let body: unknown
    if (url.pathname === '/health') {
      health.requests += 1
      if (health.pending) await health.pending
      return route.fulfill({
        status: health.status, contentType: 'application/json', headers, body: JSON.stringify(health.body),
      })
    } else if (url.pathname === '/api/v1/me') body = user
    else if (url.pathname === '/api/v1/workspaces') body = [workspace]
    else if (url.pathname === '/api/v1/providers' || url.pathname === '/api/v1/me/mcp-tokens' || url.pathname === `/api/v1/workspaces/${workspace.id}/sources`) body = []
    else if (url.pathname === `/api/v1/workspaces/${workspace.id}/pages`) body = [remotePage]
    else if (url.pathname === `/api/v1/workspaces/${workspace.id}/pages/${remotePage.id}`) body = remotePage
    else if (url.pathname === `/api/v1/workspaces/${workspace.id}/files`) body = { files: [] }
    else {
      unexpectedRequests.push(request.url())
      return route.abort()
    }
    return route.fulfill({ status: 200, contentType: 'application/json', headers, body: JSON.stringify(body) })
  })
  await page.routeWebSocket('**/*', () => {})

  await page.goto('/')
  await expect(page.getByRole('textbox', { name: '页面标题' })).toHaveValue(remotePage.title)
  await expect(page.getByRole('dialog', { name: '绑定服务器' })).toBeHidden()
  expect(await page.evaluate(() => ({
    tauri: '__TAURI_INTERNALS__' in window || '__TAURI__' in window,
    demoWorkspace: localStorage.getItem('tie-demo-workspace-v1'),
  }))).toEqual({ tauri: false, demoWorkspace: null })

  await page.locator('.sidebar-storage-trigger').click()
  const settings = page.getByRole('dialog', { name: '设置', exact: true })
  await settings.getByRole('button', { name: 'Agent 知识库', exact: true }).click()
  const copy = settings.getByRole('button', { name: '复制接入提示词', exact: true })
  await expect(copy).toBeVisible()
  await expect(settings.getByRole('button', { name: /(?:接入|更新).*(?:客户端|桥接)|管理 Skills|复制桥接提示词|复制 HTTP 提示词/ })).toHaveCount(0)
  await expect(settings.locator('.codex-mcp-form button[type="submit"]')).toHaveCount(0)
  await expect(settings.getByRole('group', { name: '接入客户端' })).toHaveCount(0)
  await page.waitForLoadState('networkidle')
  const copiedPrompts = () => page.evaluate(() => (
    window as Window & { __tieCopiedMcpPrompts: string[] }
  ).__tieCopiedMcpPrompts)
  async function expectNoLocalEffects() {
    expect(await page.evaluate(() => localStorage.getItem('tie-codex-mcp-v1'))).toBeNull()
    await expect(settings.getByRole('button', { name: /(?:安装|构建).*(?:CLI|Tie)|管理 Skills/i })).toHaveCount(0)
    expect(backendWrites).toEqual([])
    expect(unexpectedRequests).toEqual([])
    expect(pageErrors).toEqual([])
  }
  await expectNoLocalEffects()
  return { settings, copy, health, copiedPrompts, expectNoLocalEffects }
}

test('copies a fixed HTTP handoff only after the browser confirms the current server endpoint', async ({ page }) => {
  const cachedUrl = `${endpoint}/cached/mcp`
  const { settings, copy, health, copiedPrompts, expectNoLocalEffects } = await openBrowserAgentSettings(page, {
    enabled: true, running: true, url: cachedUrl,
  })
  await expect(copy).toBeEnabled()
  const previousRequests = health.requests
  let releaseHealth!: () => void
  health.pending = new Promise<void>((resolve) => { releaseHealth = resolve })
  try {
    await copy.click()
    await expect.poll(() => health.requests).toBe(previousRequests + 1)
    expect(await copiedPrompts()).toEqual([])
    health.body.mcp = { enabled: true, running: true, url: mcpUrl }
  } finally {
    health.pending = null
    releaseHealth()
  }
  await expect(settings.getByRole('button', { name: '已复制', exact: true })).toBeVisible()
  const copied = await copiedPrompts()
  expect(copied).toHaveLength(1)
  const prompt = copied[0]!
  expect(prompt).toContain(mcpUrl)
  expect(prompt).toMatch(/Authorization.{0,8}Bearer <MCP token>/)
  expect(prompt).toContain('tie_doctor')
  expect(prompt).toMatch(/transport:\s*["']http["']/)
  expect(prompt).not.toContain(cachedUrl)
  expect(prompt).not.toMatch(/\/health|tie_connection|\b(?:CLI|Skills?)\b|localWorkspace|本地|本机|降级/i)
  expect(prompt).not.toMatch(/\b(?:command|args|TIE_WORKSPACE)\b|tie mcp|SKILL\.md|tie-mcp-connect|tie-upgrade-cli|file:\/\/|\/(?:home|Users|mnt|tmp)\/|[A-Za-z]:\\|~\//)
  expect(prompt).not.toContain('browser-session-fixture')
  await expectNoLocalEffects()
})

test('explains disabled HTTP MCP without offering a local prompt or CLI installation', async ({ page }) => {
  const { settings, copy, copiedPrompts, expectNoLocalEffects } = await openBrowserAgentSettings(page, {
    enabled: false, running: false, url: null,
  })
  await expect(copy).toBeDisabled()
  await expect(settings.locator('.codex-mcp-form')).toContainText(/未开启|未启用/)
  expect(await copiedPrompts()).toEqual([])
  await expectNoLocalEffects()
})

test('does not copy the cached HTTP URL when the pre-copy server check fails', async ({ page }) => {
  const { settings, copy, health, copiedPrompts, expectNoLocalEffects } = await openBrowserAgentSettings(page, {
    enabled: true, running: true, url: mcpUrl,
  })
  await expect(copy).toBeEnabled()
  const previousRequests = health.requests
  let releaseHealth!: () => void
  health.pending = new Promise<void>((resolve) => { releaseHealth = resolve })
  try {
    await copy.click()
    await expect.poll(() => health.requests).toBe(previousRequests + 1)
    expect(await copiedPrompts()).toEqual([])
    health.status = 503
    health.body.ok = false
  } finally {
    health.pending = null
    releaseHealth()
  }
  await expect(settings.locator('.codex-mcp-form')).toContainText(/无法|不可用|失败|异常|未确认|未连接|未启动/)
  await expect(copy).toBeDisabled()
  await expect(settings.getByRole('button', { name: '已复制', exact: true })).toHaveCount(0)
  expect(await copiedPrompts()).toEqual([])
  await expectNoLocalEffects()
})
