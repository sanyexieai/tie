import { expect, test, type Page } from '@playwright/test'
import { encryptMarkdown, importEncryptionPassword } from '../src/services/encrypted-markdown'
import type { Page as KnowledgePage } from '../src/types'

const password = 'fixture-search-unlock-password-58214'
const privateQuery = 'fixture-only-private-search-body-27519'

async function openSearch(page: Page) {
  const key = await importEncryptionPassword(password)
  const otherKey = await importEncryptionPassword('fixture-other-search-password-39518')
  const stamp = '2026-11-27T00:00:00.000Z'
  function document(id: string, title: string, markdown: string, sourceId = 'source-demo-local'): KnowledgePage {
    return { id, title, markdown, icon: '', parentId: null, sortKey: 0, tags: [], createdAt: stamp, updatedAt: stamp,
      deletedAt: null, storageSourceId: sourceId, storageSourceIds: [sourceId] }
  }
  const snapshot = { workspace: { id: 'search-unlock-test', name: '搜索测试', sources: [
    { id: 'source-demo-local', name: '工作区 A', path: 'localStorage', kind: 'local', available: true },
    { id: 'src_local_search_b', name: '工作区 B', path: '/fixture/search-b', kind: 'local', available: true },
  ] }, pages: [
    document('pg_normal', '普通页', '# 普通页\n\n公开文字。'),
    document('pg_search_a', '检索 A', await encryptMarkdown(`## 加密正文\n\n${privateQuery} first\n`, key)),
    document('pg_search_other', '检索 B', await encryptMarkdown(`## 加密正文\n\n${privateQuery} other password\n`, otherKey)),
    document('pg_search_scope_b', '检索 C', await encryptMarkdown(`## 加密正文\n\n${privateQuery} other workspace\n`, key), 'src_local_search_b'),
  ] }
  await page.addInitScript((snapshot) => {
    localStorage.clear()
    localStorage.setItem('tie-demo-workspace-v1', JSON.stringify(snapshot))
    localStorage.setItem('tie-backend-default-prompt-dismissed-v1', '1')
  }, snapshot)
  await page.goto('/')
  await expect(page.getByRole('textbox', { name: '页面标题', exact: true })).toHaveValue('普通页')
  await page.getByRole('navigation', { name: '快捷导航' }).getByRole('button', { name: /搜索/ }).click()
  await expect(page.locator('.search-input')).toBeVisible()
  return page.locator('.search-view')
}

async function holdDerivation(page: Page) {
  await page.evaluate(() => {
    const derive = crypto.subtle.deriveKey.bind(crypto.subtle)
    let release!: () => void
    let first = true
    const pending = new Promise<void>((resolve) => { release = resolve })
    Object.assign(window, { __searchDeriveStarted: false, __searchDeriveFinished: false, __releaseSearchDerive: release })
    crypto.subtle.deriveKey = async (...args: Parameters<SubtleCrypto['deriveKey']>) => {
      if (first) {
        first = false
        Object.assign(window, { __searchDeriveStarted: true })
        await pending
      }
      const result = await derive(...args)
      Object.assign(window, { __searchDeriveFinished: true })
      return result
    }
  })
}

async function releaseDerivation(page: Page) {
  await page.evaluate(() => (window as Window & { __releaseSearchDerive: () => void }).__releaseSearchDerive())
  await expect.poll(() => page.evaluate(() => (window as Window & { __searchDeriveFinished: boolean }).__searchDeriveFinished)).toBe(true)
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}

test('unlocks normal body search within the selected workspace and leaves other passwords locked', async ({ page }) => {
  const search = await openSearch(page)
  await page.locator('.search-input').fill('检索 A')
  await expect(search.locator('.search-results')).toContainText('检索 A')
  await expect(search.locator('.search-results')).toContainText('正文已锁定')
  await page.locator('.search-input').fill(privateQuery)
  await expect(search.locator('.search-results button')).toHaveCount(0)
  await page.getByRole('button', { name: '筛选工作区', exact: true }).click()
  await page.getByRole('option', { name: '工作区 A', exact: true }).click()
  await expect(search).toContainText('2 页正文已锁定')
  await search.getByRole('button', { name: '解锁正文搜索', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '解锁搜索', exact: true })
  await dialog.getByLabel('解锁密码', { exact: true }).fill(password)
  await dialog.getByRole('button', { name: '解锁搜索', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.locator('.search-input')).toHaveValue(privateQuery)
  await expect(search.locator('.search-results button')).toHaveCount(1)
  await expect(search.locator('.search-results')).toContainText('检索 A')
  await expect(search).toContainText('已解锁 1 页，其余 1 页仍锁定')
  await page.getByRole('button', { name: '筛选工作区', exact: true }).click()
  await page.getByRole('option', { name: '全部工作区', exact: true }).click()
  await expect(search.locator('.search-results button')).toHaveCount(1)
  await expect(search).toContainText('2 页正文已锁定')
  const stored = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))
  expect(stored).not.toContain(privateQuery)
  expect(stored).not.toContain(password)
})

for (const action of ['cancel', 'leave'] as const) {
  test(`does not grant delayed body-search access after ${action}`, async ({ page }) => {
    const search = await openSearch(page)
    await page.locator('.search-input').fill(privateQuery)
    await holdDerivation(page)
    await search.getByRole('button', { name: '解锁正文搜索', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '解锁搜索', exact: true })
    await dialog.getByLabel('解锁密码', { exact: true }).fill(password)
    await dialog.getByRole('button', { name: '解锁搜索', exact: true }).click()
    await expect.poll(() => page.evaluate(() => (window as Window & { __searchDeriveStarted: boolean }).__searchDeriveStarted)).toBe(true)
    if (action === 'cancel') await dialog.getByRole('button', { name: '取消', exact: true }).click()
    else {
      await page.keyboard.press('Control+k')
      const palette = page.getByRole('dialog', { name: '命令面板', exact: true })
      await palette.getByPlaceholder('搜索页面或命令…').fill('普通页')
      await palette.getByPlaceholder('搜索页面或命令…').press('Enter')
      await expect(search).toHaveCount(0)
    }
    await expect(dialog).toHaveCount(0)
    await releaseDerivation(page)
    if (action === 'leave') await page.getByRole('navigation', { name: '快捷导航' }).getByRole('button', { name: /搜索/ }).click()
    await expect(search.locator('.search-results button')).toHaveCount(0)
    await expect(search).toContainText('3 页正文已锁定')
  })
}
