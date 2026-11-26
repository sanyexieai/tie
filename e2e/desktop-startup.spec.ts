import { expect, test } from '@playwright/test'

for (const hasFileReference of [false, true]) {
test(`opens local desktop pages before deferred restoration (${hasFileReference ? 'file reference' : 'text only'})`, async ({ page }) => {
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url())
    return url.hostname === '127.0.0.1' ? route.continue() : route.abort()
  })
  await page.addInitScript((hasFileReference) => {
    localStorage.clear()
    const nativeCalls: string[] = []
    const unexpectedCommands: string[] = []
    const deferredStarts: { command: string; localPageVisible: boolean }[] = []
    const createdAt = '2026-11-25T00:00:00.000Z'
    const sourceId = 'src_local_0123456789abcdef'
    const snapshot = {
      workspace: {
        id: 'tie-workspace', name: '本机启动测试',
        sources: [{ id: sourceId, name: '本机测试库', kind: 'local', path: 'C:\\Tie\\Fixture', available: true }],
      },
      pages: [{
        id: 'pg_desktop_fixture', title: '本地启动测试页', icon: '', parentId: null, sortKey: 0,
        markdown: '# 本地启动测试页\n\n本机正文已打开。'
          + (hasFileReference ? '\n\n[登记资料](tie://file/src_local_0123456789abcdef/file_startup_fixture)' : ''), tags: [],
        createdAt, updatedAt: createdAt, deletedAt: null,
        storageSourceId: sourceId, storageSourceIds: [sourceId],
      }],
    }
    Object.assign(window, {
      __TAURI_OS_PLUGIN_INTERNALS__: {
        os_type: 'windows', platform: 'windows', arch: 'x86_64', family: 'windows',
        version: '10.0.22631', eol: '\r\n', exe_extension: '.exe',
      },
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
      __TIE_STARTUP_TEST__: { nativeCalls, unexpectedCommands, deferredStarts },
      __TAURI_INTERNALS__: {
        transformCallback: () => 1,
        async invoke(command: string) {
          nativeCalls.push(command)
          if (['load_backend_session', 'load_s3_providers', 'refresh_startup_integrations', 'list_skill_connections', 'list_workspace_files', 'list_page_audit_events', 'list_page_reviews'].includes(command)) {
            const editor = document.querySelector('.editor-pane')
            const title = document.querySelector<HTMLInputElement>('[aria-label="页面标题"]')
            deferredStarts.push({
              command,
              localPageVisible: Boolean(editor?.getClientRects().length)
                && title?.value === '本地启动测试页'
                && Boolean(document.querySelector('.tiptap')?.textContent?.includes('本机正文已打开。')),
            })
          }
          switch (command) {
            case 'load_backend_session':
            case 'load_s3_providers':
            case 'list_skill_connections':
            case 'list_workspace_files': return new Promise(() => {})
            case 'load_workspace': return structuredClone(snapshot)
            case 'load_s3_provider_metadata':
            case 'consume_open_file_paths':
            case 'list_page_audit_events': return []
            case 'list_page_reviews': return { entries: [] }
            case 'get_change_origin': return { clientId: 'tie-desktop', clientName: 'Tie 桌面', clientVersion: 'test', deviceId: 'dev_startup', deviceName: 'Startup fixture', platform: 'windows', actor: 'Tie 桌面' }
            case 'refresh_startup_integrations': return null
            case 'backend_sync_cursor': return {}
            case 'read_native_file_bytes': return [...new TextEncoder().encode(JSON.stringify({ applied: ['href-file-protocol-v1'] }))]
            case 'plugin:os|hostname': return 'Startup fixture'
            case 'plugin:app|version': return '1.0.56'
            case 'plugin:updater|check': return null
            case 'plugin:event|listen': return 1
            case 'plugin:event|unlisten': return null
            default:
              unexpectedCommands.push(command)
              throw new Error(`Unexpected native command: ${command}`)
          }
        },
      },
    })
  }, hasFileReference)

  await page.goto('/')
  await expect(page.locator('.loading-screen')).toBeHidden({ timeout: 5_000 })
  await expect(page.locator('.workspace-heading')).toContainText('本机启动测试')
  await expect(page.locator('.sidebar')).toBeVisible()
  await expect(page.getByRole('treeitem', { name: /本地启动测试页/ })).toBeVisible()
  await expect(page.getByRole('textbox', { name: '页面标题' })).toHaveValue('本地启动测试页')
  await expect(page.locator('.tiptap')).toContainText('本机正文已打开。')
  const deferredCommands = ['load_backend_session', 'load_s3_providers', 'refresh_startup_integrations', 'list_skill_connections'].sort()
  await expect.poll(() => page.evaluate((expected) => (
    window as unknown as { __TIE_STARTUP_TEST__: { deferredStarts: { command: string }[] } }
  ).__TIE_STARTUP_TEST__.deferredStarts.map((item) => item.command).filter((command) => expected.includes(command)).sort(), deferredCommands)).toEqual(deferredCommands)
  if (hasFileReference) await expect(page.locator('.tiptap a[href^="tie://file/"]')).toHaveClass(/file-link/)

  const nativeCalls = () => page.evaluate(() => (
    window as unknown as { __TIE_STARTUP_TEST__: { nativeCalls: string[] } }
  ).__TIE_STARTUP_TEST__.nativeCalls)
  expect(await nativeCalls()).not.toContain('list_page_audit_events')

  const fileCallsBeforeLinks = (await nativeCalls()).filter((command) => command === 'list_workspace_files').length
  await page.locator('.context-tabs').getByRole('button', { name: '链接', exact: true }).click()
  if (hasFileReference) {
    await expect.poll(async () => (await nativeCalls()).filter((command) => command === 'list_workspace_files').length).toBeGreaterThan(fileCallsBeforeLinks)
    await expect(page.locator('.link-panel .file-resource-open')).toContainText('file_startup_fixture')
  } else {
    await expect(page.locator('.link-panel')).toContainText('正文中的 tie://file/')
    expect(await nativeCalls()).not.toContain('list_workspace_files')
  }
  await expect(page.locator('.tiptap')).toContainText('本机正文已打开。')
  await page.locator('.context-tabs').getByRole('button', { name: '变更', exact: true }).click()
  await expect.poll(nativeCalls).toContain('list_page_reviews')
  await expect(page.locator('.audit-panel')).toBeVisible()
  await page.locator('.context-tabs').getByRole('button', { name: '大纲', exact: true }).click()
  await expect(page.locator('.outline-list')).toBeVisible()
  const calls = await page.evaluate(() => (
    window as unknown as { __TIE_STARTUP_TEST__: {
      nativeCalls: string[]; unexpectedCommands: string[]
      deferredStarts: { command: string; localPageVisible: boolean }[]
    } }
  ).__TIE_STARTUP_TEST__)
  expect([...new Set(calls.deferredStarts.map((item) => item.command))].sort()).toEqual([
    ...deferredCommands, ...(hasFileReference ? ['list_workspace_files'] : []), 'list_page_audit_events', 'list_page_reviews',
  ].sort())
  for (const deferred of calls.deferredStarts) {
    expect(calls.nativeCalls.indexOf('load_workspace')).toBeLessThan(calls.nativeCalls.indexOf(deferred.command))
    expect(deferred.localPageVisible, `${deferred.command} started before the local editor was visible`).toBe(true)
  }
  expect(calls.unexpectedCommands).toEqual([])
})
}
