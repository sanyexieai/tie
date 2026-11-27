import { expect, test, type Page } from '@playwright/test'

type SyncStage = 'connecting' | 'pages' | 'assets' | 'files' | 'reviews'

declare global {
  interface Window {
    __tieSyncTest: {
      calls: number
      resolveCalls: number
      saveCalls: number
      failResolution: boolean
      listenerCount: () => number
      progress: (stage: SyncStage, completed: number, total: number, sourceId?: string) => void
      finish: (report?: Record<string, unknown>) => void
      fail: () => void
    }
  }
}

async function openDesktopWorkspace(page: Page) {
  const endpoint = 'https://sync.example.test'
  const user = { id: 'usr_progress', name: 'Progress Test', email: 'progress@example.test', createdAt: '' }
  await page.clock.install()
  await page.route(`${endpoint}/**`, (route) => {
    const path = new URL(route.request().url()).pathname
    const body = path === '/api/v1/me' ? user
      : path === '/health' ? { ok: true }
      : path === '/api/v1/workspaces' ? [{ id: 'ws_progress', name: '我的工作区', default: true, ownerId: user.id }]
      : []
    return route.fulfill({ json: body, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization,content-type,accept', 'access-control-allow-methods': 'GET,POST,OPTIONS' } })
  })
  await page.route('**/*latest.json', (route) => route.fulfill({ json: { version: '1.0.52', platforms: {} }, headers: { 'access-control-allow-origin': '*' } }))
  await page.routeWebSocket('wss://sync.example.test/api/v1/live', () => {})
  await page.addInitScript(({ endpoint, user }) => {
    localStorage.clear()
    const sourceId = 'local:progress'
    const updatedAt = '2026-11-25T00:00:00Z'
    const snapshot = {
      workspace: { id: 'local_progress', name: '进度测试', sources: [{ id: sourceId, name: '资料库', kind: 'local', path: '/fixture/progress', available: true }] },
      pages: [{ id: 'pg_progress', title: '测试页面', markdown: '# 测试页面\n', icon: '', tags: [], parentId: null,
        sortKey: 0, storageSourceId: sourceId, storageSourceIds: [sourceId], createdAt: updatedAt, updatedAt, deletedAt: null }],
    }
    let nextCallback = 1
    const callbacks = new Map<number, (data: unknown) => void>()
    const listeners = new Map<number, string>()
    let pending: { resolve: (value: unknown) => void; reject: (error: Error) => void } | null = null
    const control: Window['__tieSyncTest'] = {
      calls: 0,
      resolveCalls: 0,
      saveCalls: 0,
      failResolution: false,
      listenerCount: () => [...listeners.values()].filter((event) => event === 'backend-sync-progress').length,
      progress(stage, completed, total, id = sourceId) {
        for (const [callback, event] of listeners) {
          if (event === 'backend-sync-progress') callbacks.get(callback)?.({ event, id: callback, payload: { sourceId: id, stage, completed, total } })
        }
      },
      finish(report) {
        pending?.resolve(report ?? { pushed: 0, pulled: 0, conflicts: [] })
        pending = null
      },
      fail() {
        pending?.reject(new Error('测试连接中断'))
        pending = null
      },
    }
    Object.assign(window, {
      __tieSyncTest: control,
      __TAURI_OS_PLUGIN_INTERNALS__: { os_type: 'linux', arch: 'x86_64' },
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: (_event: string, id: number) => callbacks.delete(id) },
      __TAURI_INTERNALS__: {
        metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main', windowLabel: 'main' } },
        transformCallback(callback: (data: unknown) => void) {
          const id = nextCallback++
          callbacks.set(id, callback)
          return id
        },
        async invoke(command: string, args: Record<string, unknown> = {}) {
          if (command === 'plugin:event|listen') { listeners.set(Number(args.handler), String(args.event)); return args.handler }
          if (command === 'plugin:event|unlisten') { listeners.delete(Number(args.eventId)); return }
          if (command === 'plugin:os|type') return 'linux'
          if (command === 'plugin:os|hostname') return 'fixture'
          if (command === 'plugin:app|version') return '1.0.52'
          if (command === 'plugin:updater|check') return null
          if (command === 'load_backend_session') return { endpoint, accessToken: 'fixture-access', refreshToken: '', accessExpiresAt: '', userId: user.id, email: user.email, name: user.name }
          if (command === 'load_workspace') return snapshot
          if (command === 'save_page') { control.saveCalls += 1; snapshot.pages[0] = args.page as typeof snapshot.pages[number]; return args.page }
          if (command === 'resolve_backend_sync_conflict') {
            control.resolveCalls += 1
            if (control.failResolution) throw new Error('503 fixture service unavailable')
            return { pushed: 1, pulled: 0, conflicts: [] }
          }
          if (command === 'backend_sync_cursor') return { pg_progress: { local: updatedAt, remote: updatedAt } }
          if (command === 'sync_backend_workspace') {
            control.calls += 1
            return new Promise((resolve, reject) => { pending = { resolve, reject } })
          }
          if (command === 'list_page_reviews') return { entries: [] }
          if (command === 'load_s3_providers' || command === 'list_skill_connections') return []
          return null
        },
      },
    })
  }, { endpoint, user })
  await page.goto('/')
  await expect(page.locator('.sidebar-storage-trigger')).toBeVisible()
  await expect.poll(() => page.evaluate(() => window.__tieSyncTest.calls)).toBe(1)
  await expect.poll(() => page.evaluate(() => window.__tieSyncTest.listenerCount())).toBe(1)
}

test('shows real sync counts quietly in the existing settings row and restores it on success', async ({ page }) => {
  await openDesktopWorkspace(page)
  const settings = page.locator('.sidebar-storage-trigger')
  const detail = settings.locator('small')
  const initialHeight = (await settings.boundingBox())!.height

  await page.evaluate(() => window.__tieSyncTest.progress('connecting', 0, 3))
  await expect(detail).toContainText('本地 + 服务器 · 连接服务器…')
  await expect(detail).not.toContainText('0/3')
  await page.evaluate(() => window.__tieSyncTest.progress('pages', 123, 672))
  await expect(detail).toContainText('本地 + 服务器')
  await expect(detail).toContainText('校对文档 123/672')
  await expect(settings).toHaveAttribute('title', /资料库/)
  expect((await settings.boundingBox())!.height).toBe(initialHeight)
  expect(await detail.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize))).toBeLessThan(
    await settings.locator(':scope > span').evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize)),
  )
  await expect(page.getByRole('progressbar')).toHaveCount(0)

  await page.evaluate(() => window.__tieSyncTest.progress('pages', 999, 999, 'local:unrelated'))
  await expect(detail).toContainText('校对文档 123/672')
  await page.evaluate(() => window.__tieSyncTest.progress('assets', 6, 6))
  await expect(detail).toContainText('检查附件 6/6 页')
  expect((await settings.boundingBox())!.height).toBe(initialHeight)
  await page.evaluate(() => window.__tieSyncTest.progress('reviews', 42, 83))
  await expect(detail).toContainText('同步批注 42/83 页')

  await page.evaluate(() => window.__tieSyncTest.finish())
  await expect(detail).toHaveText('本地 + 服务器 · 资料库')
  await expect.poll(() => page.evaluate(() => window.__tieSyncTest.listenerCount())).toBe(0)
  expect((await settings.boundingBox())!.height).toBe(initialHeight)
  await settings.click()
  await expect(page.getByRole('dialog', { name: '设置', exact: true })).toBeVisible()
})

test('keeps an editor draft typed during a native pull and requires explicit conflict resolution before saving it', async ({ page }) => {
  await openDesktopWorkspace(page)
  const editor = page.locator('main.editor-pane')
  await editor.getByRole('button', { name: /源码/ }).click()
  const input = editor.getByRole('textbox', { name: 'Markdown 源码', exact: true })
  await page.clock.pauseAt(new Date())
  const draft = 'fixture-editor-draft-kept-during-native-pull'
  await input.fill(draft)
  await page.evaluate(() => {
    const store = (document.querySelector('#app') as any).__vue_app__.config.globalProperties.$pinia._s.get('workspace')
    window.__tieSyncTest.finish({ pushed: 0, pulled: 1, conflicts: [], changed: true,
      changedPages: [{ ...store.activePage, markdown: '# 测试页面\n\n远端刚刚修改的版本', updatedAt: '2026-11-27T00:00:00Z' }] })
  })
  await expect(input).toHaveValue(draft)
  await expect(editor.getByRole('button', { name: '查看差异', exact: true })).toBeVisible()
  const result = await page.evaluate(async () => {
    const store = (document.querySelector('#app') as any).__vue_app__.config.globalProperties.$pinia._s.get('workspace')
    let message = ''
    try { await store.persist({ ...store.activePage, markdown: 'attempted automatic local overwrite' }) }
    catch (error) { message = String(error) }
    return { message, conflict: store.syncConflicts.has('pg_progress'), writes: window.__tieSyncTest.saveCalls }
  })
  expect(result.message).toContain('其他设备更新')
  expect(result.conflict).toBe(true)
  expect(result.writes).toBe(0)
  await expect(input).toHaveValue(draft)
})

test('clears progress on failure while keeping the login state and settings entry', async ({ page }) => {
  await openDesktopWorkspace(page)
  const settings = page.locator('.sidebar-storage-trigger')
  const detail = settings.locator('small')
  const initialHeight = (await settings.boundingBox())!.height
  await page.evaluate(() => window.__tieSyncTest.progress('files', 3, 11))
  await expect(detail).toContainText('同步文件 3/11')
  await page.evaluate(() => window.__tieSyncTest.fail())
  await expect(detail).toContainText('本地 + 服务器')
  await expect(detail).toContainText('同步失败')
  await expect(detail).not.toContainText('3/11')
  await expect(settings).toHaveAttribute('title', /测试连接中断/)
  await expect.poll(() => page.evaluate(() => window.__tieSyncTest.listenerCount())).toBe(0)
  expect((await settings.boundingBox())!.height).toBe(initialHeight)
  await settings.click()
  await expect(page.getByRole('dialog', { name: '设置', exact: true })).toBeVisible()
})

test('keeps protection mismatches separate from content conflicts and retains real timestamps', async ({ page }) => {
  await openDesktopWorkspace(page)
  const localUpdatedAt = '2026-11-25T00:00:00Z'
  const remoteUpdatedAt = '2026-11-26T03:04:05Z'
  await page.evaluate(({ localUpdatedAt, remoteUpdatedAt }) => window.__tieSyncTest.finish({
    pushed: 0, pulled: 0, conflicts: ['pg_progress'], message: '服务器页面已加密，请先对齐保护状态',
    protectionConflicts: [{ pageId: 'pg_progress', localEncrypted: false, remoteEncrypted: true, localUpdatedAt, remoteUpdatedAt }],
  }), { localUpdatedAt, remoteUpdatedAt })
  await expect(page.getByRole('button', { name: '处理保护状态', exact: true })).toBeVisible()
  await page.getByRole('textbox', { name: '页面标题', exact: true }).fill('测试页面更新')
  await page.keyboard.press('Control+s')
  await page.evaluate(async () => {
    const store = (document.querySelector('#app') as any).__vue_app__.config.globalProperties.$pinia._s.get('workspace')
    await store.refreshPage('pg_progress')
  })
  await expect(page.getByRole('button', { name: '处理保护状态', exact: true })).toBeVisible()
  await page.locator('.sidebar-storage-trigger').click()
  const settings = page.getByRole('dialog', { name: '设置', exact: true })
  await expect(settings.locator('.storage-conflict-item')).toContainText('保护状态不同 · 本机普通页面 · 服务器加密页面')
  await expect(settings.locator('.storage-conflict-item')).toContainText('远程 2026-11-26 03:04')
  await settings.locator('.storage-conflict-item').click()
  await page.getByRole('button', { name: '处理保护状态', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '页面保护状态不同', exact: true })
  await expect(dialog).toContainText('本机：普通页面 · 服务器：加密页面')
  await expect(dialog.getByRole('button', { name: /覆盖|载入/ })).toHaveCount(0)
  await dialog.getByRole('button', { name: '解锁并加密本机', exact: true }).click()
  const conversion = page.getByRole('dialog', { name: '解锁并加密本机', exact: true })
  await expect(conversion.getByLabel('服务器页面密码', { exact: true })).toBeVisible()
  await expect(conversion.getByLabel('确认加密密码', { exact: true })).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => window.__tieSyncTest.resolveCalls)).toBe(0)
  await conversion.getByRole('button', { name: '关闭', exact: true }).click()
  await page.evaluate(() => {
    const store = (document.querySelector('#app') as any).__vue_app__.config.globalProperties.$pinia._s.get('workspace')
    void store.syncBackendNow()
  })
  await expect.poll(() => page.evaluate(() => window.__tieSyncTest.calls)).toBe(2)
  await page.evaluate(() => window.__tieSyncTest.finish())
  await expect(page.getByRole('button', { name: '处理保护状态', exact: true })).toHaveCount(0)
})

test('keeps a content conflict after a failed resolution so the same choice can be retried', async ({ page }) => {
  await openDesktopWorkspace(page)
  await page.evaluate(() => window.__tieSyncTest.finish({ pushed: 0, pulled: 0, conflicts: ['pg_progress'] }))
  await expect(page.getByRole('button', { name: '查看差异', exact: true })).toBeVisible()
  await page.route('https://sync.example.test/api/v1/workspaces/ws_progress/pages/pg_progress', (route) => route.fulfill({ status: 503, json: { message: 'fixture backend temporarily unavailable' }, headers: { 'access-control-allow-origin': '*' } }))
  const preview = await page.evaluate(async () => {
    const store = (document.querySelector('#app') as any).__vue_app__.config.globalProperties.$pinia._s.get('workspace')
    try { await store.readLatestPage('pg_progress'); return 'unexpected success' }
    catch (error) { return String(error) }
  })
  expect(preview).toContain('fixture backend temporarily unavailable')
  const result = await page.evaluate(async () => {
    const store = (document.querySelector('#app') as any).__vue_app__.config.globalProperties.$pinia._s.get('workspace')
    window.__tieSyncTest.failResolution = true
    let message = ''
    try { await store.resolveConflictOverwriteLocal({ ...store.activePage, markdown: '# 测试页面\n\n本地保留的修改' }) }
    catch (error) { message = String(error) }
    return { message, conflict: store.syncConflicts.has('pg_progress'), markdown: store.activePage.markdown }
  })
  expect(result.message).toContain('503 fixture service unavailable')
  expect(result.conflict).toBe(true)
  expect(result.markdown).toContain('本地保留的修改')
  await expect(page.getByRole('button', { name: '查看差异', exact: true })).toBeVisible()
  await page.evaluate(async () => {
    const store = (document.querySelector('#app') as any).__vue_app__.config.globalProperties.$pinia._s.get('workspace')
    window.__tieSyncTest.failResolution = false
    await store.resolveConflictOverwriteLocal(store.activePage)
  })
  expect(await page.evaluate(() => window.__tieSyncTest.resolveCalls)).toBe(2)
  await expect(page.getByRole('button', { name: '查看差异', exact: true })).toHaveCount(0)
})
