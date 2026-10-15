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
  // A fresh profile offers cloud sign-in before local demo interactions.
  const onboarding = page.getByRole('dialog', { name: '连接云服务' })
  await expect(onboarding).toBeVisible()
  await onboarding.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(onboarding).toBeHidden()
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

test('renders Mermaid, recovers from invalid syntax, and preserves markdown', async ({ page }) => {
  await waitForWorkspace(page)
  const setMarkdown = async (markdown: string) => page.locator('.tiptap').evaluate((element, content) => {
    const editor = (element as HTMLElement & { editor: import('@tiptap/core').Editor }).editor
    editor.commands.setContent(content, { contentType: 'markdown' })
  }, markdown)
  await setMarkdown('```mermaid\nflowchart TD\n  A[开始] --> B[结束]\n```')
  await expect(page.locator('.mermaid-preview svg')).toBeVisible()
  await expect(page.locator('.mermaid-preview')).toContainText('开始')
  await expect(page.locator('.mermaid-preview')).toContainText('结束')
  const markdown = await page.locator('.tiptap').evaluate((element) => (
    element as HTMLElement & { editor: import('@tiptap/core').Editor }
  ).editor.getMarkdown())
  expect(markdown).toContain('```mermaid\nflowchart TD')
  expect(markdown).not.toContain('<svg')

  await setMarkdown('```mermaid\nflowchart TD\n```')
  await expect(page.locator('.mermaid-preview')).toContainText('添加节点和连线')
  await setMarkdown('```mermaid\nflowchart TD\nA[\n```')
  await expect(page.locator('.mermaid-preview')).toContainText('请检查 Mermaid 语法')
  await setMarkdown('```mermaid\nflowchart TD\nA --> B\n```\n\n```mermaid\nsequenceDiagram\nAlice->>Bob: Hello\n```\n\n```js\nconst x = 1\n```')
  await expect(page.locator('.mermaid-preview svg')).toHaveCount(2)
  await expect(page.locator('code.language-js')).toContainText('const x = 1')
  await expect(page.locator('.mermaid-preview').nth(1)).toContainText('Hello')
})
