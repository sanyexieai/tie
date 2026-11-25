import { test as base, expect } from '@playwright/test'
import { once } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const backendEntry = fileURLToPath(new URL('../backend/src/app.js', import.meta.url))
const password = 'browser-test-password'

const test = base.extend<{ backend: string }>({
  backend: async ({}, use) => {
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'tie-account-browser-'))
    process.env.TIE_DATA_DIR = data
    process.env.NODE_ENV = 'test'
    const { createApp } = await import(pathToFileURL(backendEntry).href)
    const server = createApp({ jwtSecret: 'browser-test-secret-at-least-32-characters' }).listen(0, '127.0.0.1')
    try {
      await once(server, 'listening')
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Test backend did not bind a port')
      await use(`http://127.0.0.1:${address.port}`)
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      fs.rmSync(data, { recursive: true, force: true })
    }
  },
})

async function seedAccount(backend: string, name: string, email: string) {
  const response = await fetch(`${backend}/api/v1/auth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, email, password }),
  })
  expect(response.ok).toBeTruthy()
}

async function register(page: import('@playwright/test').Page, name: string, email: string) {
  await page.locator('#gate-switch').click()
  await page.locator('#name-field input').fill(name)
  await page.locator('#account-field input').fill(email)
  await page.locator('input[name="password"]').fill(password)
  await page.locator('#gate-submit').click()
}

test('the first account registers directly into the administrator console', async ({ page, backend }) => {
  await page.goto(`${backend}/admin/`)
  await register(page, 'First Admin', 'admin@example.test')
  await expect(page).toHaveURL(`${backend}/admin/`)
  await expect(page.locator('#shell')).toHaveClass(/\bon\b/)
  await expect(page.locator('#main').getByRole('heading', { name: '概览', exact: true })).toBeVisible()
  await expect(page.locator('#who')).toContainText('First Admin')
  await expect(page.locator('#login')).toBeHidden()
})

test('a normal account registered through admin enters me without signing in again', async ({ page, backend }) => {
  await seedAccount(backend, 'Admin', 'admin@example.test')
  await page.goto(`${backend}/admin/`)
  await register(page, 'New Reader', 'reader@example.test')
  await expect(page).toHaveURL(`${backend}/me/`)
  await expect(page.locator('#who')).toContainText('New Reader')
  await expect(page.locator('#main').getByRole('heading', { name: '工作区', exact: true })).toBeVisible()
  await expect(page.locator('#login')).toBeHidden()
  let refreshRequests = 0
  page.on('request', (request) => {
    if (request.url().endsWith('/api/v1/auth/refresh')) refreshRequests += 1
  })
  await page.reload()
  await expect(page.locator('#who')).toContainText('New Reader')
  expect(refreshRequests).toBe(0)
})

test('a normal account signing in through admin is redirected with its session', async ({ page, backend }) => {
  await seedAccount(backend, 'Admin', 'admin@example.test')
  await seedAccount(backend, 'Existing Reader', 'reader@example.test')
  await page.goto(`${backend}/admin/`)
  await page.locator('#account-field input').fill('Existing Reader')
  await page.locator('input[name="password"]').fill(password)
  await page.locator('#gate-submit').click()
  await expect(page).toHaveURL(`${backend}/me/`)
  await expect(page.locator('#who')).toContainText('Existing Reader')
  await page.locator('#logout').click()
  await page.reload()
  await expect(page.locator('#login')).toBeVisible()
  await expect(page.locator('#shell')).not.toHaveClass(/\bon\b/)
})

test('registration in me immediately opens account management', async ({ page, backend }) => {
  await seedAccount(backend, 'Admin', 'admin@example.test')
  await page.goto(`${backend}/me/`)
  await register(page, 'Account Reader', 'account@example.test')
  await expect(page).toHaveURL(`${backend}/me/`)
  await expect(page.locator('#who')).toContainText('Account Reader')
  await expect(page.locator('#main').getByRole('heading', { name: '工作区', exact: true })).toBeVisible()
  await expect(page.locator('#login')).toBeHidden()
})

test('registration errors remain visible without entering an authenticated screen', async ({ page, backend }) => {
  await seedAccount(backend, 'Admin', 'admin@example.test')
  await page.goto(`${backend}/me/`)
  await register(page, 'Different Name', 'admin@example.test')
  await expect(page.locator('#login-error')).toContainText('邮箱已注册')
  await expect(page.locator('#login')).toBeVisible()
  await expect(page.locator('#shell')).not.toHaveClass(/\bon\b/)
})
