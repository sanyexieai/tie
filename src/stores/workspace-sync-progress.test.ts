import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { backendService } from '@/services/backend'
import { workspaceService } from '@/services/workspace'
import { useBackendStore } from './backend'
import { useWorkspaceStore } from './workspace'

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
