import { afterEach, describe, expect, it, vi } from 'vitest'
import { storageRegistry } from '@/services/storage/registry'
import { browserStorageAdapter } from '@/services/storage/browser-adapter'
import type { Page } from '@/types'
import type { StorageAdapter } from '@/services/storage/types'

const page: Page = {
  id: 'pg_moving', title: 'Moving', markdown: '# Moving\n', icon: '', tags: [],
  parentId: null, sortKey: 0, storageSourceId: 'local:source', storageSourceIds: ['local:source'],
  createdAt: '2026-11-25T00:00:00Z', updatedAt: '2026-11-25T00:00:00Z', deletedAt: null,
}

afterEach(() => vi.restoreAllMocks())

describe('cross-adapter page transfer', () => {
  it.each(['assets', 'history'] as const)('keeps the source when copying %s fails', async (failure) => {
    const remove = vi.fn().mockResolvedValue(undefined)
    const targetSave = vi.fn().mockImplementation(async (draft: Page) => draft)
    const source: StorageAdapter = { ...browserStorageAdapter, permanentlyDeletePages: remove }
    const target: StorageAdapter = { ...browserStorageAdapter, savePage: targetSave }
    vi.spyOn(storageRegistry, 'resolve').mockImplementation((id) => id === 'backend:target' ? target : source)
    const copyHistory = vi.spyOn(storageRegistry, 'copyPageHistory').mockResolvedValue(undefined)
    const copyAssets = vi.spyOn(storageRegistry, 'copyPageAssets').mockResolvedValue(undefined)
    if (failure === 'assets') copyAssets.mockRejectedValue(new Error('附件复制失败'))
    else copyHistory.mockRejectedValue(new Error('历史复制失败'))

    await expect(storageRegistry.transferPageCrossAdapter(page, 'backend:target')).rejects.toThrow('复制失败')
    expect(targetSave).toHaveBeenCalledOnce()
    expect(remove).not.toHaveBeenCalled()
  })

  it('deletes the source only after history and assets are copied', async () => {
    const remove = vi.fn().mockResolvedValue(undefined)
    const source: StorageAdapter = { ...browserStorageAdapter, permanentlyDeletePages: remove }
    const target: StorageAdapter = { ...browserStorageAdapter, savePage: vi.fn().mockImplementation(async (draft: Page) => draft) }
    vi.spyOn(storageRegistry, 'resolve').mockImplementation((id) => id === 'backend:target' ? target : source)
    const history = vi.spyOn(storageRegistry, 'copyPageHistory').mockResolvedValue(undefined)
    const assets = vi.spyOn(storageRegistry, 'copyPageAssets').mockResolvedValue(undefined)

    const moved = await storageRegistry.transferPageCrossAdapter(page, 'backend:target')
    expect(moved.storageSourceId).toBe('backend:target')
    expect(remove).toHaveBeenCalledWith('local:source', [page])
    expect(remove.mock.invocationCallOrder[0]).toBeGreaterThan(history.mock.invocationCallOrder[0]!)
    expect(remove.mock.invocationCallOrder[0]).toBeGreaterThan(assets.mock.invocationCallOrder[0]!)
  })

  it('keeps the destination when it was already one of the page bindings', async () => {
    const removeSource = vi.fn().mockResolvedValue(undefined)
    const removeTarget = vi.fn().mockResolvedValue(undefined)
    const source: StorageAdapter = { ...browserStorageAdapter, permanentlyDeletePages: removeSource }
    const target: StorageAdapter = {
      ...browserStorageAdapter,
      savePage: vi.fn().mockImplementation(async (draft: Page) => draft),
      permanentlyDeletePages: removeTarget,
    }
    vi.spyOn(storageRegistry, 'resolve').mockImplementation((id) => id === 'backend:target' ? target : source)
    vi.spyOn(storageRegistry, 'copyPageHistory').mockResolvedValue(undefined)
    vi.spyOn(storageRegistry, 'copyPageAssets').mockResolvedValue(undefined)

    await storageRegistry.transferPageCrossAdapter({ ...page, storageSourceIds: ['local:source', 'backend:target'] }, 'backend:target')
    expect(removeSource).toHaveBeenCalledOnce()
    expect(removeTarget).not.toHaveBeenCalled()
  })
})
