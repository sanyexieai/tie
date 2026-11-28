import { expect, test, type Locator, type Page } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  await page.route('**/health', (route) => route.fulfill({ json: { ok: true, service: 'tie-backend', mcp: { enabled: false, running: false, url: null } } }))
  await page.addInitScript(() => {
    localStorage.clear()
    const at = '2026-11-28T00:00:00.000Z'
    const sourceId = 'source-demo-local'
    const titles = ['第一页', '第二页', '第三页', '第四页']
    localStorage.setItem('tie-demo-workspace-v1', JSON.stringify({
      workspace: { id: 'local-demo', name: '我的知识库', sources: [{ id: sourceId, name: '浏览器演示工作区', path: 'localStorage', kind: 'local', available: true }] },
      pages: titles.map((title, index) => ({
        id: `pg_navigation_${index}`, title, markdown: `# ${title}\n\n${title}正文。 [其他页](tie://page/pg_navigation_3)`, icon: '', parentId: null,
        sortKey: index, tags: [], createdAt: at, updatedAt: at, deletedAt: null, storageSourceId: sourceId, storageSourceIds: [sourceId],
      })),
    }))
  })
  await page.goto('/')
  await expect(page.locator('.tiptap')).toBeVisible()
  const binding = page.getByRole('dialog', { name: '绑定服务器' })
  if (await binding.isVisible()) await binding.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(title(page)).toHaveValue('第一页')
})

const title = (page: Page) => page.getByRole('textbox', { name: '页面标题', exact: true })

async function openPage(page: Page, name: string) {
  await page.getByRole('treeitem', { name: new RegExp(name) }).click()
  await expect(title(page)).toHaveValue(name)
}

async function sideButton(page: Page, direction: 'back' | 'forward', target: Locator = page.locator('.editor-pane')) {
  const box = await target.boundingBox()
  if (!box) throw new Error('The side-button target is not visible')
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  const cdp = await page.context().newCDPSession(page)
  try {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: direction, buttons: direction === 'back' ? 8 : 16, clickCount: 1 })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: direction, buttons: 0, clickCount: 1 })
  } finally { await cdp.detach() }
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}

test('uses mouse side buttons for in-app back and forward without activating a hovered link or leaving Tie', async ({ page }) => {
  const url = page.url()
  await openPage(page, '第二页')
  await page.locator('.tiptap > p').click({ position: { x: 10, y: 10 } })
  await page.locator('.tiptap > p').click({ position: { x: 10, y: 10 } })
  await openPage(page, '第三页')
  await page.locator('.tiptap > p').click({ position: { x: 10, y: 10 } })
  await sideButton(page, 'back', page.locator('.tiptap a').first())
  await expect(title(page)).toHaveValue('第二页')
  await expect(page).toHaveURL(url)
  await sideButton(page, 'back')
  await expect(title(page)).toHaveValue('第一页')
  await sideButton(page, 'back')
  await expect(title(page)).toHaveValue('第一页')
  await expect(page).toHaveURL(url)
  await sideButton(page, 'forward', page.locator('.tiptap a').first())
  await expect(title(page)).toHaveValue('第二页')
  await sideButton(page, 'forward')
  await expect(title(page)).toHaveValue('第三页')
  await sideButton(page, 'back')
  await expect(title(page)).toHaveValue('第二页')
  await openPage(page, '第四页')
  await sideButton(page, 'forward')
  await expect(title(page)).toHaveValue('第四页')
  await sideButton(page, 'back')
  await expect(title(page)).toHaveValue('第二页')
})

test('does not consume history during source composition and saves the completed draft before returning', async ({ page }) => {
  await openPage(page, '第二页')
  await page.locator('.tiptap > p').click({ button: 'right' })
  await page.getByRole('menuitem', { name: '编辑此块源码', exact: true }).click()
  const source = page.getByRole('textbox', { name: '当前块 Markdown 源码', exact: true })
  await source.dispatchEvent('compositionstart', { data: '' })
  await source.fill('返回前需要保存的源码草稿。')
  await sideButton(page, 'back', source)
  await expect(title(page)).toHaveValue('第二页')
  await expect(source).toHaveValue('返回前需要保存的源码草稿。')
  await source.dispatchEvent('compositionend', { data: '草稿。' })
  await sideButton(page, 'back', source)
  await expect(title(page)).toHaveValue('第一页')
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('tie-demo-workspace-v1')!).pages.find((item: { id: string }) => item.id === 'pg_navigation_1').markdown)
  expect(saved).toContain('返回前需要保存的源码草稿。')
})

test('keeps a failed-save page and retries the same history step after storage becomes writable', async ({ page }) => {
  await openPage(page, '第二页')
  await page.evaluate(() => {
    const original = Storage.prototype.setItem
    Object.assign(window, { restoreNavigationStorage: () => { Storage.prototype.setItem = original } })
    Storage.prototype.setItem = function (key, value) {
      if (key === 'tie-demo-workspace-v1') throw new DOMException('The browser storage is full', 'QuotaExceededError')
      original.call(this, key, value)
    }
  })
  await page.locator('.tiptap > p').fill('需要重试保存的正文。')
  await sideButton(page, 'back')
  await expect(title(page)).toHaveValue('第二页')
  await expect(page.locator('.tiptap')).toContainText('需要重试保存的正文。')
  await page.evaluate(() => (window as Window & { restoreNavigationStorage: () => void }).restoreNavigationStorage())
  await sideButton(page, 'back')
  await expect(title(page)).toHaveValue('第一页')
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('tie-demo-workspace-v1')!).pages.find((item: { id: string }) => item.id === 'pg_navigation_1').markdown)
  expect(saved).toContain('需要重试保存的正文。')
})

test('returns from search to its current page before consuming page history', async ({ page }) => {
  await openPage(page, '第二页')
  await page.locator('.quick-nav').getByRole('button', { name: /搜索/ }).click()
  await expect(page.locator('.search-view')).toBeVisible()
  await sideButton(page, 'back', page.locator('.search-view'))
  await expect(title(page)).toHaveValue('第二页')
  await expect(page.locator('.search-view')).toHaveCount(0)
  await sideButton(page, 'back')
  await expect(title(page)).toHaveValue('第一页')
})
