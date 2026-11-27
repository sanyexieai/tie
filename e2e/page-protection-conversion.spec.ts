import { expect, test, type Locator, type Page } from '@playwright/test'

const title = '普通页面转换测试'
const pageId = 'pg_protection_conversion'
const password = 'fixture-conversion-password-72816'
const first = 'fixture-original-private-value-76129'
const second = 'fixture-edited-private-value-38714'
const marker = '-----BEGIN TIE ENCRYPTED MARKDOWN-----'
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j8eEAAAAASUVORK5CYII='

test.beforeEach(async ({ page }) => {
  await page.addInitScript(({ title, pageId, first }) => {
    if (sessionStorage.getItem('protection-conversion-fixture')) return
    localStorage.clear()
    const sourceId = 'source-demo-local'
    const stamp = '2026-11-27T00:00:00.000Z'
    localStorage.setItem('tie-demo-workspace-v1', JSON.stringify({
      workspace: { id: 'local-demo', name: '我的知识库', sources: [{ id: sourceId, name: '浏览器演示工作区', path: 'localStorage', kind: 'local', available: true }] },
      pages: [{ id: pageId, title, markdown: `# ${title}\n\n## 部署记录\n\n${first}\n`, icon: '', tags: ['转换测试'], parentId: null, sortKey: 0,
        storageSourceId: sourceId, storageSourceIds: [sourceId], createdAt: stamp, updatedAt: stamp, deletedAt: null }],
    }))
    sessionStorage.setItem('protection-conversion-fixture', 'yes')
  }, { title, pageId, first })
  await page.route('**/health', (route) => route.fulfill({ json: { ok: true, service: 'tie-backend', mcp: { enabled: false, running: false, url: null } } }))
})

async function openApp(page: Page) {
  await page.goto('/')
  await dismissOnboarding(page)
  await expect(page.getByRole('textbox', { name: '页面标题', exact: true })).toHaveValue(title)
  return page.locator('main.editor-pane')
}

async function dismissOnboarding(page: Page) {
  const dialog = page.getByRole('dialog', { name: '绑定服务器', exact: true })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: '关闭', exact: true }).click()
}

async function source(editor: Locator) {
  const textarea = editor.getByRole('textbox', { name: 'Markdown 源码', exact: true })
  await expect(editor.locator('.tiptap').or(textarea)).toBeVisible()
  if (!await textarea.isVisible()) await editor.getByRole('button', { name: /源码/ }).click()
  await expect(textarea).toBeVisible()
  return textarea
}

async function rich(editor: Locator) {
  if (await editor.getByRole('textbox', { name: 'Markdown 源码', exact: true }).isVisible()) await editor.getByRole('button', { name: /源码/ }).click()
  await expect(editor.locator('.tiptap')).toBeVisible()
  return editor.locator('.tiptap')
}

async function save(page: Page, editor: Locator) {
  await page.keyboard.press('Control+s')
  await expect(editor.locator('.save-state')).not.toContainText(/未保存|保存中|失败/, { timeout: 10_000 })
}

async function persisted(page: Page) {
  return page.evaluate((pageId) => {
    const snapshot = JSON.parse(localStorage.getItem('tie-demo-workspace-v1') || '{"pages":[]}')
    const history = JSON.parse(localStorage.getItem('tie-demo-page-history-v1') || '{}')
    return { page: snapshot.pages.find((item: { id: string }) => item.id === pageId), history: history[pageId] || [], raw: JSON.stringify({ ...localStorage }) }
  }, pageId)
}

async function encrypt(page: Page, editor: Locator) {
  await editor.getByRole('button', { name: '加密此页面', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '加密此页面', exact: true })
  await dialog.getByLabel('加密密码', { exact: true }).fill(password)
  await dialog.getByLabel('确认加密密码', { exact: true }).fill(password)
  await dialog.getByRole('button', { name: '加密此页面', exact: true }).click()
  await expect(dialog).toBeHidden()
  await expect(editor.getByRole('button', { name: '转为普通页面', exact: true })).toBeVisible()
}

async function decrypt(page: Page, editor: Locator) {
  await editor.getByRole('button', { name: '转为普通页面', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '转为普通页面', exact: true })
  await expect(dialog).toContainText('查看和搜索不再需要解锁')
  await dialog.getByRole('button', { name: '转为普通页面', exact: true }).click()
  await expect(dialog).toBeHidden()
  await expect(editor.getByRole('button', { name: '加密此页面', exact: true })).toBeVisible()
}

async function unlock(editor: Locator) {
  await expect(editor.getByRole('button', { name: '解锁页面', exact: true })).toBeVisible()
  await editor.getByLabel('解锁密码', { exact: true }).fill(password)
  await editor.getByRole('button', { name: '解锁页面', exact: true }).click()
  await expect(editor.getByRole('button', { name: '转为普通页面', exact: true })).toBeVisible()
  await expect(editor.locator('.tiptap').or(editor.getByRole('textbox', { name: 'Markdown 源码', exact: true }))).toBeVisible()
}

test('converts a real edited page and all its history, reloads locked, and restores ordinary use with identity unchanged', async ({ page }) => {
  const editor = await openApp(page)
  const textarea = await source(editor)
  await textarea.fill(`## 部署记录\n\n${second}\n`)
  await editor.getByPlaceholder('添加标签，回车确认').fill('保留标签')
  await editor.getByPlaceholder('添加标签，回车确认').press('Enter')
  await save(page, editor)
  await expect.poll(async () => (await persisted(page)).page.markdown).toContain(second)
  const original = await persisted(page)
  expect(original.history.length).toBeGreaterThan(0)
  expect(JSON.stringify(original.history)).toContain(first)

  await encrypt(page, editor)
  const protectedData = await persisted(page)
  expect(protectedData.page.id).toBe(pageId)
  expect(protectedData.page.title).toBe(title)
  expect(protectedData.page.tags).toEqual(original.page.tags)
  expect(protectedData.page.markdown.startsWith(marker)).toBe(true)
  expect(protectedData.history.length).toBeGreaterThanOrEqual(original.history.length)
  for (const entry of protectedData.history) expect(entry.page.markdown.startsWith(marker)).toBe(true)
  for (const value of [first, second, password]) expect(protectedData.raw).not.toContain(value)

  await page.reload()
  await dismissOnboarding(page)
  await expect(editor.locator('.tiptap')).toHaveCount(0)
  await expect(editor.getByRole('textbox', { name: 'Markdown 源码', exact: true })).toHaveCount(0)
  await editor.getByLabel('解锁密码', { exact: true }).fill('incorrect-fixture-password')
  await editor.getByRole('button', { name: '解锁页面', exact: true }).click()
  await expect(editor.getByRole('alert')).toContainText('无法解密')
  await unlock(editor)
  const unlockedSource = await source(editor)
  await expect(unlockedSource).toHaveValue(`## 部署记录\n\n${second}\n`)
  await rich(editor)
  await page.screenshot({ path: '/tmp/tie-page-conversion.png', fullPage: true })

  await editor.getByTitle('页面版本历史', { exact: true }).click()
  const history = editor.locator('.history-popover')
  await expect(history.locator('.history-revision')).not.toHaveCount(0)
  await history.locator('.history-revision').last().getByRole('button').first().click()
  await expect(history.locator('.revision-preview pre')).toContainText(first)
  await history.getByRole('button', { name: '关闭页面历史', exact: true }).click()

  await decrypt(page, editor)
  const restored = await persisted(page)
  expect(restored.page.id).toBe(pageId)
  expect(restored.page.title).toBe(title)
  expect(restored.page.tags).toEqual(original.page.tags)
  expect(restored.page.markdown).toContain(second)
  expect(JSON.stringify(restored.history)).toContain(first)
  for (const entry of restored.history) expect(entry.page.markdown.startsWith(marker)).toBe(false)
  await page.reload()
  await dismissOnboarding(page)
  expect(await (await source(editor)).inputValue()).toContain(second)
  await expect(editor.getByRole('button', { name: '解锁页面', exact: true })).toHaveCount(0)
})

test('converts an ordinary uploaded PNG to encrypted Markdown and preserves it through ordinary edits and reload', async ({ page }) => {
  const editor = await openApp(page)
  const body = await rich(editor)
  await body.click()
  await page.keyboard.press('Control+End')
  await page.keyboard.press('Enter')
  await page.keyboard.insertText('/上传图片')
  const chooser = page.waitForEvent('filechooser')
  await editor.getByRole('listbox', { name: '插入块', exact: true }).getByRole('button').filter({ hasText: '上传图片' }).click()
  await (await chooser).setFiles({ name: 'fixture-conversion.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') })
  const image = editor.locator('.tiptap img').first()
  await expect(image).toBeVisible()
  await expect.poll(() => image.evaluate((node) => (node as HTMLImageElement).naturalWidth)).toBe(1)
  await save(page, editor)
  await expect.poll(async () => (await persisted(page)).page.markdown).toContain(`tie://asset/${pageId}/`)

  await encrypt(page, editor)
  await rich(editor)
  await expect(image).toHaveAttribute('src', `data:image/png;base64,${png}`)
  await expect.poll(() => image.evaluate((node) => (node as HTMLImageElement).naturalWidth)).toBe(1)
  const raw = await persisted(page)
  expect(raw.raw).not.toContain(png)
  expect(raw.raw).not.toContain(first)
  const keys = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('tie-demo-blobs', 1)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    try { return await new Promise<IDBValidKey[]>((resolve, reject) => {
      const request = db.transaction('blobs', 'readonly').objectStore('blobs').getAllKeys()
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    }) } finally { db.close() }
  })
  expect(keys.filter((key) => String(key).startsWith(`asset:${pageId}:`))).toEqual([])

  await decrypt(page, editor)
  const ordinaryBody = await rich(editor)
  await expect(image).toHaveAttribute('src', `data:image/png;base64,${png}`)
  await ordinaryBody.click()
  await page.keyboard.press('Control+End')
  await page.keyboard.press('Enter')
  await page.keyboard.insertText('图片转换后继续编辑')
  await save(page, editor)
  await expect.poll(async () => (await persisted(page)).page.markdown).toContain('图片转换后继续编辑')
  await page.reload()
  await dismissOnboarding(page)
  await rich(editor)
  await expect(image).toBeVisible()
  await expect(image).toHaveAttribute('src', `data:image/png;base64,${png}`)
  await expect.poll(() => image.evaluate((node) => (node as HTMLImageElement).naturalWidth)).toBe(1)
  await expect(editor.locator('.tiptap')).toContainText('图片转换后继续编辑')
})
