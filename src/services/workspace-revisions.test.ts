import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { workspaceService } from './workspace'
import { backendService } from './backend'
import { LOCAL_S3_PROVIDERS_KEY } from './s3'
import { s3ProviderIdFromEndpointBucket } from './storage-identity'
import { syncQueue } from './storage/sync-queue'
import type { Page } from '@/types'

const native = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }))

const current: Page = {
  id: 'pg_restore', title: 'Current', markdown: '# Current\n\nCurrent content', icon: '', tags: [],
  parentId: null, sortKey: 0, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z',
  deletedAt: null, storageSourceId: 'backend:ws_restore', storageSourceIds: ['backend:ws_restore'],
}
const revision: Page = {
  ...current, title: 'Previous', markdown: '# Previous\n\nEarlier content',
  createdAt: '2025-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
}

beforeEach(() => {
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    removeItem: (key: string) => { values.delete(key) },
  })
  vi.stubGlobal('window', new EventTarget())
  native.invoke.mockReset()
  backendService.saveProfile({
    endpoint: 'https://history.example.test', accessToken: 'fixture-login-session', refreshToken: null,
    accessExpiresAt: null, user: { id: 'usr_fixture', name: 'Fixture', email: 'fixture@example.test', createdAt: '' },
  })
})

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('restore remote page revisions', () => {
  it.each(['backend:ws_restore', 'backend-s3:prv_restore'])('preserves the current revision precondition through the real %s adapter', async (sourceId) => {
    const page = { ...current, storageSourceId: sourceId, storageSourceIds: [sourceId] }
    const route = sourceId.startsWith('backend-s3:') ? '/api/v1/providers/prv_restore/pages/pg_restore' : '/api/v1/workspaces/ws_restore/pages/pg_restore'
    let write: { headers: Headers; page: Page } | undefined
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = new URL(String(input))
      if (url.pathname === route + '/revisions/rev_fixture') return Response.json(revision)
      if (url.pathname === route && (!init?.method || init.method === 'GET')) return Response.json(page)
      if (url.pathname === route && init?.method === 'PUT') {
        write = { headers: new Headers(init.headers), page: JSON.parse(String(init.body)) as Page }
        return Response.json(write.page)
      }
      throw new Error(`Unexpected fixture request ${url.pathname}`)
    })
    vi.stubGlobal('fetch', fetch)

    const saved = await workspaceService.restorePageRevision(page, 'rev_fixture')
    expect(write?.headers.get('if-unmodified-since')).toBe(page.updatedAt)
    expect(write?.page).toMatchObject({ id: page.id, markdown: revision.markdown, createdAt: page.createdAt })
    expect(saved.storageSourceId).toBe(sourceId)
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('does not adopt a newer server timestamp to overwrite another edit during restoration', async () => {
    let precondition: string | null = null
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith('/revisions/rev_fixture')) return Response.json(revision)
      if (init?.method === 'PUT') {
        precondition = new Headers(init.headers).get('if-unmodified-since')
        return Response.json({ message: '页面已在其他设备更新' }, { status: 409 })
      }
      return Response.json({ ...current, markdown: '# Current\n\nOther device edit', updatedAt: '2026-01-03T00:00:00.000Z' })
    }))
    await expect(workspaceService.restorePageRevision(current, 'rev_fixture')).rejects.toThrow('其他设备更新')
    expect(precondition).toBe(current.updatedAt)
    expect(syncQueue.list()).toEqual([])
  })

  it('passes the same current timestamp to native S3 restoration', async () => {
    vi.stubGlobal('window', Object.assign(new EventTarget(), { __TAURI_INTERNALS__: {} }))
    const endpoint = 'https://storage.example.test'
    const bucket = 'fixture-history'
    const id = s3ProviderIdFromEndpointBucket(endpoint, bucket)
    localStorage.setItem(LOCAL_S3_PROVIDERS_KEY, JSON.stringify([
      { id, name: 'Fixture S3', endpoint, bucket, credentialStored: true, createdAt: '' },
    ]))
    const page = { ...current, storageSourceId: `s3:${id}`, storageSourceIds: [`s3:${id}`] }
    native.invoke.mockImplementation(async (command: string, args: { page?: Page }) => {
      if (command === 'read_s3_page_revision') return { ...revision, storageSourceId: page.storageSourceId }
      if (command === 'load_s3_pages_by_ids') return [page]
      if (command === 'save_s3_page') return args.page
      throw new Error(`Unexpected fixture IPC ${command}`)
    })

    const saved = await workspaceService.restorePageRevision(page, 'rev_fixture')
    expect(native.invoke).toHaveBeenCalledWith('save_s3_page', expect.objectContaining({
      expectedUpdatedAt: page.updatedAt,
      page: expect.objectContaining({ id: page.id, markdown: revision.markdown, createdAt: page.createdAt }),
    }))
    expect(saved.storageSourceId).toBe(page.storageSourceId)
  })
})
