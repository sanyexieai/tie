import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useWorkspaceStore } from '@/stores/workspace'
import { workspaceService } from '@/services/workspace'
import type { Page, StorageSource } from '@/types'

const cloud: StorageSource = { id: 'backend:ws_empty', name: '我的工作区', kind: 'backend', path: 'https://example.com' }
const local: StorageSource = { id: 'local:test', name: '本地', kind: 'local', path: '/tmp/test' }

beforeEach(() => {
  setActivePinia(createPinia())
  vi.spyOn(workspaceService, 'savePreferences').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('browser backend workspace sources', () => {
  it('creates the first document in an empty backend workspace', async () => {
    const store = useWorkspaceStore()
    store.workspace = { id: 'ws_empty', name: '我的工作区', sources: [cloud] }
    const page: Page = {
      id: 'pg_first', title: '无标题', markdown: '# 无标题\n', icon: '', tags: [],
      parentId: null, sortKey: 0, storageSourceId: cloud.id, storageSourceIds: [cloud.id],
      createdAt: '2026-11-25T00:00:00Z', updatedAt: '2026-11-25T00:00:00Z', deletedAt: null,
    }
    const create = vi.spyOn(workspaceService, 'createPage').mockResolvedValue(page)
    expect(store.defaultStorageSourceId).toBe(cloud.id)
    await expect(store.createPage(null)).resolves.toEqual(page)
    expect(create).toHaveBeenCalledWith(null, cloud.id)
    expect(store.activePageId).toBe(page.id)
  })

  it('keeps the desktop source list local when a backend is connected', () => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {}, addEventListener: vi.fn() })
    const store = useWorkspaceStore()
    store.workspace = { id: 'desktop', name: '本地', sources: [local, cloud] }
    expect(store.allSources.map((source) => source.id)).toEqual([local.id])
    expect(store.defaultStorageSourceId).toBe(local.id)
  })
})
