import { expect, test, type Page } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  await page.route('**/health', (route) => route.fulfill({ json: { ok: true, service: 'tie-backend', mcp: { enabled: false, running: false, url: null } } }))
  await page.addInitScript(() => {
    localStorage.clear()
    const sourceId = 'source-demo-local'
    const at = '2026-11-28T00:00:00.000Z'
    const makePage = (id: string, title: string, parentId: string | null, sortKey: number, body = '页面正文。') => ({
      id, title, parentId, sortKey, markdown: `# ${title}\n\n${body}`, icon: '', tags: [],
      createdAt: at, updatedAt: at, deletedAt: null, storageSourceId: sourceId, storageSourceIds: [sourceId],
    })
    const pages = [
      makePage('pg_start', '起点页面', null, 0, '[打开深层页面](tie://page/pg_current)'),
      makePage('pg_other', '无关分类', null, 1),
      makePage('pg_other_child', '无关子页面', 'pg_other', 0),
      ...Array.from({ length: 45 }, (_, i) => makePage(`pg_before_${i}`, `前面的页面 ${i + 1}`, null, i + 2)),
      makePage('pg_root', '目标分类', null, 50),
      makePage('pg_middle', '第二层分类', 'pg_root', 0),
      makePage('pg_current', '深层页面', 'pg_middle', 0, '这是深层页面的正文。'),
      makePage('pg_current_child', '下一层页面', 'pg_current', 0),
      ...Array.from({ length: 25 }, (_, i) => makePage(`pg_after_${i}`, `后面的页面 ${i + 1}`, null, i + 51)),
    ]
    localStorage.setItem('tie-demo-workspace-v1', JSON.stringify({
      workspace: { id: 'local-demo', name: '我的知识库', sources: [{ id: sourceId, name: '浏览器演示工作区', path: 'localStorage', kind: 'local', available: true }] }, pages,
    }))
    localStorage.setItem('tie-workspace-preferences-v1:local-demo', JSON.stringify({
      favoritePageIds: [], recentPageIds: ['pg_start'], collapsedPageIds: ['pg_root', 'pg_middle', 'pg_current', 'pg_other'],
      spellcheckEnabled: true, sourceMode: false, storageSourceOrder: [], skillsSectionCollapsed: true,
    }))
  })
  await page.goto('/')
  const onboarding = page.getByRole('dialog', { name: '绑定服务器' })
  await expect(onboarding).toBeVisible()
  await onboarding.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(page.getByRole('textbox', { name: '页面标题', exact: true })).toHaveValue('起点页面')
})

const tree = (page: Page) => page.locator('.sidebar [role="tree"]')
const row = (page: Page, id: string) => tree(page).locator(`[data-page-tree-id="${id}"]`)

async function expectCurrentRowVisible(page: Page) {
  await expect(row(page, 'pg_current')).toHaveAttribute('aria-selected', 'true')
  await expect(row(page, 'pg_current')).toHaveClass(/active/)
  await expect.poll(async () => {
    const viewport = await tree(page).boundingBox()
    const current = await row(page, 'pg_current').boundingBox()
    return Boolean(viewport && current && current.y >= viewport.y - 1 && current.y + current.height <= viewport.y + viewport.height + 1)
  }).toBe(true)
}

test('opening a deep linked page expands its ancestors and reveals its selected row in a long tree', async ({ page }) => {
  await page.getByRole('link', { name: '打开深层页面', exact: true }).click()
  await expect(page.getByRole('textbox', { name: '页面标题', exact: true })).toHaveValue('深层页面')
  await expect(row(page, 'pg_root')).toHaveAttribute('aria-expanded', 'true')
  await expect(row(page, 'pg_middle')).toHaveAttribute('aria-expanded', 'true')
  await expectCurrentRowVisible(page)
  await expect(row(page, 'pg_other')).toHaveAttribute('aria-expanded', 'false')
  await expect(row(page, 'pg_current')).toHaveAttribute('aria-expanded', 'false')
})

for (const mode of ['rich', 'source'] as const) {
  test(`clicking the ${mode} body reopens the current path and scrolls the tree without stealing editing focus`, async ({ page }) => {
    await page.getByRole('link', { name: '打开深层页面', exact: true }).click()
    await expectCurrentRowVisible(page)
    if (mode === 'source') await page.getByRole('button', { name: '</> 源码', exact: true }).click()
    await row(page, 'pg_root').getByRole('button', { name: '收起子页面', exact: true }).click()
    await expect(row(page, 'pg_current')).toHaveCount(0)
    await tree(page).evaluate((element) => { element.scrollTop = 0 })

    const editor = mode === 'source'
      ? page.getByRole('textbox', { name: 'Markdown 源码', exact: true })
      : page.locator('.tiptap')
    if (mode === 'source') await editor.click()
    else await page.locator('.tiptap > p').first().click()
    await expectCurrentRowVisible(page)
    await expect(editor).toBeFocused()
    await page.keyboard.press('End')
    await page.keyboard.insertText('继续编辑')
    if (mode === 'source') await expect(editor).toHaveValue(/继续编辑/)
    else await expect(editor).toContainText('继续编辑')
    await expect(row(page, 'pg_current')).toHaveAttribute('aria-expanded', 'false')
    await expect(row(page, 'pg_other')).toHaveAttribute('aria-expanded', 'false')
    await expect.poll(() => page.evaluate(() => {
      const saved = JSON.parse(localStorage.getItem('tie-demo-workspace-v1')!)
      return saved.pages.find((item: { id: string }) => item.id === 'pg_current').markdown as string
    })).toContain('继续编辑')
  })
}
