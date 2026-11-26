import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { workspaceService } from './workspace'
import { storageRegistry } from './storage/registry'
import { fileStorageAdapter } from './storage/file-adapter'
import { syncQueue } from './storage/sync-queue'
import { syncAfterSave } from './storage/git-sync'
import type { Page } from '@/types'

const native = vi.hoisted(() => ({ invoke: vi.fn(), open: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: native.open, save: vi.fn() }))
const page: Page = { id: 'pg_external', title: 'External', markdown: '[file](tie://path/docs/readme.md)', icon: '', tags: [], parentId: null, sortKey: 0,
  storageSourceId: 'src_temporary_external', storageSourceIds: ['src_temporary_external'], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', deletedAt: null }
const snapshot = { workspace: { id: 'local', name: 'Test', sources: [] }, pages: [page] }

beforeEach(() => {
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) })
  vi.stubGlobal('window', Object.assign(new EventTarget(), { __TAURI_INTERNALS__: {} }))
  native.invoke.mockReset()
  native.open.mockReset()
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('uses supplied OS file paths directly and sends file-dialog paths through the same native open command', async () => {
  native.invoke.mockResolvedValue({ snapshot, openedPageIds: [page.id], createdSourceIds: [page.storageSourceId] })
  await workspaceService.openMarkdownFiles(['/tmp/OS.md'])
  expect(native.open).not.toHaveBeenCalled()
  native.open.mockResolvedValue(['/tmp/dialog.md'])
  await workspaceService.openMarkdownFiles()
  expect(native.open).toHaveBeenCalledOnce()
  expect(native.invoke.mock.calls.map(([, args]) => args.paths)).toEqual([['/tmp/OS.md'], ['/tmp/dialog.md']])
})

it('preserves raw links on temporary writes and never persists a retry after the original file becomes unavailable', async () => {
  native.invoke.mockImplementation(async (command: string, args: { page?: Page }) => {
    if (command === 'load_workspace') return snapshot
    if (command === 'save_page') return args.page
    throw new Error(`unexpected command: ${command}`)
  })
  const saved = await storageRegistry.savePage({ ...page, markdown: page.markdown + '\nChanged' })
  expect(saved.markdown).toBe(page.markdown + '\nChanged')
  expect(native.invoke).toHaveBeenCalledWith('save_page', expect.objectContaining({ page: expect.objectContaining({ markdown: saved.markdown }) }))
  native.invoke.mockRejectedValue(new Error('Permission denied'))
  await expect(fileStorageAdapter.savePage(page, { queueOnFailure: true })).rejects.toThrow('Permission denied')
  expect(syncQueue.list()).toEqual([])
})

it('reloads temporary files without Git or conflict writebacks', async () => {
  native.invoke.mockImplementation(async (command: string) => {
    if (command === 'load_workspace') return snapshot
    throw new Error(`unexpected command: ${command}`)
  })
  const result = await storageRegistry.syncSource(page.storageSourceId, [{ ...page, markdown: 'Unsaved newer draft', updatedAt: '2027-01-01T00:00:00Z' }])
  expect(result.pages).toEqual([page])
  expect(result.conflicts).toEqual([])
  expect(await syncAfterSave(page.storageSourceId)).toBeNull()
  expect(native.invoke.mock.calls.map(([command]) => command)).toEqual(['load_workspace'])
})
