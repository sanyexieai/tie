import { expect, test, type Page } from '@playwright/test'

test.use({ permissions: ['clipboard-read', 'clipboard-write'] })

test.beforeEach(async ({ page }) => {
  await page.route('**/health', (route) => route.fulfill({ json: { ok: true, service: 'tie-backend', mcp: { enabled: false, running: false, url: null } } }))
  await page.addInitScript(() => localStorage.clear())
  await page.goto('/')
  const onboarding = page.getByRole('dialog', { name: '绑定服务器' })
  await expect(onboarding).toBeVisible()
  await onboarding.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(page.locator('.tiptap')).toBeVisible()
})

async function setContent(page: Page, markdown: string, selection?: { from: number; to?: number }) {
  await page.locator('.tiptap').evaluate((element, input) => {
    const editor = (element as HTMLElement & { editor: import('@tiptap/core').Editor }).editor
    editor.commands.setContent(input.markdown, { contentType: 'markdown' })
    if (input.selection) editor.commands.setTextSelection({ from: input.selection.from, to: input.selection.to ?? input.selection.from })
  }, { markdown, selection })
}

const menu = (page: Page) => page.getByRole('menu', { name: '正文编辑', exact: true })

async function dragText(page: Page, start: number, end: number) {
  const points = await page.locator('.tiptap > p').first().evaluate((element, range) => {
    const text = element.firstChild!
    const point = (offset: number) => {
      const position = document.createRange()
      position.setStart(text, offset)
      position.setEnd(text, offset)
      const rect = position.getBoundingClientRect()
      return { x: rect.left, y: rect.top + rect.height / 2 }
    }
    return { from: point(range.start), to: point(range.end) }
  }, { start, end })
  await page.mouse.move(points.from.x, points.from.y)
  await page.mouse.down()
  await page.mouse.move(points.to.x, points.to.y, { steps: 8 })
  await page.mouse.up()
  return points
}

test('formats and unformats the real mouse selection when right click falls beside its highlight', async ({ page }) => {
  for (const [label, tag] of [['加粗', 'strong'], ['斜体', 'em'], ['删除线', 's'], ['行内代码', 'code']]) {
    await setContent(page, '前缀需要格式的正文尾部')
    const points = await dragText(page, 2, 6)
    await page.mouse.click(points.to.x + 40, points.to.y, { button: 'right' })
    await menu(page).getByRole('menuitemcheckbox', { name: label, exact: true }).click()
    await expect(page.locator(`.tiptap > p ${tag}`)).toHaveText('需要格式')
    await page.locator(`.tiptap > p ${tag}`).click({ button: 'right' })
    await menu(page).getByRole('menuitemcheckbox', { name: label, exact: true }).click()
    await expect(page.locator(`.tiptap > p ${tag}`)).toHaveCount(0)
    await expect(page.locator('.tiptap > p')).toHaveText('前缀需要格式的正文尾部')
  }
})

test('formats the selected live-source text through the same menu and keeps both neighboring paragraphs', async ({ page }) => {
  await setContent(page, '前缀需要加粗的正文尾部\n\n相邻段落。')
  await page.getByRole('button', { name: '即时源码', exact: true }).click()
  await page.locator('.tiptap > p').first().click()
  const source = page.getByRole('textbox', { name: '当前块 Markdown 源码', exact: true })
  await expect(source).toBeVisible()
  await source.press('Home')
  await source.press('ArrowRight')
  await source.press('ArrowRight')
  for (let index = 0; index < 4; index += 1) await source.press('Shift+ArrowRight')
  await source.click({ button: 'right', position: { x: 15, y: 15 } })
  await menu(page).getByRole('menuitemcheckbox', { name: '加粗', exact: true }).click()
  await expect(page.locator('.tiptap > p strong')).toHaveText('需要加粗')
  await expect(page.locator('.tiptap > p').last()).toHaveText('相邻段落。')
})

test('offers table insertion from the main menu before the document contains any table', async ({ page }) => {
  await setContent(page, '表前段落。')
  await page.locator('.tiptap > p').click({ button: 'right' })
  await menu(page).getByRole('menuitem', { name: '表格', exact: true }).hover()
  await page.getByRole('menu', { name: '表格', exact: true }).getByRole('menuitem', { name: '插入表格', exact: true }).click()
  await expect(page.locator('.tiptap table')).toHaveCount(1)
  await expect(page.locator('.tiptap table tr')).toHaveCount(3)
  await expect(page.locator('.tiptap table tr').first().locator('th')).toHaveCount(3)
})

test('right click targets the clicked paragraph and reuses paragraph and insert commands', async ({ page }) => {
  await setContent(page, '第一段正文\n\n第二段正文', { from: 2 })
  await page.locator('.tiptap > p').nth(1).click({ button: 'right', position: { x: 25, y: 12 } })
  await expect(menu(page)).toBeVisible()
  await expect(menu(page).getByRole('menuitem', { name: '复制', exact: true })).toBeDisabled()
  await menu(page).getByRole('menuitem', { name: '段落', exact: true }).hover()
  await page.getByRole('menu', { name: '段落', exact: true }).getByRole('menuitem', { name: '二级标题', exact: true }).click()
  await expect(page.locator('.tiptap > h2')).toHaveText('第二段正文')
  await expect(page.locator('.tiptap > p').first()).toHaveText('第一段正文')
  await page.locator('.tiptap > h2').click({ button: 'right' })
  await menu(page).getByRole('menuitem', { name: '插入', exact: true }).hover()
  await page.getByRole('menu', { name: '插入', exact: true }).getByRole('menuitem', { name: '分割线', exact: true }).click()
  await expect(page.locator('.tiptap hr')).toHaveCount(1)
})

test('long selections keep their range for formatting and short selections keep discussion actions', async ({ page }) => {
  const text = '较长的一段文字'.repeat(45)
  await setContent(page, text, { from: 1, to: text.length + 1 })
  await page.locator('.tiptap > p').click({ button: 'right', position: { x: 35, y: 10 } })
  await expect(menu(page)).toBeVisible()
  await expect(menu(page).getByRole('menuitem', { name: '展开为子页面', exact: true })).toHaveCount(0)
  await expect(menu(page).getByRole('menuitem', { name: '提出异议', exact: true })).toHaveCount(0)
  await menu(page).getByRole('menuitemcheckbox', { name: '加粗', exact: true }).click()
  await expect(page.locator('.tiptap strong')).toHaveText(text)
  await setContent(page, '需要确认的原文', { from: 1, to: 9 })
  await page.locator('.tiptap > p').click({ button: 'right', position: { x: 20, y: 10 } })
  await menu(page).getByRole('menuitem', { name: '提出异议', exact: true }).click()
  await expect(page.locator('.pheromone-draft')).toBeVisible()
  await expect(page.locator('.pheromone-draft')).toContainText('需要确认的原文')
})

test('copy and paste preserve rich formatting, links and paragraph breaks', async ({ page }) => {
  await setContent(page, '**第一段粗体**\n\n第二段 [链接](https://example.com/path)')
  await page.locator('.tiptap').evaluate((element) => (element as HTMLElement & { editor: import('@tiptap/core').Editor }).editor.commands.selectAll())
  await page.locator('.tiptap > p').first().click({ button: 'right', position: { x: 20, y: 10 } })
  await menu(page).getByRole('menuitem', { name: '复制', exact: true }).click()
  await expect(menu(page)).toBeHidden()
  await expect.poll(async () => page.evaluate(() => navigator.clipboard.readText())).toContain('\n')
  const html = await page.evaluate(async () => {
    const items = await navigator.clipboard.read()
    return (await items[0]!.getType('text/html')).text()
  })
  expect(html).toContain('<strong>第一段粗体</strong>')
  expect(html).toContain('https://example.com/path')
  await setContent(page, '')
  await page.locator('.tiptap > p').click({ button: 'right' })
  await menu(page).getByRole('menuitem', { name: '粘贴', exact: true }).click()
  await expect(page.locator('.tiptap strong')).toHaveText('第一段粗体')
  await expect(page.locator('.tiptap a')).toHaveAttribute('href', 'https://example.com/path')
  await expect(page.locator('.tiptap > p')).toHaveCount(2)
})

test('table menu edits the clicked table and supports undo', async ({ page }) => {
  await setContent(page, '| 名称 | 状态 |\n| --- | --- |\n| 第一行 | 正常 |')
  await page.locator('.tiptap td').first().click({ button: 'right' })
  await menu(page).getByRole('menuitem', { name: '表格', exact: true }).hover()
  await page.getByRole('menu', { name: '表格', exact: true }).getByRole('menuitem', { name: '在下方插入行', exact: true }).click()
  await expect(page.locator('.tiptap tr')).toHaveCount(3)
  await page.locator('.tiptap td').first().click({ button: 'right' })
  await menu(page).getByRole('menuitem', { name: '撤销', exact: true }).click()
  await expect(page.locator('.tiptap tr')).toHaveCount(2)
})

test('keyboard menus close correctly and stay inside the viewport', async ({ page }) => {
  await setContent(page, '菜单键盘导航', { from: 2 })
  await page.locator('.tiptap').evaluate((element) => (element as HTMLElement & { editor: import('@tiptap/core').Editor }).editor.view.focus())
  await page.keyboard.press('Shift+F10')
  await expect(menu(page)).toBeVisible()
  await page.keyboard.press('End')
  await expect(menu(page).getByRole('menuitem', { name: '编辑此块源码', exact: true })).toBeFocused()
  await page.keyboard.press('ArrowUp')
  await expect(menu(page).getByRole('menuitem', { name: '添加链接', exact: true })).toBeFocused()
  await page.keyboard.press('ArrowUp')
  await expect(menu(page).getByRole('menuitem', { name: '插入', exact: true })).toBeFocused()
  await page.keyboard.press('ArrowRight')
  await expect(page.getByRole('menu', { name: '插入', exact: true })).toBeVisible()
  const firstInsertAction = page.getByRole('menu', { name: '插入', exact: true }).getByRole('menuitem').first()
  await expect(firstInsertAction).toBeFocused()
  await page.locator('.tiptap').evaluate((element) => {
    const editor = (element as HTMLElement & { editor: import('@tiptap/core').Editor }).editor
    editor.view.dispatch(editor.state.tr.setMeta('menu-status-refresh', true))
  })
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  await expect(menu(page).getByRole('menuitem', { name: '插入', exact: true })).toHaveAttribute('aria-expanded', 'true')
  await expect(firstInsertAction).toBeFocused()
  await page.keyboard.press('ArrowLeft')
  await expect(page.getByRole('menu', { name: '插入', exact: true })).toBeHidden()
  await page.keyboard.press('Escape')
  await expect(menu(page)).toBeHidden()
  await expect(page.locator('.tiptap')).toBeFocused()
  const viewport = page.viewportSize()!
  await page.locator('.tiptap').evaluate((element, viewport) => element.dispatchEvent(new MouseEvent('contextmenu', {
    clientX: viewport.width - 2, clientY: viewport.height - 2, bubbles: true, cancelable: true,
  })), viewport)
  await expect(menu(page)).toBeVisible()
  const box = (await menu(page).boundingBox())!
  expect(box.x).toBeGreaterThanOrEqual(8)
  expect(box.y).toBeGreaterThanOrEqual(8)
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width - 7)
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height - 7)
})

test('refreshes the table submenu to insertion actions when the editor selection leaves the table', async ({ page }) => {
  await setContent(page, '表格外的段落。\n\n| 名称 | 状态 |\n| --- | --- |\n| 第一行 | 正常 |')
  await page.locator('.tiptap td').first().click({ button: 'right' })
  await menu(page).getByRole('menuitem', { name: '表格', exact: true }).hover()
  await expect(page.getByRole('menu', { name: '表格', exact: true })).toBeVisible()
  await page.locator('.tiptap').evaluate((element) => {
    const editor = (element as HTMLElement & { editor: import('@tiptap/core').Editor }).editor
    editor.commands.setTextSelection(1)
  })
  await expect(menu(page)).toBeVisible()
  await expect(menu(page).getByRole('menuitem', { name: '表格', exact: true })).toBeVisible()
  await expect(page.getByRole('menu', { name: '表格', exact: true }).getByRole('menuitem')).toHaveCount(1)
  await expect(page.getByRole('menu', { name: '表格', exact: true }).getByRole('menuitem', { name: '插入表格', exact: true })).toBeVisible()
})
