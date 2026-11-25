import { expect, test } from '@playwright/test'

test('reconnects backend notifications with the renewed login token', async ({ page }) => {
  await page.clock.install()
  const endpoint = 'https://backend.example.test'
  const user = { id: 'usr_live', name: 'Live Test', email: 'live@example.test', createdAt: '' }
  const profile = {
    endpoint, user, accessToken: 'access-initial', refreshToken: 'refresh-initial',
    accessExpiresAt: new Date(Date.now() + 180_000).toISOString(),
  }
  await page.addInitScript((saved) => {
    localStorage.clear()
    localStorage.setItem('tie-backend-profile-v1', JSON.stringify(saved))
  }, profile)
  await page.route(`${endpoint}/**`, (route) => {
    const path = new URL(route.request().url()).pathname
    let body: unknown
    if (path === '/api/v1/me') body = user
    else if (path === '/health') body = { ok: true }
    else if (path === '/api/v1/workspaces') {
      body = [{ id: 'ws_live', name: '我的工作区', default: true, ownerId: user.id }]
    } else if (path === '/api/v1/auth/refresh') {
      body = {
        user, tokenType: 'Bearer', accessToken: 'access-renewed', refreshToken: 'refresh-renewed',
        accessExpiresAt: new Date(Date.now() + 600_000).toISOString(),
      }
    } else body = []
    return route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify(body),
      headers: {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': '*',
        'access-control-allow-methods': 'GET,POST,OPTIONS',
      },
    })
  })
  const helloTokens: string[] = []
  await page.routeWebSocket('wss://backend.example.test/api/v1/live', (socket) => {
    socket.onMessage((raw) => {
      const message = JSON.parse(String(raw)) as { type: string; token?: string }
      if (message.type === 'hello' && message.token) helloTokens.push(message.token)
    })
  })

  await page.goto('/')
  await expect.poll(() => helloTokens).toEqual(['access-initial'])
  await page.clock.fastForward(65_000)
  await expect.poll(() => helloTokens).toEqual(['access-initial', 'access-renewed'])
})
