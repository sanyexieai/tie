import { expect, test, type Locator, type Page } from '@playwright/test'

const originalMarkdown = '# 第一页\n\n开头相邻段落。\n\n目标段落带 **粗体** 和 [页面链接](tie://page/pg_source_second)。\n\n结尾相邻段落。'

test.beforeEach(async ({ page }) => {
  await page.route('**/health', (route) => route.fulfill({ json: { ok: true, service: 'tie-backend', mcp: { enabled: false, running: false, url: null } } }))
  await page.addInitScript((markdown) => {
    localStorage.clear()
    const at = '2026-11-27T00:00:00.000Z'
    const sourceId = 'source-demo-local'
    const makePage = (id: string, title: string, body: string, sortKey: number) => ({
      id, title, markdown: body, icon: '', parentId: null, sortKey, tags: [],
      createdAt: at, updatedAt: at, deletedAt: null, storageSourceId: sourceId, storageSourceIds: [sourceId],
    })
    localStorage.setItem('tie-demo-workspace-v1', JSON.stringify({
      workspace: { id: 'local-demo', name: '我的知识库', sources: [{ id: sourceId, name: '浏览器演示工作区', path: 'localStorage', kind: 'local', available: true }] },
      pages: [makePage('pg_source_first', '第一页', markdown, 0), makePage('pg_source_second', '第二页', '# 第二页\n\n第二页正文。', 1)],
    }))
  }, originalMarkdown)
  await page.goto('/')
  await expect(page.locator('.editor-pane')).toBeVisible({ timeout: 15_000 })
  const onboarding = page.getByRole('dialog', { name: '绑定服务器' })
  await expect(onboarding).toBeVisible()
  await onboarding.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(page.getByRole('textbox', { name: '页面标题', exact: true })).toHaveValue('第一页')
})

function sourceRegion(page: Page) { return page.getByRole('region', { name: '当前块 Markdown 源码', exact: true }) }
function sourceInput(page: Page) { return sourceRegion(page).getByRole('textbox', { name: '当前块 Markdown 源码', exact: true }) }

async function editBlock(page: Page, target: Locator) {
  await target.click({ button: 'right' })
  await page.getByRole('menuitem', { name: '编辑此块源码', exact: true }).click()
  await expect(sourceRegion(page)).toBeVisible()
  return sourceInput(page)
}

async function storedMarkdown(page: Page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem('tie-demo-workspace-v1')!).pages.find((item: { id: string }) => item.id === 'pg_source_first').markdown as string)
}

async function setEditorMarkdown(page: Page, markdown: string) {
  const normalized = await page.locator('.tiptap').evaluate((element, content) => {
    const editor = (element as HTMLElement & { editor: import('@tiptap/core').Editor }).editor
    editor.commands.setContent(content, { contentType: 'markdown' })
    return editor.getMarkdown()
  }, markdown)
  await expect.poll(() => storedMarkdown(page)).toContain(normalized)
}

test('edits one block and keeps adjacent content, page links and a single rich-editor undo step', async ({ page }) => {
  const source = await editBlock(page, page.locator('.tiptap p').filter({ hasText: '目标段落带' }))
  await expect(source).toHaveValue('目标段落带 **粗体** 和 [页面链接](tie://page/pg_source_second)。')
  await source.fill('更新的 **粗体** 和 [页面链接](tie://page/pg_source_second)。')
  await sourceRegion(page).getByRole('button', { name: '应用', exact: true }).click()
  await expect(sourceRegion(page)).toBeHidden()
  await expect(page.locator('.tiptap strong')).toHaveText('粗体')
  await expect(page.locator('.tiptap a[href="tie://page/pg_source_second"]')).toHaveText('页面链接')
  await expect(page.locator('.tiptap p').first()).toHaveText('开头相邻段落。')
  await expect(page.locator('.tiptap p').last()).toHaveText('结尾相邻段落。')
  await page.getByTitle('撤销（Ctrl/Cmd + Z）', { exact: true }).click()
  await expect(page.locator('.tiptap')).toContainText('目标段落带')
  await expect(page.locator('.tiptap')).not.toContainText('更新的')
  await page.getByTitle('重做（Ctrl/Cmd + Shift + Z）', { exact: true }).click()
  await expect(page.locator('.tiptap')).toContainText('更新的')
})

test('opens a complete top-level list and table instead of replacing only a nested text node', async ({ page }) => {
  await setEditorMarkdown(page, '前面。\n\n- 第一项\n  - 嵌套项\n- 第二项\n\n后面。')
  let source = await editBlock(page, page.locator('.tiptap li').filter({ hasText: '嵌套项' }).last())
  expect(await source.inputValue()).toContain('第一项')
  expect(await source.inputValue()).toContain('嵌套项')
  expect(await source.inputValue()).toContain('第二项')
  await source.fill('- 修改第一项\n  - 保留嵌套\n- 修改第二项')
  await sourceRegion(page).getByRole('button', { name: '应用', exact: true }).click()
  await expect(page.locator('.tiptap > ul > li')).toHaveCount(2)
  await expect(page.locator('.tiptap > ul ul li')).toHaveText('保留嵌套')
  await expect(page.locator('.tiptap > p').first()).toHaveText('前面。')
  await expect(page.locator('.tiptap > p').last()).toHaveText('后面。')

  await setEditorMarkdown(page, '表前。\n\n| 分类 | 链接 |\n| --- | --- |\n| 页面 | [第二页](tie://page/pg_source_second) |\n\n表后。')
  source = await editBlock(page, page.locator('.tiptap td').first())
  expect(await source.inputValue()).toContain('分类')
  expect(await source.inputValue()).toContain('tie://page/pg_source_second')
  await source.fill('| 分类 | 链接 |\n| --- | --- |\n| 修改分类 | [第二页](tie://page/pg_source_second) |')
  await sourceRegion(page).getByRole('button', { name: '应用', exact: true }).click()
  await expect(page.locator('.tiptap table')).toContainText('修改分类')
  await expect(page.locator('.tiptap table a')).toHaveAttribute('href', 'tie://page/pg_source_second')
  await expect(page.locator('.tiptap > p').first()).toHaveText('表前。')
  await expect(page.locator('.tiptap > p').last()).toHaveText('表后。')
})

test('does not autosave an explicit source draft before Apply and Cancel restores the original document', async ({ page }) => {
  await page.clock.install()
  const source = await editBlock(page, page.locator('.tiptap p').filter({ hasText: '目标段落带' }))
  await source.fill('取消后不应保存的临时改动')
  await expect(page.locator('.save-state')).toContainText('未保存')
  await page.clock.runFor(1200)
  expect(await storedMarkdown(page)).toBe(originalMarkdown)
  await sourceRegion(page).getByRole('button', { name: '取消', exact: true }).click()
  await expect(sourceRegion(page)).toBeHidden()
  await expect(page.locator('.tiptap')).toContainText('目标段落带')
  await page.clock.runFor(1200)
  expect(await storedMarkdown(page)).toBe(originalMarkdown)
  await expect(page.locator('.save-state')).not.toContainText('未保存')
})

test('flushes an explicit block draft through Ctrl+S and page navigation without requiring Apply', async ({ page }) => {
  let source = await editBlock(page, page.locator('.tiptap p').filter({ hasText: '目标段落带' }))
  await source.fill('通过 Ctrl+S 保存的 **段落**。')
  await source.press('Control+s')
  await expect.poll(() => storedMarkdown(page)).toContain('通过 Ctrl+S 保存的 **段落**。')
  if (await sourceRegion(page).isVisible()) await sourceRegion(page).getByRole('button', { name: '应用', exact: true }).click()
  source = await editBlock(page, page.locator('.tiptap p').filter({ hasText: '通过 Ctrl+S 保存' }))
  await source.fill('切页前也需要保留的草稿。')
  await page.getByRole('treeitem', { name: /第二页/ }).click()
  await expect(page.getByRole('textbox', { name: '页面标题', exact: true })).toHaveValue('第二页')
  expect(await storedMarkdown(page)).toContain('切页前也需要保留的草稿。')
  await page.getByRole('treeitem', { name: /第一页/ }).click()
  await expect(page.locator('.tiptap')).toContainText('切页前也需要保留的草稿。')
})

test('saves a pending source block before quick navigation unmounts the editor', async ({ page }) => {
  let source = await editBlock(page, page.locator('.tiptap p').filter({ hasText: '目标段落带' }))
  await source.fill('打开搜索之前保存的源码草稿。')
  await page.locator('.quick-nav').getByRole('button', { name: /搜索/ }).click()
  await expect(page.locator('.search-view')).toBeVisible()
  expect(await storedMarkdown(page)).toContain('打开搜索之前保存的源码草稿。')
  await page.getByRole('treeitem', { name: /第一页/ }).click()
  source = await editBlock(page, page.locator('.tiptap p').filter({ hasText: '打开搜索之前保存' }))
  await source.fill('打开收藏之前保存的源码草稿。')
  await page.locator('.quick-nav').getByRole('button', { name: /收藏/ }).click()
  await expect(page.locator('.library-view')).toBeVisible()
  expect(await storedMarkdown(page)).toContain('打开收藏之前保存的源码草稿。')
  await page.getByRole('treeitem', { name: /第一页/ }).click()
  await expect(page.locator('.tiptap')).toContainText('打开收藏之前保存的源码草稿。')
})

test('keeps the current page and source draft while Chinese composition is active, then saves completed input', async ({ page }) => {
  const source = await editBlock(page, page.locator('.tiptap p').filter({ hasText: '目标段落带' }))
  await source.dispatchEvent('compositionstart', { data: '' })
  await page.locator('.quick-nav').getByRole('button', { name: /搜索/ }).click()
  await expect(page.locator('.search-view')).toHaveCount(0)
  await expect(source).toBeVisible()
  await source.fill('输入中的中')
  await source.press('Control+s')
  expect(await storedMarkdown(page)).toBe(originalMarkdown)
  await page.locator('.quick-nav').getByRole('button', { name: /搜索/ }).click()
  await expect(page.locator('.search-view')).toHaveCount(0)
  await expect(source).toHaveValue('输入中的中')
  await page.locator('.quick-nav').getByRole('button', { name: /收藏/ }).click()
  await expect(page.getByRole('textbox', { name: '页面标题', exact: true })).toHaveValue('第一页')
  await expect(source).toHaveValue('输入中的中')
  await page.getByRole('button', { name: /新建页面/ }).click()
  await expect(page.getByRole('treeitem')).toHaveCount(2)
  await expect(page.getByRole('textbox', { name: '页面标题', exact: true })).toHaveValue('第一页')
  await page.getByRole('treeitem', { name: /第二页/ }).click()
  await expect(page.getByRole('textbox', { name: '页面标题', exact: true })).toHaveValue('第一页')
  await expect(source).toHaveValue('输入中的中')
  await source.dispatchEvent('compositionend', { data: '中文' })
  await source.fill('已经完成的中文输入。')
  await source.press('Control+s')
  await expect.poll(() => storedMarkdown(page)).toContain('已经完成的中文输入。')
})

test('applies a pending source draft before opening the different block chosen by right-click', async ({ page }) => {
  let source = await editBlock(page, page.locator('.tiptap p').filter({ hasText: '目标段落带' }))
  await source.fill('旧草稿的第一段。\n\n旧草稿的第二段。')
  source = await editBlock(page, page.locator('.tiptap p').filter({ hasText: '结尾相邻段落。' }))
  await expect(source).toHaveValue('结尾相邻段落。')
  await expect(page.locator('.tiptap p').filter({ hasText: '旧草稿的第一段。' })).toBeVisible()
  await expect(page.locator('.tiptap p').filter({ hasText: '旧草稿的第二段。' })).toBeVisible()
  await source.fill('结尾也改好。')
  await sourceRegion(page).getByRole('button', { name: '应用', exact: true }).click()
  await expect(page.locator('.tiptap p').first()).toHaveText('开头相邻段落。')
  await expect(page.locator('.tiptap p').last()).toHaveText('结尾也改好。')
  await expect.poll(() => storedMarkdown(page)).toContain('旧草稿的第一段。\n\n旧草稿的第二段。\n\n结尾也改好。')
})

test('maps source drafts around neighboring transactions and preserves a conflicting draft when its target changes', async ({ page }) => {
  let source = await editBlock(page, page.locator('.tiptap p').filter({ hasText: '目标段落带' }))
  await source.fill('源码应用后的目标段落。')
  await page.locator('.tiptap').evaluate((element) => {
    const editor = (element as HTMLElement & { editor: import('@tiptap/core').Editor }).editor
    editor.view.dispatch(editor.state.tr.insertText('邻居新增内容：', 1))
  })
  await expect(source).toHaveValue('源码应用后的目标段落。')
  await expect(sourceRegion(page).getByRole('alert')).toHaveCount(0)
  await sourceRegion(page).getByRole('button', { name: '应用', exact: true }).click()
  await expect(page.locator('.tiptap p').first()).toHaveText('邻居新增内容：开头相邻段落。')
  await expect(page.locator('.tiptap p').filter({ hasText: '源码应用后的目标段落。' })).toBeVisible()
  await expect.poll(() => storedMarkdown(page)).toContain('源码应用后的目标段落。')
  const savedBeforeConflict = await storedMarkdown(page)

  source = await editBlock(page, page.locator('.tiptap p').filter({ hasText: '源码应用后的目标段落。' }))
  await source.fill('发生冲突后仍需保留的未应用源码。')
  await page.locator('.tiptap').evaluate((element) => {
    const editor = (element as HTMLElement & { editor: import('@tiptap/core').Editor }).editor
    const targets: Array<{ from: number; to: number }> = []
    editor.state.doc.descendants((node, position) => {
      if (node.isText && node.text === '源码应用后的目标段落。') targets.push({ from: position, to: position + node.nodeSize })
    })
    const target = targets[0]
    if (!target) throw new Error('The edited source target was not found')
    editor.view.dispatch(editor.state.tr.insertText('另一条编辑更新了目标。', target.from, target.to))
  })
  await expect(sourceRegion(page).getByRole('alert')).toContainText(/已更新|其他编辑/)
  await expect(source).toHaveValue('发生冲突后仍需保留的未应用源码。')
  await source.press('Control+s')
  expect(await storedMarkdown(page)).toBe(savedBeforeConflict)
  await expect(source).toHaveValue('发生冲突后仍需保留的未应用源码。')
  await sourceRegion(page).getByRole('button', { name: '取消', exact: true }).click()
  await expect(sourceRegion(page)).toBeHidden()
  await expect(page.locator('.tiptap')).toContainText('另一条编辑更新了目标。')
  await expect(page.locator('.tiptap p').first()).toHaveText('邻居新增内容：开头相邻段落。')
  await expect.poll(() => storedMarkdown(page)).toContain('另一条编辑更新了目标。')
  expect(await storedMarkdown(page)).not.toContain('发生冲突后仍需保留的未应用源码。')
})

test('collapses a whole-document selection after applying one source block so typing cannot replace neighboring blocks', async ({ page }) => {
  await page.locator('.tiptap').evaluate((element) => {
    ;(element as HTMLElement & { editor: import('@tiptap/core').Editor }).editor.commands.selectAll()
  })
  const source = await editBlock(page, page.locator('.tiptap p').first())
  await source.fill('修改第一段。')
  await sourceRegion(page).getByRole('button', { name: '应用', exact: true }).click()
  await page.keyboard.insertText('继续输入')
  await expect(page.locator('.tiptap p').first()).toContainText('修改第一段。继续输入')
  await expect(page.locator('.tiptap p').filter({ hasText: '目标段落带' })).toBeVisible()
  await expect(page.locator('.tiptap p').last()).toHaveText('结尾相邻段落。')
})
