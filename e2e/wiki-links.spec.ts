import { expect, test, type Page } from '@playwright/test'

const source = '# 开发\n\n## 产品入口\n\n| 入口 | 查什么 |\n| --- | --- |\n| [[产品文档]] | 产品 |\n| [[映集 | 本地媒体管理系统]] | 媒体 |\n| [媒体入口](tie://page/pg_media) | 标准链接 |\n\n参见 [[产品文档]] 和 [[未创建的页面]]。\n\n示例：`[[产品文档]]`、\\[\\[产品文档\\]\\]。'

async function openWorkspace(page: Page) {
  await page.route('**/health', (route) => route.fulfill({ json: { ok: true, mcp: { enabled: false, running: false } } }))
  await page.addInitScript((markdown) => {
    if (localStorage.getItem('tie-demo-workspace-v1')) return
    const sourceId = 'source-demo-local'
    const pages = [
      { id: 'pg_index', title: '开发', markdown },
      { id: 'pg_product', title: '产品文档', markdown: '# 产品文档\n\n产品正文' },
      { id: 'pg_media', title: '映集 | 本地媒体管理系统', markdown: '# 映集 | 本地媒体管理系统\n\n媒体正文' },
    ].map((item, sortKey) => ({ ...item, sortKey, icon: '', parentId: null, tags: [],
      storageSourceId: sourceId, storageSourceIds: [sourceId], createdAt: '2026-11-26T00:00:00Z', updatedAt: '2026-11-26T00:00:00Z', deletedAt: null }))
    localStorage.setItem('tie-demo-workspace-v1', JSON.stringify({
      workspace: { id: 'wiki-test', name: '链接测试', sources: [{ id: sourceId, name: '演示工作区', path: 'localStorage', kind: 'local', available: true }] }, pages,
    }))
  }, source)
  await page.goto('/')
  await expect(page.locator('.tiptap')).toBeVisible()
  const onboarding = page.getByRole('dialog', { name: '绑定服务器' })
  await expect(onboarding).toBeVisible()
  await onboarding.getByRole('button', { name: '关闭', exact: true }).click()
  await page.getByRole('tree', { name: '我的页面' }).getByRole('treeitem', { name: /开发/ }).click()
}

test('opens imported wiki links from tables and paragraphs', async ({ page }) => {
  await openWorkspace(page)
  await expect(page.locator('.tiptap tr')).toHaveCount(4)
  await expect(page.locator('.tiptap tr').nth(2).locator('td')).toHaveCount(2)
  const productLink = page.locator('.tiptap td').getByRole('link', { name: '产品文档', exact: true })
  await expect(productLink).toHaveAttribute('href', 'tie://page/pg_product')
  await expect(page.locator('.tiptap td').getByRole('link', { name: '映集 | 本地媒体管理系统', exact: true })).toHaveAttribute('href', 'tie://page/pg_media')
  await expect(page.locator('.tiptap a.wiki-link-unresolved')).toHaveAttribute('data-wiki-title', '未创建的页面')
  await expect(page.locator('.tiptap a[data-wiki-title="产品文档"]')).toHaveCount(2)
  await expect(page.locator('.tiptap code')).toHaveText('[[产品文档]]')

  await productLink.click()
  await expect(page.getByRole('textbox', { name: '页面标题' })).toHaveValue('产品文档')
  await page.getByRole('tree', { name: '我的页面' }).getByRole('treeitem', { name: /开发/ }).click()
  await page.locator('.tiptap > p').getByRole('link', { name: '产品文档', exact: true }).click()
  await expect(page.getByRole('textbox', { name: '页面标题' })).toHaveValue('产品文档')
})

test('keeps wiki links and table columns after an edit, save and reopen', async ({ page }) => {
  await openWorkspace(page)
  await page.locator('.tiptap').press('Control+End')
  await page.keyboard.press('Enter')
  await page.keyboard.type('保存测试')
  await page.keyboard.press('Control+s')
  await expect.poll(async () => page.evaluate(() => {
    const snapshot = JSON.parse(localStorage.getItem('tie-demo-workspace-v1')!)
    return snapshot.pages.find((item: { id: string }) => item.id === 'pg_index').markdown as string
  })).toContain('保存测试')
  const saved = await page.evaluate(() => {
    const snapshot = JSON.parse(localStorage.getItem('tie-demo-workspace-v1')!)
    return snapshot.pages.find((item: { id: string }) => item.id === 'pg_index').markdown as string
  })
  expect(saved).toContain('[[产品文档]]')
  expect(saved).toContain('[[映集 \\| 本地媒体管理系统]]')
  expect(saved).toContain('[[未创建的页面]]')
  await page.reload()
  await expect(page.locator('.tiptap tr')).toHaveCount(4)
  await expect(page.locator('.tiptap tr').nth(2).locator('td')).toHaveCount(2)
  await expect(page.locator('.tiptap td').getByRole('link', { name: '映集 | 本地媒体管理系统', exact: true })).toHaveAttribute('href', 'tie://page/pg_media')
  await expect(page.locator('.tiptap')).toContainText('保存测试')
})
