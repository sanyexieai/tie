import { expect, test, type Locator, type Page } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  await page.route('**/health', (route) => route.fulfill({ json: { ok: true, service: 'tie-backend', mcp: { enabled: false, running: false, url: null } } }))
  await page.addInitScript(() => localStorage.clear())
  await page.goto('/')
  await page.getByRole('dialog', { name: '绑定服务器' }).getByRole('button', { name: '关闭', exact: true }).click()
  await expect(page.locator('.tiptap')).toBeVisible()
})

const source = (page: Page) => page.getByRole('textbox', { name: '当前块 Markdown 源码', exact: true })
const region = (page: Page) => page.getByRole('region', { name: '当前块 Markdown 源码', exact: true })

async function setContent(page: Page, markdown: string) {
  await page.locator('.tiptap').evaluate((element, content) => {
    ;(element as HTMLElement & { editor: import('@tiptap/core').Editor }).editor.commands.setContent(content, { contentType: 'markdown' })
  }, markdown)
}

async function typography(locator: Locator) {
  return locator.evaluate((element) => {
    const style = getComputedStyle(element)
    return { family: style.fontFamily, size: style.fontSize, weight: style.fontWeight, lineHeight: style.lineHeight, spacing: style.letterSpacing }
  })
}

test('keeps live paragraph typography and spacing without an editor panel or fixed minimum height', async ({ page }) => {
  await setContent(page, '这里是可以直接编辑的段落。\n\n这是相邻的正文。')
  const paragraph = page.locator('.tiptap > p').first()
  const before = (await paragraph.boundingBox())!
  const adjacentBefore = (await page.locator('.tiptap > p').last().boundingBox())!
  const font = await typography(paragraph)
  await page.getByRole('button', { name: '即时源码', exact: true }).click()
  await paragraph.click()
  await expect(source(page)).toHaveValue('这里是可以直接编辑的段落。')
  await expect(region(page).locator('header')).toHaveCount(0)
  await expect(region(page).getByRole('button')).toHaveCount(0)
  expect(await typography(source(page))).toEqual(font)
  const inputBox = (await source(page).boundingBox())!
  const adjacentAfter = (await page.locator('.tiptap > p').last().boundingBox())!
  expect(Math.abs(inputBox.x - before.x)).toBeLessThan(1)
  expect(Math.abs(inputBox.y - before.y)).toBeLessThan(1)
  expect(Math.abs(inputBox.width - before.width)).toBeLessThan(1)
  expect(Math.abs(inputBox.height - before.height)).toBeLessThan(1)
  expect(Math.abs(adjacentAfter.y - adjacentBefore.y)).toBeLessThan(1)
  const styles = await source(page).evaluate((element) => {
    const input = getComputedStyle(element)
    const panel = getComputedStyle(element.closest('[data-block-source-editor]')!)
    return { border: panel.borderWidth, background: panel.backgroundColor, outline: input.outlineStyle, resize: input.resize, padding: input.padding, minHeight: input.minHeight }
  })
  expect(styles).toEqual({ border: '0px', background: 'rgba(0, 0, 0, 0)', outline: 'none', resize: 'none', padding: '0px', minHeight: '0px' })
  await source(page).press('Escape')
  await expect(region(page)).toBeHidden()
})

for (const first of [true, false]) {
  test(`uses the rendered heading metrics ${first ? 'at the start of the document' : 'between paragraphs'}`, async ({ page }) => {
    await setContent(page, `${first ? '' : '前面的正文。\n\n'}## 二级标题\n\n后面的正文。`)
    const heading = page.locator('.tiptap > h2')
    const before = (await heading.boundingBox())!
    const adjacentBefore = (await page.locator('.tiptap > p').last().boundingBox())!
    const font = await typography(heading)
    await page.getByRole('button', { name: '即时源码', exact: true }).click()
    await heading.click()
    await expect(source(page)).toHaveValue('## 二级标题')
    expect(await typography(source(page))).toEqual(font)
    const inputBox = (await source(page).boundingBox())!
    const adjacentAfter = (await page.locator('.tiptap > p').last().boundingBox())!
    expect(Math.abs(inputBox.y - before.y)).toBeLessThan(1)
    expect(Math.abs(inputBox.height - before.height)).toBeLessThan(1)
    expect(Math.abs(adjacentAfter.y - adjacentBefore.y)).toBeLessThan(1)
    await source(page).fill('### 三级标题')
    await expect.poll(() => typography(source(page))).toEqual(await typography(page.locator('.tiptap > h3')))
    await source(page).fill('恢复为普通正文。')
    await expect.poll(() => typography(source(page))).toEqual(await typography(page.locator('.tiptap > p').first()))
    await expect(region(page).getByRole('button')).toHaveCount(0)
    await source(page).fill('- 复杂结构保留显式应用')
    await expect(region(page).getByRole('button', { name: '应用', exact: true })).toBeVisible()
    await expect(region(page).getByRole('button', { name: '取消', exact: true })).toBeVisible()
    await region(page).getByRole('button', { name: '取消', exact: true }).click()
    await expect(region(page)).toBeHidden()
  })
}
