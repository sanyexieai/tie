import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { workspaceService } from '@/services/workspace'
import { captureStartupPages } from '@/services/startup-pages'
import { s3ProviderIdFromEndpointBucket } from '@/services/storage-identity'
import { useWorkspaceStore } from './workspace'
import type { Page, WorkspaceSnapshot } from '@/types'

const native = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function page(id: string): Page {
  return { id, title: id, markdown: `# ${id}\n\nlocal body`, icon: '', tags: [], parentId: null, sortKey: 0,
    storageSourceId: 'local:a', storageSourceIds: ['local:a'],
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', deletedAt: null }
}

function snapshot(): WorkspaceSnapshot {
  return { workspace: { id: 'local', name: 'Local', sources: [{ id: 'local:a', name: 'A', path: '/tmp/a', kind: 'local' }] }, pages: [page('first'), page('second')] }
}

beforeEach(() => {
  setActivePinia(createPinia())
  const values = new Map<string, string>([['tie.workspace.migrations.applied', JSON.stringify(['href-file-protocol-v1'])]])
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  })
  vi.stubGlobal('window', Object.assign(new EventTarget(), { __TAURI_INTERNALS__: {} }))
  native.invoke.mockReset()
  native.invoke.mockImplementation(async (command: string) => {
    if (command === 'load_s3_provider_metadata' || command === 'load_s3_providers') return []
    if (command === 'backend_sync_cursor') return {}
    throw new Error(`unexpected command: ${command}`)
  })
  vi.spyOn(workspaceService, 'loadLocal').mockResolvedValue(snapshot())
  vi.spyOn(workspaceService, 'loadPreferences').mockReturnValue({ favoritePageIds: ['first'], recentPageIds: ['second'], collapsedPageIds: ['first'], spellcheckEnabled: true, sourceMode: false, skillsSectionCollapsed: true, storageSourceOrder: ['local:a'] })
  vi.spyOn(workspaceService, 'savePreferences').mockImplementation(() => {})
  vi.spyOn(workspaceService, 'flushSyncQueue').mockResolvedValue([])
})

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('shows local pages and preferences before starting credentials or remote work', async () => {
  const credentials = deferred<never[]>()
  native.invoke.mockImplementation((command: string) => command === 'load_s3_provider_metadata' ? Promise.resolve([]) : credentials.promise)
  const remote = vi.spyOn(workspaceService, 'loadWithSync')
  const store = useWorkspaceStore()
  await store.initialize()
  expect(store.initialized).toBe(true)
  expect(store.backgroundStarted).toBe(false)
  expect(store.pages.map((item) => item.id)).toEqual(['first', 'second'])
  expect(store.activePageId).toBe('second')
  expect(store.favoritePageIds).toEqual(['first'])
  expect(native.invoke.mock.calls).toEqual([['load_s3_provider_metadata']])
  expect(remote).not.toHaveBeenCalled()
  const work = store.initializeBackground()
  expect(store.backgroundStarted).toBe(true)
  await vi.waitFor(() => expect(native.invoke).toHaveBeenCalledWith('load_s3_providers'))
  expect(store.activePageId).toBe('second')
  // The credentials request deliberately remains pending while the local workspace is usable.
  void work
})

it('keeps legacy S3 page bindings from public metadata while credential migration is pending', async () => {
  const rawId = 'f47d9552-5349-4752-9152-f94302db5518'
  const endpoint = 'https://storage.example.invalid'
  const stable = `s3:${s3ProviderIdFromEndpointBucket(endpoint, 'notes')}`
  const credentials = deferred<never[]>()
  native.invoke.mockImplementation((command: string) => command === 'load_s3_provider_metadata'
    ? Promise.resolve([{ id: rawId, name: 'Legacy', endpoint, bucket: 'notes', credentialStored: true, createdAt: '' }])
    : credentials.promise)
  const source = snapshot()
  source.pages[0] = { ...source.pages[0]!, storageSourceId: `s3:${rawId}`, storageSourceIds: ['local:a', `s3:${rawId}`] }
  vi.mocked(workspaceService.loadLocal).mockResolvedValue(source)
  const store = useWorkspaceStore()
  await store.initialize()
  expect(store.pages[0]?.storageSourceId).toBe(stable)
  expect(store.pages[0]?.storageSourceIds).toEqual(expect.arrayContaining(['local:a', stable]))
  expect(store.allSources.map((item) => item.id)).toContain(stable)
  expect(native.invoke.mock.calls).toEqual([['load_s3_provider_metadata']])
  void store.initializeBackground()
  await vi.waitFor(() => expect(native.invoke).toHaveBeenCalledWith('load_s3_providers'))
  expect(store.pages[0]?.storageSourceIds).toEqual(expect.arrayContaining(['local:a', stable]))
})

it.each(['startup', 'reload'])('preserves live edits, selection and new workspace configuration during %s loading', async (phase) => {
  const incoming = deferred<{ snapshot: WorkspaceSnapshot; syncResults: [] }>()
  const load = vi.spyOn(workspaceService, 'loadWithSync').mockReturnValue(incoming.promise)
  const store = useWorkspaceStore()
  await store.initialize()
  const work = phase === 'startup' ? store.initializeBackground() : store.reloadWorkspace()
  await vi.waitFor(() => expect(load).toHaveBeenCalledOnce())
  store.pages[0]!.markdown = 'typed while loading'
  store.pages[0]!.tags.push('edited')
  store.pages = store.pages.filter((item) => item.id !== 'second')
  store.pages.push({ ...page('new local'), storageSourceId: 'local:b', storageSourceIds: ['local:b'] })
  store.workspace = { ...store.workspace!, name: 'Renamed by user', sources: [...store.workspace!.sources, { id: 'local:b', name: 'B', path: '/tmp/b', kind: 'local' }] }
  store.activePageId = 'new local'
  store.favoritePageIds = ['new local']
  const stale = snapshot()
  stale.pages.forEach((item) => { item.updatedAt = '2027-01-01T00:00:00Z' })
  stale.pages.push(page('new remote'))
  incoming.resolve({ snapshot: stale, syncResults: [] })
  await work
  expect(store.pages.find((item) => item.id === 'first')).toMatchObject({ markdown: 'typed while loading', tags: ['edited'] })
  expect(store.pages.some((item) => item.id === 'second')).toBe(false)
  expect(store.pages.find((item) => item.id === 'new local')?.storageSourceId).toBe('local:b')
  expect(store.pages.some((item) => item.id === 'new remote')).toBe(true)
  expect(store.activePageId).toBe('new local')
  expect(store.favoritePageIds).toEqual(['new local'])
  expect(store.workspace?.name).toBe('Renamed by user')
  expect(store.workspace?.sources.map((source) => source.id)).toEqual(['local:a', 'local:b'])
})

it('does not let a queued startup migration overwrite a save that completed while it waited', async () => {
  const store = useWorkspaceStore()
  await store.initialize()
  const original = captureStartupPages(store.pages)[0]!
  const saved = deferred<Page>()
  vi.spyOn(workspaceService, 'readLatestPage').mockResolvedValue(original)
  const write = vi.spyOn(workspaceService, 'savePage').mockReturnValue(saved.promise)
  const userEdit = store.persist({ ...original, markdown: 'user edit' }, { sync: false })
  await vi.waitFor(() => expect(write).toHaveBeenCalledOnce())
  const migration = store.persist({ ...original, markdown: 'old migration result' }, { sync: false, onlyIfUnchanged: original })
  saved.resolve({ ...original, markdown: 'user edit', updatedAt: '2026-01-02T00:00:00Z' })
  await userEdit
  await migration
  expect(write).toHaveBeenCalledOnce()
  expect(store.pages[0]?.markdown).toBe('user edit')
})
