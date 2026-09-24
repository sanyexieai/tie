import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useWorkspaceStore } from './workspace'
import { useBackendStore } from './backend'
import { backendService } from '@/services/backend'
import { storageRegistry } from '@/services/storage'
import { workspaceService } from '@/services/workspace'
import type { Page } from '@/types'

vi.mock('@/services/storage/blobs', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/storage/blobs')>(),
  blobStoreFor: () => ({ list: async () => [] }),
}))

function page(): Page {
  return { id: 'pg_deleted', title: 'Deleted', markdown: '# Deleted', icon: '', tags: [],
    parentId: null, sortKey: 0, storageSourceId: 'local:test', storageSourceIds: ['local:test'],
    createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-24T00:00:00Z', deletedAt: '2026-09-24T00:00:00Z' }
}

beforeEach(() => {
  vi.restoreAllMocks()
  setActivePinia(createPinia())
  vi.spyOn(workspaceService, 'savePreferences').mockImplementation(() => {})
  const backend = useBackendStore()
  backend.profile = { endpoint: 'http://localhost', accessToken: 'test', user: { id: 'user', name: 'Test', email: 'test@example.com' } }
  vi.spyOn(backendService, 'ensureWorkspaceForLocalSource').mockResolvedValue({ id: 'cloud', name: 'Test', ownerId: 'user', createdAt: '' })
})

describe('cloud deletion sync', () => {
  it('rejects an editor draft queued behind trash, but allows explicit restore', async () => {
    const store = useWorkspaceStore()
    useBackendStore().profile.accessToken = null
    const original = { ...page(), deletedAt: null }
    store.pages = [original]
    store.activePageId = original.id
    const save = vi.spyOn(workspaceService, 'savePage').mockImplementation(async (page) => page)
    const trash = store.trashPage(original.id)
    const staleSave = expect(store.persist({ ...original }, { force: true })).rejects.toThrow('回收站')
    await trash
    await staleSave
    expect(store.pages[0]?.deletedAt).toBeTruthy()
    expect(store.activePageId).toBeNull()
    expect(save).toHaveBeenCalledTimes(1)
    await store.restorePage(original.id)
    expect(store.pages[0]?.deletedAt).toBeNull()
    expect(store.activePageId).toBe(original.id)
  })

  it('uploads offline tombstones when reconnecting', async () => {
    const store = useWorkspaceStore()
    store.workspace = { id: 'local', name: 'Test', sources: [{ id: 'local:test', name: 'Test', kind: 'local', path: '/tmp/test' }] }
    store.pages = [page()]
    const save = vi.spyOn(storageRegistry, 'savePage').mockImplementation(async (page) => page)
    expect(await store.syncLocalToDefaultBackend(true)).toBe(1)
    expect(save.mock.calls[0]?.[0].deletedAt).toBe(page().deletedAt)
    expect(save.mock.calls[0]?.[1]?.writeSourceId).toBe('backend:cloud')
  })

  it('reports a failed cloud trash update instead of claiming success', async () => {
    const store = useWorkspaceStore()
    store.workspace = { id: 'local', name: 'Test', sources: [{ id: 'local:test', name: 'Test', kind: 'local', path: '/tmp/test' }] }
    store.pages = [{ ...page(), deletedAt: null }]
    vi.spyOn(workspaceService, 'savePage').mockImplementation(async (page) => page)
    vi.spyOn(storageRegistry, 'savePage').mockRejectedValue(new Error('cloud unavailable'))
    await expect(store.trashPage('pg_deleted')).rejects.toThrow('cloud unavailable')
    expect(store.saving).toBe(false)
  })
})
