import { expect, test } from '@playwright/test'

test('defers desktop CLI discovery until MCP settings open and keeps update checking interactive', async ({ page }) => {
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url())
    if (url.hostname === '127.0.0.1') return route.continue()
    if (url.pathname.endsWith('latest.json')) {
      return route.fulfill({
        json: { version: '1.0.69', platforms: { 'windows-x86_64': { url: 'https://example.test/Tie.exe', signature: 'fixture' } } },
        headers: { 'access-control-allow-origin': '*' },
      })
    }
    return route.abort()
  })
  await page.addInitScript(() => {
    localStorage.clear()
    const sourceId = 'src_local_update_fixture'
    const createdAt = '2026-11-28T00:00:00.000Z'
    const snapshot = {
      workspace: { id: 'workspace_update_fixture', name: '更新响应测试', sources: [
        { id: sourceId, name: '本机测试库', kind: 'local', path: 'C:\\Tie\\Fixture', available: true },
      ] },
      pages: [{ id: 'pg_update_fixture', title: '本地页面', icon: '', parentId: null, sortKey: 0,
        markdown: '# 本地页面\n\n更新期间仍然可操作。', tags: [], createdAt, updatedAt: createdAt,
        deletedAt: null, storageSourceId: sourceId, storageSourceIds: [sourceId] }],
    }
    const calls: { command: string; args: Record<string, unknown> }[] = []
    const unexpectedCommands: string[] = []
    let updateChecks = 0
    let finishUpdate: (() => void) | null = null
    Object.assign(window, {
      __TIE_UPDATE_TEST__: { calls, unexpectedCommands, finishUpdate: () => finishUpdate?.() },
      __TAURI_OS_PLUGIN_INTERNALS__: { os_type: 'windows', arch: 'x86_64' },
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
      __TAURI_INTERNALS__: {
        transformCallback: () => 1,
        async invoke(command: string, args: Record<string, unknown> = {}) {
          calls.push({ command, args })
          switch (command) {
            case 'load_workspace': return structuredClone(snapshot)
            case 'load_backend_session': return null
            case 'load_s3_provider_metadata':
            case 'load_s3_providers':
            case 'consume_open_file_paths':
            case 'list_skill_connections':
            case 'list_page_audit_events': return []
            case 'list_page_reviews': return { entries: [] }
            case 'get_change_origin': return { clientId: 'tie-desktop', clientName: 'Tie 桌面', clientVersion: 'test', deviceId: 'dev_update', deviceName: 'Update fixture', platform: 'windows', actor: 'Tie 桌面' }
            case 'refresh_startup_integrations': return null
            case 'backend_sync_cursor': return {}
            case 'read_native_file_bytes': return [...new TextEncoder().encode(JSON.stringify({ applied: ['href-file-protocol-v1'] }))]
            case 'plugin:os|hostname': return 'Update fixture'
            case 'plugin:app|version': return '1.0.69'
            case 'plugin:updater|check':
              updateChecks += 1
              if (updateChecks === 1) return null
              return new Promise<null>((resolve) => { finishUpdate = () => resolve(null) })
            case 'agent_mcp_status': return new Promise(() => {})
            case 'plugin:event|listen': return 1
            case 'plugin:event|unlisten': return null
            default:
              unexpectedCommands.push(command)
              throw new Error(`Unexpected native command: ${command}`)
          }
        },
      },
    })
  })

  const commands = () => page.evaluate(() => (
    window as unknown as { __TIE_UPDATE_TEST__: { calls: { command: string; args: Record<string, unknown> }[] } }
  ).__TIE_UPDATE_TEST__.calls)
  await page.goto('/')
  await expect(page.locator('.tiptap')).toContainText('更新期间仍然可操作。')
  await expect.poll(async () => (await commands()).filter((call) => call.command === 'plugin:updater|check').length).toBe(1)
  await page.locator('.sidebar-storage-trigger').click()
  const settings = page.getByRole('dialog', { name: '设置', exact: true })
  await expect(settings.locator('.app-update-row')).toContainText('已是最新版本')
  expect((await commands()).filter((call) => ['agent_mcp_status', 'locate_tie_cli'].includes(call.command))).toEqual([])
  await settings.getByRole('button', { name: '检查更新', exact: true }).click()
  await expect(settings.getByRole('button', { name: '检查中…', exact: true })).toBeDisabled()
  expect((await commands()).filter((call) => ['agent_mcp_status', 'locate_tie_cli'].includes(call.command))).toEqual([])
  await settings.getByRole('button', { name: '深色', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await settings.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(settings).toBeHidden()
  await page.locator('.sidebar-storage-trigger').click()
  await expect(settings).toBeVisible()
  await expect(settings.getByRole('button', { name: '检查中…', exact: true })).toBeDisabled()
  await settings.getByRole('button', { name: '浅色', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  const pendingCalls = await commands()
  expect(pendingCalls.filter((call) => call.command === 'plugin:updater|check')).toHaveLength(2)
  expect(pendingCalls.filter((call) => ['agent_mcp_status', 'locate_tie_cli'].includes(call.command))).toEqual([])
  await settings.getByRole('button', { name: 'Agent 知识库', exact: true }).click()
  await expect(settings.locator('.codex-mcp-form')).toBeVisible()
  await expect(settings.locator('.codex-mcp-form')).toContainText('正在检测本机桥接…')
  await expect.poll(async () => (await commands()).filter((call) => call.command === 'agent_mcp_status').length).toBe(1)
  expect((await commands()).filter((call) => call.command === 'locate_tie_cli')).toHaveLength(0)
  await settings.getByRole('button', { name: '深色', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await settings.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(settings).toBeHidden()
  await page.locator('.sidebar-storage-trigger').click()
  await expect(settings).toBeVisible()
  expect((await commands()).filter((call) => call.command === 'agent_mcp_status')).toHaveLength(1)
  await page.evaluate(() => (
    window as unknown as { __TIE_UPDATE_TEST__: { finishUpdate: () => void } }
  ).__TIE_UPDATE_TEST__.finishUpdate())
  await expect(settings.getByRole('button', { name: '检查更新', exact: true })).toBeEnabled()
  await expect(settings.locator('.app-update-row')).toContainText('已是最新版本')
  expect(await page.evaluate(() => (
    window as unknown as { __TIE_UPDATE_TEST__: { unexpectedCommands: string[] } }
  ).__TIE_UPDATE_TEST__.unexpectedCommands)).toEqual([])
})
