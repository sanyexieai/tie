import { expect, test } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.clear()
  })
})

async function waitForWorkspace(page: import('@playwright/test').Page) {
  await page.goto('/')
  await expect(page.locator('.editor-pane')).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('.workspace-heading')).toContainText('我的知识库')
}

test('loads browser demo workspace', async ({ page }) => {
  await waitForWorkspace(page)
  await expect(page).toHaveTitle('Tie')
  await expect(page.getByRole('tree', { name: '我的页面' }).getByRole('treeitem', { name: /欢迎使用 Tie/ })).toBeVisible()
})

test('opens welcome page from sidebar', async ({ page }) => {
  await waitForWorkspace(page)
  await page.getByRole('tree', { name: '我的页面' }).getByRole('treeitem', { name: /欢迎使用 Tie/ }).click()
  await expect(page.locator('.breadcrumbs').getByRole('button', { name: '欢迎使用 Tie' })).toBeVisible()
  await expect(page.getByRole('textbox', { name: '页面标题' })).toHaveValue('欢迎使用 Tie')
})

test('exports markdown in browser mode', async ({ page }) => {
  await waitForWorkspace(page)
  const downloadPromise = page.waitForEvent('download')
  await page.getByTitle('导出 Markdown').click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toMatch(/欢迎使用 Tie\.md$/i)
})
