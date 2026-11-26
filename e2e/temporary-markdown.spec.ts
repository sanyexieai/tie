import { expect, test, type Page } from '@playwright/test'

declare global {
  interface Window {
    __temporaryOpenTest: {
      wake: (paths: string[]) => void
      calls: { command: string; args: Record<string, unknown> }[]
      saved: string[]
    }
  }
}

const osPath = 'C:\\外部文件\\临时 Markdown.md'
const secondPath = 'C:\\外部文件\\另一个文档.md'
const dialogPath = 'C:\\外部文件\\文件对话框.md'

async function openDesktop(page: Page, pendingPaths: string[] = []) {
  await page.route('**/*', (route) => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort())
  await page.addInitScript(({ pendingPaths, osPath, secondPath, dialogPath }) => {
    const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value))
    const createdAt = '2026-11-26T00:00:00.000Z'
    const sourceId = 'src_local_formal'
    const formalPage = { id: 'pg_formal', title: '正式页面', markdown: '# 正式页面\n\n原有内容', icon: '', tags: [], parentId: null, sortKey: 0,
      storageSourceId: sourceId, storageSourceIds: [sourceId], createdAt, updatedAt: createdAt, deletedAt: null }
    const opened: { path: string; source: { id: string; name: string; kind: string; path: string; temporary: boolean }; page: typeof formalPage }[] = []
    const pending = [...pendingPaths]
    const callbacks = new Map<number, (event: unknown) => void>()
    const listeners = new Map<number, string>()
    let callbackId = 0
    const snapshot = () => ({
      workspace: { id: 'tie-workspace', name: '我的知识库', sources: [
        { id: sourceId, name: '正式工作区', kind: 'local', path: 'C:\\Tie', available: true },
        ...opened.map((entry) => entry.source),
      ] }, pages: [formalPage, ...opened.map((entry) => entry.page)],
    })
    const control: Window['__temporaryOpenTest'] = {
      calls: [], saved: [],
      wake(paths) {
        pending.push(...paths)
        for (const [id, event] of listeners) {
          if (event === 'tie:open-files') callbacks.get(id)?.({ event, id, payload: null })
        }
      },
    }
    Object.assign(window, {
      __temporaryOpenTest: control,
      __TAURI_OS_PLUGIN_INTERNALS__: { os_type: 'windows', arch: 'x86_64' },
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: (_event: string, id: number) => listeners.delete(id) },
      __TAURI_INTERNALS__: {
        metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main', windowLabel: 'main' } },
        transformCallback(callback: (event: unknown) => void) { callbacks.set(++callbackId, callback); return callbackId },
        async invoke(command: string, args: Record<string, unknown> = {}) {
          control.calls.push({ command, args })
          if (command === 'plugin:event|listen') { listeners.set(Number(args.handler), String(args.event)); return args.handler }
          if (command === 'plugin:event|unlisten') { listeners.delete(Number(args.eventId)); return null }
          if (command === 'load_workspace') return clone(snapshot())
          if (command === 'consume_open_file_paths') return pending.splice(0)
          if (command === 'plugin:dialog|open') return [dialogPath]
          if (command === 'open_markdown_files') {
            const pageIds: string[] = []
            for (const path of args.paths as string[]) {
              let entry = opened.find((entry) => entry.path === path)
              if (!entry) {
                const index = [osPath, secondPath, dialogPath].indexOf(path)
                const name = path.split('\\').at(-1)!
                const title = name.replace(/\.md$/, '')
                const source = { id: `src_temporary_${index}`, name, kind: 'local', path: 'C:\\外部文件', temporary: true }
                entry = { path, source, page: { ...formalPage, id: `pg_temporary_${index}`, title, storageSourceId: source.id, storageSourceIds: [source.id],
                  markdown: `# ${title}\n\n这是一份 **本地 Markdown**。\n\n| 项目 | 状态 |\n| --- | --- |\n| 文件 | 已打开 |` } }
                opened.push(entry)
              }
              pageIds.push(entry.page.id)
            }
            return clone({ snapshot: snapshot(), openedPageIds: pageIds, createdSourceIds: opened.map((entry) => entry.source.id) })
          }
          if (command === 'save_page') {
            const incoming = args.page as typeof formalPage
            if (incoming.id === formalPage.id) {
              Object.assign(formalPage, clone(incoming))
              return clone(formalPage)
            }
            const entry = opened.find((entry) => entry.page.id === incoming.id)
            if (!entry) throw new Error('Unexpected save target')
            entry.page = clone(incoming)
            control.saved.push(entry.path)
            return clone(incoming)
          }
          if (command === 'remove_storage_source') {
            const index = opened.findIndex((entry) => entry.source.id === args.sourceId)
            if (index < 0) throw new Error('Unexpected close target')
            opened.splice(index, 1)
            return clone(snapshot())
          }
          if (command === 'load_backend_session' || command === 'load_s3_providers') return new Promise(() => {})
          if (command === 'list_page_reviews') return { entries: [] }
          if (command === 'backend_sync_cursor') return {}
          if (command === 'plugin:app|version') return '1.0.59'
          if (command === 'plugin:os|hostname') return 'Fixture'
          if (command === 'plugin:updater|check') return null
          if (command === 'load_s3_provider_metadata' || command === 'list_skill_connections' || command === 'list_page_revisions' || command === 'list_file_page_assets') return []
          return null
        },
      },
    })
  }, { pendingPaths, osPath, secondPath, dialogPath })
  await page.goto('/')
  await expect(page.locator('.tiptap')).toBeVisible()
}

test('opens an OS startup file as a temporary workspace while background restoration is pending', async ({ page }) => {
  await openDesktop(page, [osPath])
  const temporary = page.locator('[data-temporary-source-id="src_temporary_0"]')
  await expect(temporary).toContainText('临时 Markdown.md')
  await expect(temporary.getByRole('treeitem', { name: /临时 Markdown/ })).toBeVisible()
  await expect(page.getByRole('textbox', { name: '页面标题' })).toHaveValue('临时 Markdown')
  await expect(page.locator('.tiptap strong')).toHaveText('本地 Markdown')
  await expect(page.locator('.tiptap tr')).toHaveCount(2)
  await expect(page.getByRole('treeitem', { name: /正式页面/ })).toBeVisible()

  const preferences = await page.evaluate(() => localStorage.getItem('tie-workspace-preferences-v1:tie-workspace'))
  expect(preferences).not.toContain('src_temporary_')
  expect(preferences).not.toContain('pg_temporary_')
  await page.locator('.tiptap').press('Control+End')
  await page.keyboard.press('Enter')
  await page.keyboard.type('关闭前最后编辑')
  await temporary.getByRole('button', { name: '关闭临时工作区 临时 Markdown.md' }).click()
  await expect(temporary).toHaveCount(0)
  await expect(page.getByRole('textbox', { name: '页面标题' })).toHaveValue('正式页面')
  const calls = await page.evaluate(() => window.__temporaryOpenTest.calls)
  const save = calls.findIndex((call) => call.command === 'save_page' && JSON.stringify(call.args.page).includes('关闭前最后编辑'))
  expect(save).toBeGreaterThan(-1)
  expect(calls.findIndex((call) => call.command === 'remove_storage_source')).toBeGreaterThan(save)
})

test('uses the same editor for file-dialog and running-instance requests, and saves the original file', async ({ page }) => {
  await openDesktop(page)
  await page.keyboard.press('Control+k')
  const palette = page.getByRole('dialog', { name: '命令面板' })
  await palette.getByPlaceholder('搜索页面或命令…').fill('从文件打开')
  await palette.getByRole('button', { name: /从文件打开/ }).click()
  await expect(page.getByRole('textbox', { name: '页面标题' })).toHaveValue('文件对话框')
  await page.locator('.tiptap').press('Control+End')
  await page.keyboard.press('Enter')
  await page.keyboard.type('原文件编辑')
  await page.keyboard.press('Control+s')
  await expect.poll(() => page.evaluate(() => window.__temporaryOpenTest.saved)).toContain(dialogPath)

  await page.evaluate(({ osPath, secondPath }) => {
    window.__temporaryOpenTest.wake([osPath])
    window.__temporaryOpenTest.wake([secondPath, osPath])
  }, { osPath, secondPath })
  await expect(page.locator('[data-temporary-source-id]')).toHaveCount(3)
  await expect(page.locator('[data-temporary-source-id="src_temporary_0"]')).toHaveCount(1)
  const calls = await page.evaluate(() => window.__temporaryOpenTest.calls)
  expect(calls.some((call) => call.command === 'add_storage_source' || call.command === 'import_markdown_files')).toBe(false)
  expect(calls.filter((call) => call.command === 'open_markdown_files').flatMap((call) => call.args.paths)).toContain(dialogPath)
})
