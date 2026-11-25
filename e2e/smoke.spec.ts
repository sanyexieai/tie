import { expect, test } from '@playwright/test'
import JSZip from 'jszip'

test.beforeEach(async ({ page }) => {
  await page.route('**/health', (route) => route.fulfill({
    json: { ok: true, service: 'tie-backend', mcp: { enabled: false, running: false, url: null } },
  }))
  await page.addInitScript(() => {
    localStorage.clear()
  })
})

async function waitForWorkspace(page: import('@playwright/test').Page) {
  await page.goto('/')
  await expect(page.locator('.editor-pane')).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('.workspace-heading')).toContainText('我的知识库')
  // A fresh profile offers cloud sign-in before local demo interactions.
  const onboarding = page.getByRole('dialog', { name: '绑定服务器' })
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

test('exports the current page solution in browser mode', async ({ page }) => {
  await waitForWorkspace(page)
  const downloadPromise = page.waitForEvent('download')
  await page.getByTitle('导出 .tie，以当前页面为根', { exact: true }).click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toMatch(/欢迎使用 Tie\.tie$/i)
  const stream = await download.createReadStream()
  let text = ''
  for await (const chunk of stream) text += chunk.toString()
  expect(text).toContain('kind: solution')
  expect(text).toContain('root_page:')
})

test('keeps bundle actions in collapsible settings and exports a real browser workspace archive', async ({ page }) => {
  await waitForWorkspace(page)
  const sidebar = page.locator('.sidebar')
  await expect(sidebar.getByRole('button', { name: /^(打开 \.tie|导入 \.tiez|导出 \.tiez)$/ })).toHaveCount(0)
  await sidebar.locator('.sidebar-storage-trigger').click()
  const settings = page.getByRole('dialog', { name: '设置', exact: true })
  await expect(settings).toBeVisible()
  await expect(settings.getByRole('button', { name: '+ 添加工作区', exact: true })).toHaveCount(0)
  const toggle = settings.getByRole('button', { name: '导入与导出', exact: true })
  const panel = settings.locator('#storage-import-export-menu')
  await expect(toggle).toHaveAttribute('aria-controls', 'storage-import-export-menu')
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect(panel).toBeHidden()
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await expect(panel).toBeVisible()
  await expect(panel).toHaveAttribute('aria-label', '导入与导出')
  await expect(panel.getByRole('button', { name: /^导入压缩包 \(\.tiez\)/ })).toBeVisible()
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect(panel).toBeHidden()
  await toggle.click()

  const downloadPromise = page.waitForEvent('download')
  await panel.getByRole('button', { name: /^导出压缩包 \(\.tiez\)/ }).click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toMatch(/\.tiez$/i)
  const chunks: Buffer[] = []
  for await (const chunk of await download.createReadStream()) chunks.push(Buffer.from(chunk))
  const archive = await JSZip.loadAsync(Buffer.concat(chunks))
  const files = Object.values(archive.files).filter((entry) => !entry.dir)
  const markdownFiles = files.filter((entry) => /\.md$/i.test(entry.name))
  expect(markdownFiles).toHaveLength(1)
  expect(files.length).toBeGreaterThan(markdownFiles.length)
  const markdown = await markdownFiles[0]!.async('string')
  expect(markdown).toContain('# 欢迎使用 Tie')
  expect(markdown).toContain('Tie 把 **Notion')
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
