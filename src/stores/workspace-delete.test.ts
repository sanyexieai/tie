import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useWorkspaceStore } from './workspace'
import { useBackendStore } from './backend'
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
  backend.profile = { endpoint: 'http://localhost', accessToken: 'test', refreshToken: null, accessExpiresAt: null, user: { id: 'user', name: 'Test', email: 'test@example.com', createdAt: '' } }
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

  it('keeps a tombstone on the local page so sync can push it', async () => {
    const store = useWorkspaceStore()
    store.workspace = { id: 'local', name: 'Test', sources: [{ id: 'local:test', name: 'Test', kind: 'local', path: '/tmp/test' }] }
    store.pages = [page()]
    expect(store.pages[0]?.deletedAt).toBe(page().deletedAt)
    expect(store.backendSyncMode).toBe('idle')
  })

  it('keeps the local tombstone when cloud sync is not available', async () => {
    const store = useWorkspaceStore()
    store.workspace = { id: 'local', name: 'Test', sources: [{ id: 'local:test', name: 'Test', kind: 'local', path: '/tmp/test' }] }
    store.pages = [{ ...page(), deletedAt: null }]
    vi.spyOn(workspaceService, 'savePage').mockImplementation(async (page) => page)
    await store.trashPage('pg_deleted')
    expect(store.pages[0]?.deletedAt).toBeTruthy()
    expect(store.saving).toBe(false)
  })
})
