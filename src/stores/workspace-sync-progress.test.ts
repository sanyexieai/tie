import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { backendService } from '@/services/backend'
import { workspaceService } from '@/services/workspace'
import { useBackendStore } from './backend'
import { useWorkspaceStore } from './workspace'
import type { Page } from '@/types'

const native = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }))
vi.mock('@tauri-apps/api/event', () => ({ listen: native.listen }))

type Progress = NonNullable<ReturnType<typeof useWorkspaceStore>['backendSyncProgress']>
type Report = { pushed: number; pulled: number; conflicts: string[] }
let onProgress: (event: { payload: Progress }) => void
const unlisten = vi.fn()

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

function setup(sources = ['local:a']) {
  const store = useWorkspaceStore()
  store.workspace = { id: 'local', name: 'Test', sources: sources.map((id) => ({ id, name: id, kind: 'local', path: '/tmp/test' })) }
  return store
}

beforeEach(() => {
  vi.resetAllMocks()
  setActivePinia(createPinia())
  vi.stubGlobal('window', { __TAURI_INTERNALS__: {}, addEventListener: vi.fn() })
  vi.stubGlobal('navigator', { onLine: true })
  useBackendStore().profile = {
    endpoint: 'https://backend.example.test', accessToken: 'test', refreshToken: null, accessExpiresAt: null,
    user: { id: 'usr_test', name: 'Test', email: 'test@example.test', createdAt: '' },
  }
  vi.spyOn(backendService, 'listWorkspaces').mockResolvedValue([{ id: 'ws_test', name: 'Test', ownerId: 'usr_test', createdAt: '' }])
  vi.spyOn(workspaceService, 'savePreferences').mockImplementation(() => {})
  native.listen.mockImplementation(async (_event, callback: typeof onProgress) => { onProgress = callback; return unlisten })
  native.invoke.mockResolvedValue({})
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('desktop backend sync progress', () => {
  it('keeps an idle interval check quiet and applies only reported changed pages', async () => {
    const surface = Object.assign(new EventTarget(), { __TAURI_INTERNALS__: {} })
    vi.stubGlobal('window', surface)
    const store = setup()
    const original: Page = { id: 'pg_changed', title: 'Changed', markdown: 'old', icon: '', tags: [], parentId: null, sortKey: 0,
      createdAt: '2026-11-25T00:00:00Z', updatedAt: '2026-11-25T00:00:00Z', deletedAt: null, storageSourceId: 'local:a', storageSourceIds: ['local:a'] }
    const untouched = { ...original, id: 'pg_untouched', title: 'Untouched' }
    store.pages = [original, untouched]
    const reload = vi.spyOn(workspaceService, 'loadWithSync')
    const idle = deferred<Report>()
    native.invoke.mockImplementation((command) => command === 'sync_backend_workspace' ? idle.promise : Promise.resolve({}))
    const check = store.syncBackendNow({ quiet: true })
    await vi.waitFor(() => expect(native.invoke).toHaveBeenCalledWith('sync_backend_workspace', expect.any(Object)))
    onProgress({ payload: { sourceId: 'local:a', stage: 'connecting', completed: 0, total: 3 } })
    expect(store.backendSyncRunning).toBe(false)
    expect(store.backendSyncProgress).toBeNull()
    idle.resolve({ pushed: 0, pulled: 0, conflicts: [] })
    await check
    expect(store.backendSyncLastCompletedAt).toBeNull()

    const changed = { ...original, markdown: 'remote changed', updatedAt: '2026-11-26T00:00:00Z' }
    const reviews = vi.fn()
    surface.addEventListener('tie:reviews-changed', reviews)
    native.invoke.mockImplementation((command) => Promise.resolve(command === 'sync_backend_workspace'
      ? { pushed: 0, pulled: 1, conflicts: [], changed: true, changedPages: [changed], removedPageIds: [], reviewPageIds: [original.id] } : {}))
    await store.syncBackendNow({ quiet: true })
    expect(store.pages.find((page) => page.id === original.id)?.markdown).toBe('remote changed')
    expect(store.pages.find((page) => page.id === untouched.id)?.markdown).toBe('old')
    expect(reload).not.toHaveBeenCalled()
    expect(reviews).toHaveBeenCalledOnce()
    expect(store.backendSyncLastCompletedAt).not.toBeNull()
  })

  it('keeps a save made during an incremental pull and removes only the reported source binding', async () => {
    const store = setup(['local:a', 'local:b'])
    const original: Page = { id: 'pg_changed', title: 'Changed', markdown: 'old', icon: '', tags: [], parentId: null, sortKey: 0,
      createdAt: '2026-11-25T00:00:00Z', updatedAt: '2026-11-25T00:00:00Z', deletedAt: null, storageSourceId: 'local:a', storageSourceIds: ['local:a'] }
    const shared = { ...original, id: 'pg_shared', storageSourceIds: ['local:a', 'local:b'] }
    store.pages = [original, shared]
    const work = deferred<Report>()
    native.invoke.mockImplementation((command, args: { sourceId: string }) => command === 'sync_backend_workspace' && args.sourceId === 'local:a'
      ? work.promise : Promise.resolve(command === 'sync_backend_workspace'
        ? { pushed: 0, pulled: 1, conflicts: [], changedPages: [{ ...shared, markdown: 'updated in the surviving source', updatedAt: '2026-11-26T00:00:00Z', storageSourceId: 'local:b', storageSourceIds: ['local:b'] }] } : {}))
    const sync = store.syncBackendNow()
    await vi.waitFor(() => expect(native.invoke).toHaveBeenCalledWith('sync_backend_workspace', expect.any(Object)))
    store.pages[0] = { ...original, markdown: 'saved during pull', updatedAt: '2026-11-27T00:00:00Z' }
    work.resolve({ pushed: 0, pulled: 1, conflicts: [], changedPages: [{ ...original, markdown: 'earlier remote response', updatedAt: '2026-11-26T00:00:00Z' }], removedPageIds: [shared.id] } as Report)
    await sync
    expect(store.pages.find((page) => page.id === original.id)?.markdown).toBe('saved during pull')
    expect(store.pages.find((page) => page.id === shared.id)?.storageSourceIds).toEqual(['local:b'])
    expect(store.pages.find((page) => page.id === shared.id)?.markdown).toBe('updated in the surviving source')
  })

  it('keeps a new in-flight editor draft when the native pull has trashed its disk page', async () => {
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() })
    vi.stubGlobal('window', Object.assign(new EventTarget(), { __TAURI_INTERNALS__: {} }))
    const store = setup()
    const original: Page = { id: 'pg_draft', title: 'Draft', markdown: 'saved before request', icon: '', tags: [], parentId: null, sortKey: 0,
      createdAt: '2026-11-25T00:00:00Z', updatedAt: '2026-11-25T00:00:00Z', deletedAt: null, storageSourceId: 'local:a', storageSourceIds: ['local:a'] }
    store.pages = [original]
    store.activePageId = original.id
    let dirty = false
    const flush = vi.fn(async () => !dirty)
    store.registerEditorSaveHandler(flush, () => dirty)
    const persist = vi.spyOn(workspaceService, 'savePage')
    const work = deferred<Report>()
    native.invoke.mockImplementation((command) => command === 'sync_backend_workspace' ? work.promise : Promise.resolve({}))
    const result = expect(store.syncBackendNow()).rejects.toThrow('已保留草稿')
    await vi.waitFor(() => expect(native.invoke).toHaveBeenCalledWith('sync_backend_workspace', expect.any(Object)))
    dirty = true
    work.resolve({ pushed: 0, pulled: 1, conflicts: [], changedPages: [{ ...original, deletedAt: '2026-11-27T00:00:00Z', updatedAt: '2026-11-27T00:00:00Z' }],
      localVersions: { pages: { [original.id]: 'native-trash-version' }, reviews: {}, assets: {}, files: {} } } as Report)
    await result
    expect(store.activePageId).toBe(original.id)
    expect(store.pages[0]!.deletedAt).toBeNull()
    expect(store.syncConflicts.has(original.id)).toBe(true)
    expect(flush).toHaveBeenCalledOnce()
    expect(persist).not.toHaveBeenCalled()
    vi.spyOn(workspaceService, 'readLatestPage').mockResolvedValue({ ...original, deletedAt: '2026-11-27T00:00:00Z', updatedAt: '2026-11-27T00:00:00Z' })
    await expect(store.persist({ ...original, markdown: 'draft after remote trash' })).rejects.toThrow('其他设备更新')
    expect(persist).not.toHaveBeenCalled()
    await expect(store.syncBackendNow({ quiet: true })).rejects.toThrow('已保留草稿')
    expect(native.invoke.mock.calls.filter(([command]) => command === 'sync_backend_workspace')).toHaveLength(1)
  })

  it('does not apply an earlier account report after the login identity changes', async () => {
    const store = setup()
    const work = deferred<Report>()
    native.invoke.mockImplementation((command) => command === 'sync_backend_workspace' ? work.promise : Promise.resolve({}))
    const flight = store.syncBackendNow()
    await vi.waitFor(() => expect(native.invoke).toHaveBeenCalledWith('sync_backend_workspace', expect.any(Object)))
    useBackendStore().profile = { ...useBackendStore().profile, user: { id: 'other_user', name: 'Other', email: 'other@example.test', createdAt: '' } }
    work.resolve({ pushed: 0, pulled: 1, conflicts: [], changedPages: [{ id: 'old_account_page', title: 'Old', markdown: 'old account content' }] } as Report)
    await flight
    expect(store.pages).toEqual([])
  })

  it('applies a newer in-flight page after releasing an older deferred protection view', async () => {
    vi.stubGlobal('window', Object.assign(new EventTarget(), { __TAURI_INTERNALS__: {}, setTimeout: vi.fn(() => 1), clearTimeout: vi.fn() }))
    const store = setup()
    const original: Page = { id: 'pg_held', title: 'Held', markdown: 'original', icon: '', tags: [], parentId: null, sortKey: 0,
      createdAt: '2026-11-25T00:00:00Z', updatedAt: '2026-11-25T00:00:00Z', deletedAt: null, storageSourceId: 'local:a', storageSourceIds: ['local:a'] }
    store.pages = [original]
    const release = store.holdPageForProtectionChange(original.id)
    native.invoke.mockImplementation((command) => Promise.resolve(command === 'sync_backend_workspace'
      ? { pushed: 0, pulled: 1, conflicts: [], changedPages: [{ ...original, markdown: 'older deferred body', updatedAt: '2026-11-26T00:00:00Z' }] } : {}))
    await store.syncBackendNow()
    expect(store.pages[0]!.markdown).toBe('original')
    const newer = deferred<Report>()
    native.invoke.mockImplementation((command) => command === 'sync_backend_workspace' ? newer.promise : Promise.resolve({}))
    const flight = store.syncBackendNow()
    await vi.waitFor(() => expect(native.invoke.mock.calls.filter(([command]) => command === 'sync_backend_workspace')).toHaveLength(2))
    release()
    expect(store.pages[0]!.markdown).toBe('original')
    newer.resolve({ pushed: 0, pulled: 1, conflicts: [], changedPages: [{ ...original, markdown: 'newer incoming body', updatedAt: '2026-11-27T00:00:00Z' }] } as Report)
    await flight
    await Promise.resolve()
    expect(store.pages[0]!.markdown).toBe('newer incoming body')
  })

  it('registers before invoking, filters sequential sources, and cleans up a shared successful flight', async () => {
    const first = deferred<Report>()
    const second = deferred<Report>()
    const store = setup(['local:a', 'local:b'])
    const syncingSources: string[] = []
    native.invoke.mockImplementation((command, args: { sourceId: string }) => {
      if (command !== 'sync_backend_workspace') return Promise.resolve({})
      expect(native.listen).toHaveBeenCalledOnce()
      syncingSources.push(args.sourceId)
      return args.sourceId === 'local:a' ? first.promise : second.promise
    })
    const flight = store.syncBackendNow()
    const sameFlight = store.syncBackendNow()
    expect(store.backendSyncRunning).toBe(true)
    await vi.waitFor(() => expect(syncingSources).toEqual(['local:a']))
    expect(native.listen).toHaveBeenCalledWith('backend-sync-progress', expect.any(Function))
    const pages: Progress = { sourceId: 'local:a', stage: 'pages', completed: 123, total: 672 }
    onProgress({ payload: pages })
    expect(store.backendSyncProgress).toEqual(pages)
    onProgress({ payload: { ...pages, sourceId: 'other', completed: 500 } })
    expect(store.backendSyncProgress).toEqual(pages)
    first.resolve({ pushed: 2, pulled: 0, conflicts: [] })
    await vi.waitFor(() => expect(syncingSources).toEqual(['local:a', 'local:b']))
    expect(store.backendSyncProgress).toBeNull()
    onProgress({ payload: pages })
    expect(store.backendSyncProgress).toBeNull()
    onProgress({ payload: { sourceId: 'local:b', stage: 'files', completed: 11, total: 11 } })
    expect(store.backendSyncProgress?.stage).toBe('files')
    second.resolve({ pushed: 1, pulled: 0, conflicts: [] })
    await expect(flight).resolves.toEqual({ pushed: 3, pulled: 0, conflicts: [] })
    await sameFlight
    expect(store.backendSyncMode).toBe('synced')
    expect(store.backendSyncLastCompletedAt).not.toBeNull()
    expect(store.backendSyncRunning).toBe(false)
    expect(store.backendSyncProgress).toBeNull()
    expect(unlisten).toHaveBeenCalledOnce()
    onProgress({ payload: pages })
    expect(store.backendSyncProgress).toBeNull()
  })

  it('clears progress and retains the failure reason, then permits a successful retry', async () => {
    const work = deferred<Report>()
    const store = setup()
    native.invoke.mockImplementation((command) => command === 'sync_backend_workspace' ? work.promise : Promise.resolve({}))
    const result = expect(store.syncBackendNow()).rejects.toBe('附件同步失败：503')
    await vi.waitFor(() => expect(native.invoke).toHaveBeenCalledWith('sync_backend_workspace', expect.any(Object)))
    onProgress({ payload: { sourceId: 'local:a', stage: 'assets', completed: 1, total: 6 } })
    work.reject('附件同步失败：503')
    await result
    expect(store.backendSyncMode).toBe('error')
    expect(useBackendStore().error).toBe('附件同步失败：503')
    expect(store.backendSyncProgress).toBeNull()
    expect(store.backendSyncRunning).toBe(false)
    expect(store.backendSyncLastCompletedAt).toBeNull()
    expect(unlisten).toHaveBeenCalledOnce()
    native.invoke.mockImplementation((command) => Promise.resolve(command === 'sync_backend_workspace' ? { pushed: 0, pulled: 0, conflicts: [] } : {}))
    await store.syncBackendNow()
    expect(store.backendSyncMode).toBe('synced')
    expect(useBackendStore().error).toBe('')
    expect(unlisten).toHaveBeenCalledTimes(2)
  })

  it('clears running state if the workspace request fails before registering a listener', async () => {
    const store = setup()
    vi.mocked(backendService.listWorkspaces).mockRejectedValue(new Error('无法连接后台'))
    await expect(store.syncBackendNow()).rejects.toThrow('无法连接后台')
    expect(store.backendSyncMode).toBe('error')
    expect(store.backendSyncRunning).toBe(false)
    expect(store.backendSyncProgress).toBeNull()
    expect(native.listen).not.toHaveBeenCalled()
  })

  it('finishes with a conflict state and no active progress', async () => {
    const store = setup()
    native.invoke.mockImplementation((command) => Promise.resolve(command === 'sync_backend_workspace' ? { pushed: 0, pulled: 0, conflicts: ['pg_conflict'] } : {}))
    await store.syncBackendNow()
    expect(store.backendSyncMode).toBe('conflict')
    expect(store.syncConflictsCount).toBe(1)
    expect(store.backendSyncRunning).toBe(false)
    expect(store.backendSyncProgress).toBeNull()
    expect(unlisten).toHaveBeenCalledOnce()
  })

  it.each(['logged out', 'browser', 'offline'])('does not invent progress when %s', async (condition) => {
    const store = setup()
    if (condition === 'logged out') useBackendStore().profile.accessToken = null
    if (condition === 'browser') vi.stubGlobal('window', { addEventListener: vi.fn() })
    if (condition === 'offline') vi.stubGlobal('navigator', { onLine: false })
    await expect(store.syncBackendNow()).resolves.toEqual({ pushed: 0, pulled: 0, conflicts: [] })
    expect(store.backendSyncMode).toBe('idle')
    expect(store.backendSyncRunning).toBe(false)
    expect(store.backendSyncProgress).toBeNull()
    expect(backendService.listWorkspaces).not.toHaveBeenCalled()
    expect(native.listen).not.toHaveBeenCalled()
    expect(native.invoke).not.toHaveBeenCalled()
  })
})
