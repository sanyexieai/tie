import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { backendService } from '@/services/backend'
import { workspaceService } from '@/services/workspace'
import { useBackendStore } from './backend'
import { useWorkspaceStore } from './workspace'
import type { Page, WorkspaceSnapshot } from '@/types'

const native = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }))
vi.mock('@tauri-apps/api/event', () => ({ listen: native.listen }))

const temporaryId = 'src_temporary_external'
function page(id: string, storageSourceId = 'local:a'): Page {
  return { id, title: id, markdown: `# ${id}\n\nContent`, icon: '', tags: [], parentId: null, sortKey: 0,
    storageSourceId, storageSourceIds: [storageSourceId], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', deletedAt: null }
}
function snapshot(includeTemporary = true): WorkspaceSnapshot {
  return {
    workspace: { id: 'local', name: 'Test', sources: [
      { id: 'local:a', name: 'A', path: '/tmp/a', kind: 'local' },
      ...(includeTemporary ? [{ id: temporaryId, name: 'external.md', path: '/tmp', kind: 'local' as const, temporary: true }] : []),
    ] },
    pages: [page('local'), ...(includeTemporary ? [page('external', temporaryId)] : [])],
  }
}
function setup() {
  const store = useWorkspaceStore()
  const initial = snapshot()
  store.workspace = initial.workspace
  store.pages = initial.pages
  return store
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

beforeEach(() => {
  setActivePinia(createPinia())
  const values = new Map<string, string>([['tie.workspace.migrations.applied', '["href-file-protocol-v1"]']])
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) })
  vi.stubGlobal('window', Object.assign(new EventTarget(), { __TAURI_INTERNALS__: {} }))
  vi.stubGlobal('navigator', { onLine: true })
  native.invoke.mockReset()
  native.invoke.mockResolvedValue({})
  native.listen.mockResolvedValue(() => {})
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('keeps temporary preferences in the session and excludes them from saved preferences and formal defaults', async () => {
  const store = setup()
  store.storageSourceOrder = [temporaryId, 'local:a']
  store.openPage('external')
  store.toggleFavorite('external')
  store.togglePageCollapsed('external')
  expect(store.recentPageIds).toContain('external')
  expect(store.favoritePageIds).toContain('external')
  expect(store.collapsedPageIds).toContain('external')
  expect(store.defaultStorageSourceId).toBe('local:a')
  expect(store.skillsWorkspaceSource?.id).toBe('local:a')
  expect(JSON.parse(localStorage.getItem('tie-workspace-preferences-v1:local')!)).toMatchObject({
    recentPageIds: [], favoritePageIds: [], collapsedPageIds: [], storageSourceOrder: ['local:a'],
  })
  store.workspace!.sources = store.workspace!.sources.filter((source) => source.temporary)
  store.pages = store.pages.filter((item) => item.storageSourceId === temporaryId)
  expect(store.defaultStorageSourceId).toBeNull()
  expect(store.skillsWorkspaceSource).toBeNull()
  await expect(store.createPage(null)).rejects.toThrow('请先添加一个工作区')
})

it('serializes the real store open flow so concurrent file events retain both snapshots', async () => {
  const store = setup()
  const first = deferred<Awaited<ReturnType<typeof workspaceService.openMarkdownFiles>>>()
  const open = vi.spyOn(workspaceService, 'openMarkdownFiles').mockReturnValueOnce(first.promise).mockResolvedValueOnce({ snapshot: snapshot(), openedPageIds: ['external'], createdSourceIds: [temporaryId] })
  const one = store.openFromFiles(['/tmp/first.md'])
  const two = store.openFromFiles(['/tmp/second.md'])
  await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(1))
  first.resolve({ snapshot: snapshot(false), openedPageIds: ['local'], createdSourceIds: [] })
  await Promise.all([one, two])
  expect(open.mock.calls).toEqual([[['/tmp/first.md']], [['/tmp/second.md']]])
  expect(store.pages.map((item) => item.id)).toEqual(['local', 'external'])
  expect(store.activePageId).toBe('external')
})

it('flushes the registered editor before switching, opening, or closing and preserves the current workspace on failure', async () => {
  const store = setup()
  store.openPage('external')
  const save = vi.fn(async () => false)
  const unregister = store.registerEditorSaveHandler(save)
  const remove = vi.spyOn(workspaceService, 'removeStorageSource').mockResolvedValue(snapshot(false))
  const open = vi.spyOn(workspaceService, 'openMarkdownFiles').mockResolvedValue(null)
  expect(await store.openPage('local')).toBe(false)
  expect(await store.removeStorageSource(temporaryId)).toBe(false)
  expect(await store.openFromFiles(['/tmp/new.md'])).toBe(false)
  expect(store.activePageId).toBe('external')
  expect(remove).not.toHaveBeenCalled()
  expect(open).not.toHaveBeenCalled()
  save.mockResolvedValue(true)
  await store.removeStorageSource(temporaryId)
  expect(remove).toHaveBeenCalledWith(temporaryId)
  expect(store.activePageId).toBe('local')
  expect(store.pages.map((item) => item.id)).toEqual(['local'])
  unregister()
  expect(store.openPage('local')).toBe(true)
})

it('does not run backend sync or cursor reads for temporary sources', async () => {
  const store = setup()
  useBackendStore().profile = {
    endpoint: 'https://backend.example.test', accessToken: 'fixture', refreshToken: null, accessExpiresAt: null,
    user: { id: 'usr_fixture', name: 'Fixture', email: 'fixture@example.test', createdAt: '' },
  }
  vi.spyOn(backendService, 'listWorkspaces').mockResolvedValue([{ id: 'ws_fixture', name: 'Fixture', ownerId: 'usr_fixture', createdAt: '' }])
  native.invoke.mockImplementation(async (command: string) => command === 'sync_backend_workspace' ? { pushed: 0, pulled: 0, conflicts: [] } : {})
  await store.syncBackendNow()
  expect(native.invoke.mock.calls.filter(([command]) => command === 'sync_backend_workspace' || command === 'backend_sync_cursor').map(([, args]) => args.sourceId)).toEqual(['local:a', 'local:a'])
  expect(store.pageBackendSync('external')).toBeNull()
})

it.each(['switch', 'open', 'close'])('waits for the actual registered save before %s changes the visible page or session source', async (action) => {
  const store = setup()
  store.openPage('external')
  const saving = deferred<boolean>()
  store.registerEditorSaveHandler(() => saving.promise)
  const remove = vi.spyOn(workspaceService, 'removeStorageSource').mockResolvedValue(snapshot(false))
  const open = vi.spyOn(workspaceService, 'openMarkdownFiles').mockResolvedValue({ snapshot: snapshot(), openedPageIds: ['local'], createdSourceIds: [] })
  const work = action === 'switch' ? store.openPage('local') : action === 'open' ? store.openFromFiles(['/tmp/next.md']) : store.removeStorageSource(temporaryId)
  await Promise.resolve()
  expect(store.activePageId).toBe('external')
  expect(store.workspace!.sources.some((source) => source.temporary)).toBe(true)
  expect(remove).not.toHaveBeenCalled()
  expect(open).not.toHaveBeenCalled()
  saving.resolve(true)
  await work
  expect(store.activePageId).toBe('local')
})

it('does not automatically migrate or save links in temporary Markdown during background initialization', async () => {
  const store = setup()
  store.pages[1]!.markdown = '[outside](file:///tmp/document.pdf) [relative](tie://path/docs/readme.md)'
  vi.spyOn(workspaceService, 'flushSyncQueue').mockResolvedValue([])
  vi.spyOn(workspaceService, 'loadWithSync').mockResolvedValue({ snapshot: { workspace: store.workspace!, pages: store.pages }, syncResults: [] })
  const save = vi.spyOn(workspaceService, 'savePage')
  native.invoke.mockImplementation(async (command: string) => command === 'load_s3_providers' ? [] : {})
  await store.initializeBackground()
  expect(save).not.toHaveBeenCalled()
  expect(store.pages[1]!.markdown).toContain('file:///tmp/document.pdf')
  expect(native.invoke.mock.calls.some(([command, args]) => (command === 'write_workspace_file' || command === 'backend_sync_cursor') && args?.sourceId === temporaryId)).toBe(false)
  await expect(store.createChildPage('external')).rejects.toThrow('临时工作区')
  await expect(store.duplicatePage('external')).rejects.toThrow('正式工作区')
  expect(store.canTransferPageTo('local:a', temporaryId)).toBe(false)
  expect(await store.movePage('local', 'external')).toBe(false)
})

it('keeps an external editor change when a temporary file has an unsaved Tie draft', async () => {
  const store = setup()
  const previous = store.pages[1]!
  const latest = { ...previous, markdown: 'Changed outside Tie', updatedAt: '2026-01-02T00:00:00Z' }
  vi.spyOn(workspaceService, 'readLatestPage').mockResolvedValue(latest)
  const save = vi.spyOn(workspaceService, 'savePage')
  await expect(store.persist({ ...previous, markdown: 'Unsaved Tie draft' })).rejects.toThrow('磁盘上被修改')
  expect(save).not.toHaveBeenCalled()
  expect(store.syncConflicts.has(previous.id)).toBe(true)
  expect(latest.markdown).toBe('Changed outside Tie')
})

it('does not force retry a temporary write rejected after an external disk change', async () => {
  const store = setup()
  const previous = store.pages[1]!
  const latest = { ...previous, markdown: 'Changed outside Tie', updatedAt: '2026-01-02T00:00:00Z' }
  vi.spyOn(workspaceService, 'readLatestPage').mockResolvedValueOnce(previous).mockResolvedValue(latest)
  const save = vi.spyOn(workspaceService, 'savePage').mockRejectedValue(new Error('页面文件已被其他程序修改，请重新载入后再保存'))
  await expect(store.persist({ ...previous, markdown: 'Unsaved Tie draft' })).rejects.toThrow('其他程序修改')
  expect(save).toHaveBeenCalledTimes(1)
  expect(save.mock.calls[0]![1]).toEqual({ expectedUpdatedAt: previous.updatedAt, force: false })
})
