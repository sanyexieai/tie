import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useBackendStore } from './backend'
import { useCredentialsStore } from './credentials'
import { useWorkspaceStore } from './workspace'

beforeEach(() => {
  const storage = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) })
  vi.stubGlobal('window', new EventTarget())
  setActivePinia(createPinia())
  const backend = useBackendStore()
  backend.profile = { endpoint: 'https://credentials.example.test', accessToken: 'test-session', refreshToken: null,
    accessExpiresAt: null, user: { id: 'owner_a', name: 'Owner A', email: 'a@example.test', createdAt: '' } }
  backend.workspaces = [{ id: 'ws_a', ownerId: 'owner_a', name: 'A', createdAt: '', default: true },
    { id: 'ws_b', ownerId: 'owner_a', name: 'B', createdAt: '' }]
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('loads credential metadata on demand, keeps the selected workspace, and searches server metadata', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => Response.json([]))
  vi.stubGlobal('fetch', fetcher)
  const credentials = useCredentialsStore()
  expect(fetcher).not.toHaveBeenCalled()
  credentials.open(null, 'ws_b')
  await credentials.refresh()
  expect(String(fetcher.mock.calls[0]![0])).toContain('workspaceId=ws_b')
  credentials.open()
  expect(credentials.workspaceId).toBe('ws_b')
  credentials.query = 'production'
  await credentials.refresh()
  expect(String(fetcher.mock.calls.at(-1)![0])).toContain('query=production')
})

it('discards delayed metadata and old workspace choices after changing accounts', async () => {
  let finish!: (response: Response) => void
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(() => new Promise((resolve) => { finish = resolve })))
  const credentials = useCredentialsStore()
  credentials.open(null, 'ws_a')
  const pending = credentials.refresh()
  const backend = useBackendStore()
  backend.profile.user = { id: 'owner_b', name: 'Owner B', email: 'b@example.test', createdAt: '' }
  expect(credentials.ensureWorkspace()).toBe('')
  expect(credentials.workspaces).toEqual([])
  finish(Response.json([{ id: 'sec_old', workspaceId: 'ws_a', name: 'Old account metadata' }]))
  await pending
  expect(credentials.entries).toEqual([])
  expect(credentials.activeCredentialId).toBeNull()
})

it('flushes the document before opening a credential and keeps credentials outside normal pages', async () => {
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => Response.json([])))
  const store = useWorkspaceStore()
  const page = { id: 'pg_local', title: 'Ordinary page', markdown: '# Ordinary page', icon: '', parentId: null,
    tags: [], sortKey: 0, createdAt: '', updatedAt: '', deletedAt: null, storageSourceId: 'src_local_fixture' }
  store.pages = [page]
  store.activePageId = page.id
  const flush = vi.fn(async () => false)
  const unregister = store.registerEditorSaveHandler(flush)
  expect(await store.openCredentialPage()).toBe(false)
  expect(store.showingCredentials).toBe(false)
  expect(flush).toHaveBeenCalledOnce()
  unregister()
  expect(await store.openCredentialPage()).toBe(true)
  expect(store.showingCredentials).toBe(true)
  expect(store.pages).toEqual([page])
  store.openPage(page.id)
  expect(store.showingCredentials).toBe(false)
})
