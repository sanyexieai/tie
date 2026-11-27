import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { createPinia, setActivePinia } from 'pinia'
import { loadBackendDocumentSnapshot } from '@/services/browser-backend'
import { backendService, type BackendProfile } from '@/services/backend'
import { rememberedBrowserManifest, type BackendSyncManifest } from '@/services/backend-sync'
import { workspaceService } from '@/services/workspace'
import { useBackendStore } from './backend'
import { useWorkspaceStore } from './workspace'
import type { Page } from '@/types'
import { cachedFileResource, listRegisteredFiles, resolveRegisteredFile } from '@/services/files'
import type { WorkspaceFileResource } from '@/services/files'

let server: Server
let profile: BackendProfile
let remote: Map<string, Page>
let manifest: BackendSyncManifest
let requests: string[]
let manifestMissing: boolean
let missingBody: boolean
let releaseBody: (() => void) | undefined
let bodyRequested: (() => void) | undefined
let bodyGate: Promise<void> | undefined
let files: Map<string, WorkspaceFileResource>

const sourceId = 'backend:ws_incremental'
function page(id: string, markdown: string): Page {
  return { id, title: id, markdown, icon: '', tags: [], parentId: null, sortKey: 0, storageSourceId: sourceId, storageSourceIds: [sourceId],
    createdAt: '2026-11-27T00:00:00Z', updatedAt: '2026-11-27T00:00:00Z', deletedAt: null }
}

beforeEach(async () => {
  vi.restoreAllMocks()
  setActivePinia(createPinia())
  const storage = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) })
  vi.stubGlobal('window', Object.assign(new EventTarget(), { setTimeout: vi.fn(() => 1), clearTimeout: vi.fn() }))
  vi.stubGlobal('navigator', { onLine: true })
  vi.spyOn(workspaceService, 'savePreferences').mockImplementation(() => {})
  remote = new Map([['pg_a', page('pg_a', 'first body')], ['pg_b', page('pg_b', 'unrelated body')]])
  files = new Map(['file_a', 'file_b'].map((id) => [id, { id, title: id, kind: 'file', mode: 'copy', ext: 'txt', mime: 'text/plain', size: 4,
    sourcePath: '', storedPath: `.tie/files/${id}/sample.txt`, openPath: '', exists: true, updatedAt: '' }]))
  manifest = { version: 1, revision: 'first', pages: [{ id: 'pg_a', version: 'a1' }, { id: 'pg_b', version: 'b1' }], reviews: [], assets: [], files: [] }
  requests = []
  manifestMissing = false; missingBody = false; bodyGate = undefined; bodyRequested = undefined; releaseBody = undefined
  server = createServer(async (request, response) => {
    const url = new URL(request.url!, 'http://fixture')
    requests.push(url.pathname)
    const send = (status: number, body?: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(body === undefined ? undefined : JSON.stringify(body))
    }
    if (url.pathname === '/api/v1/workspaces') return send(200, [{ id: 'ws_incremental', name: 'Test', default: true, ownerId: 'user_test', createdAt: '' }])
    if (url.pathname.endsWith('/sync/manifest')) {
      if (manifestMissing) return send(404, { message: 'unknown endpoint' })
      return url.searchParams.get('revision') === manifest.revision ? send(304) : send(200, manifest)
    }
    if (url.pathname.endsWith('/pages')) return send(200, [...remote.values()])
    if (url.pathname.endsWith('/files')) return send(200, { files: [...files.values()] })
    const id = url.pathname.split('/').at(-1)!
    if (url.pathname.includes('/files/')) return files.has(id) ? send(200, files.get(id)) : send(404, { message: 'file missing' })
    if (id === 'pg_a' && bodyGate) { bodyRequested?.(); await bodyGate }
    const value = remote.get(id)
    return value && !missingBody ? send(200, value) : send(404, { message: 'page missing during read' })
  }).listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Fixture server did not bind')
  profile = { endpoint: `http://127.0.0.1:${address.port}`, accessToken: 'fixture-access', refreshToken: null, accessExpiresAt: null,
    user: { id: 'user_test', name: 'Test', email: 'test@example.test', createdAt: '' } }
  useBackendStore().profile = profile
})

afterEach(async () => {
  releaseBody?.()
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  vi.restoreAllMocks(); vi.unstubAllGlobals()
})

async function open() {
  const snapshot = await loadBackendDocumentSnapshot(profile)
  const store = useWorkspaceStore()
  store.workspace = snapshot.workspace
  store.pages = snapshot.pages
  store.activePageId = snapshot.pages[0]!.id
  requests = []
  return store
}

describe('browser incremental synchronization over real HTTP', () => {
  it('uses a 304 check when idle, fetches only changed page bodies, and applies deletion without a full reload', async () => {
    const store = await open()
    await store.syncBackendNow({ quiet: true })
    expect(requests.filter((path) => path.includes('/pages'))).toEqual([])
    expect(store.backendSyncLastCompletedAt).toBeNull()
    requests = []
    remote.set('pg_a', { ...remote.get('pg_a')!, markdown: 'changed body', updatedAt: '2026-11-27T00:00:01Z' })
    manifest = { ...manifest, revision: 'second', pages: [{ id: 'pg_a', version: 'a2' }, { id: 'pg_b', version: 'b1' }] }
    await store.syncBackendNow({ quiet: true })
    expect(requests.filter((path) => path.includes('/pages'))).toEqual(['/api/v1/workspaces/ws_incremental/pages/pg_a'])
    expect(store.pages.find((item) => item.id === 'pg_a')?.markdown).toBe('changed body')
    expect(store.pages.find((item) => item.id === 'pg_b')?.markdown).toBe('unrelated body')
    requests = []
    remote.delete('pg_b')
    manifest = { ...manifest, revision: 'third', pages: [{ id: 'pg_a', version: 'a2' }] }
    await store.syncBackendNow({ quiet: true })
    expect(store.pages.map((item) => item.id)).toEqual(['pg_a'])
    expect(requests.filter((path) => path.includes('/pages'))).toEqual([])
  })

  it('retains newer saves made while a changed page response is in flight', async () => {
    const store = await open()
    remote.set('pg_a', { ...remote.get('pg_a')!, markdown: 'remote edit' })
    manifest = { ...manifest, revision: 'second', pages: [{ id: 'pg_a', version: 'a2' }, { id: 'pg_b', version: 'b1' }] }
    bodyGate = new Promise<void>((resolve) => { releaseBody = resolve })
    const requested = new Promise<void>((resolve) => { bodyRequested = resolve })
    const flight = store.syncBackendNow({ quiet: true })
    await requested
    store.pages = store.pages.map((item) => item.id === 'pg_a' ? { ...item, markdown: 'newer saved value', updatedAt: '2026-11-27T00:00:02Z' } : item)
    releaseBody!()
    await flight
    expect(store.pages.find((item) => item.id === 'pg_a')?.markdown).toBe('newer saved value')
  })

  it('invalidates only changed resource metadata and notifies assets without reading page bodies', async () => {
    manifest = { ...manifest, files: [{ id: 'file_a', version: 'f1' }, { id: 'file_b', version: 'f1' }], assets: [{ id: 'pg_a', version: 'asset1' }] }
    const store = await open()
    const source = store.allSources.find((item) => item.id === sourceId)!
    await listRegisteredFiles(source)
    expect(cachedFileResource(sourceId, 'file_a')?.title).toBe('file_a')
    const resourceEvents = vi.fn()
    window.addEventListener('tie:resources-synced', resourceEvents)
    requests = []
    files.set('file_a', { ...files.get('file_a')!, title: 'new resource title' })
    manifest = { ...manifest, revision: 'resource-change', files: [{ id: 'file_a', version: 'f2' }, { id: 'file_b', version: 'f1' }], assets: [{ id: 'pg_a', version: 'asset2' }] }
    await store.syncBackendNow({ quiet: true })
    expect(cachedFileResource(sourceId, 'file_a')).toBeNull()
    expect(cachedFileResource(sourceId, 'file_b')?.title).toBe('file_b')
    expect(resourceEvents).toHaveBeenCalledOnce()
    expect((resourceEvents.mock.calls[0]![0] as CustomEvent).detail).toEqual({ sourceId, assetPageIds: ['pg_a'], fileIds: ['file_a'] })
    expect(requests.filter((path) => path.includes('/pages') || path.includes('/files'))).toEqual([])
    expect((await resolveRegisteredFile(source, 'file_a'))?.title).toBe('new resource title')
    expect(requests.filter((path) => path.includes('/files'))).toEqual(['/api/v1/workspaces/ws_incremental/files/file_a'])
  })

  it('keeps version cursors and bodies during a protection dialog, including an explicit full view reload', async () => {
    const store = await open()
    const release = store.holdPageForProtectionChange('pg_a')
    remote.set('pg_a', { ...remote.get('pg_a')!, markdown: 'new protected body' })
    manifest = { ...manifest, revision: 'second', pages: [{ id: 'pg_a', version: 'a2' }, { id: 'pg_b', version: 'b1' }] }
    await store.syncBackendNow({ quiet: true })
    expect(requests.filter((path) => path.includes('/pages'))).toEqual([])
    await loadBackendDocumentSnapshot(profile)
    expect(rememberedBrowserManifest(profile, 'ws_incremental')?.revision).toBe('first')
    release()
    requests = []
    await store.syncBackendNow({ quiet: true })
    expect(requests.filter((path) => path.includes('/pages'))).toEqual(['/api/v1/workspaces/ws_incremental/pages/pg_a'])
    expect(store.pages.find((item) => item.id === 'pg_a')?.markdown).toBe('new protected body')
  })

  it('distinguishes an unsupported manifest endpoint from a page deleted between manifest and body reads', async () => {
    const store = await open()
    manifestMissing = true
    await expect(store.syncBackendNow({ quiet: true })).rejects.toMatchObject({ status: 404, message: '后台不支持增量同步，请先更新后台' })
    expect(rememberedBrowserManifest(profile, 'ws_incremental')?.revision).toBe('first')
    manifestMissing = false
    missingBody = true
    manifest = { ...manifest, revision: 'second', pages: [{ id: 'pg_a', version: 'a2' }, { id: 'pg_b', version: 'b1' }] }
    await expect(store.syncBackendNow({ quiet: true })).rejects.toMatchObject({ status: 404, message: 'page missing during read' })
    expect(rememberedBrowserManifest(profile, 'ws_incremental')?.revision).toBe('first')
    expect(store.pages.find((item) => item.id === 'pg_a')?.markdown).toBe('first body')
    expect(requests.filter((path) => path.endsWith('/pages'))).toEqual([])
  })
})
