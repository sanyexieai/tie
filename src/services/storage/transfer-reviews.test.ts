import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useBackendStore } from '@/stores/backend'
import { backendService } from '@/services/backend'
import { storageRegistry } from './registry'
import { listPageReviews, reviewState, type ReviewEntry } from '@/services/review-service'
import { encryptMarkdown, importEncryptionPassword } from '@/services/encrypted-markdown'
import { clearProtectedPages, unlockProtectedPage } from '@/services/protected-pages'
import { protectReviewEntries } from '@/services/protected-review-format'
import type { Page } from '@/types'

const native = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }))
const localId = 'src_local_review_move'
const remoteId = 'backend:ws_move'
const remotePath = '/api/v1/workspaces/ws_move/pages'
const origin = { clientId: 'agent-codex', clientName: 'Codex', clientVersion: 'test', deviceId: 'dev_source', deviceName: 'Source device', platform: 'linux', actor: 'Codex' }
const entries: ReviewEntry[] = [
  { id: 'ch_original', at: '2026-01-02T00:00:00Z', actor: 'Codex', origin, kind: 'change', status: 'recorded', type: 'update', changedFields: ['markdown'] },
  { id: 'ph_original', at: '2026-01-02T00:00:00Z', actor: 'Codex', origin, kind: 'opinion', status: 'withdrawn', opinionKind: 'objection', quote: 'Moving', body: 'Superseded', baseUpdatedAt: '2026-01-02T00:00:00Z', resolutionOrigin: origin, resolutionNote: 'Withdrawn on another device', updatedAt: '2026-01-03T00:00:00Z' },
]
const original: Page = { id: 'pg_move_reviews', title: 'Moving', markdown: '# Moving\n', icon: '', tags: [], parentId: null, sortKey: 0,
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z', deletedAt: null,
  storageSourceId: localId, storageSourceIds: [localId] }

beforeEach(() => {
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) })
  vi.stubGlobal('window', Object.assign(new EventTarget(), { __TAURI_INTERNALS__: {} }))
  setActivePinia(createPinia())
  const profile = { endpoint: 'https://move.example.test', accessToken: 'fixture-session', refreshToken: null, accessExpiresAt: null,
    user: { id: 'usr_move', name: 'Mover', email: 'mover@example.test', createdAt: '' } }
  useBackendStore().profile = profile
  native.invoke.mockReset()
  Object.keys(reviewState.byPage).forEach((key) => delete reviewState.byPage[key])
})
afterEach(() => { clearProtectedPages(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('real file/backend adapters preserve reviews on transfer', () => {
  it.each([
    { toRemote: true, mergeFails: false }, { toRemote: false, mergeFails: false },
    { toRemote: true, mergeFails: true }, { toRemote: false, mergeFails: true },
  ])('$toRemote remote destination / merge failure $mergeFails', async ({ toRemote, mergeFails }) => {
    const sourceId = toRemote ? localId : remoteId
    const targetId = toRemote ? remoteId : localId
    const page = { ...original, storageSourceId: sourceId, storageSourceIds: [sourceId] }
    const actions: string[] = []
    let merged: ReviewEntry[] | undefined
    let removed = false
    native.invoke.mockImplementation(async (command: string, args?: { page?: Page; entries?: ReviewEntry[] }) => {
      if (command === 'get_change_origin') return origin
      if (command === 'list_page_reviews') { actions.push('read'); return { entries } }
      if (command === 'list_file_page_assets') { actions.push('assets'); return [] }
      if (command === 'save_page') { actions.push('save'); return args!.page }
      if (command === 'merge_page_reviews') {
        actions.push('merge')
        if (mergeFails) throw new Error('Review merge failed')
        merged = args!.entries
        return { entries: args!.entries }
      }
      if (command === 'permanently_delete_pages') { actions.push('delete'); removed = true; return null }
      throw new Error(`Unexpected native command ${command}`)
    })
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input))
      const method = init?.method || 'GET'
      if (url.pathname === `${remotePath}/${page.id}/reviews`) {
        if (method === 'GET') { actions.push('read'); return Response.json({ entries }) }
        if (method === 'PUT') {
          actions.push('merge')
          if (mergeFails) return Response.json({ message: 'Review merge failed' }, { status: 500 })
          merged = JSON.parse(String(init?.body)).entries
          return Response.json({ entries: merged })
        }
      }
      if (url.pathname === `${remotePath}/${page.id}/assets`) { actions.push('assets'); return Response.json({ assets: [] }) }
      if (url.pathname === `${remotePath}/${page.id}` && method === 'PUT') { actions.push('save'); return Response.json(JSON.parse(String(init?.body))) }
      if (url.pathname === remotePath && method === 'POST') { actions.push('delete'); removed = true; return new Response(null, { status: 204 }) }
      throw new Error(`Unexpected HTTP request ${method} ${url.pathname}`)
    }))

    const move = storageRegistry.transferPage(page, targetId)
    if (mergeFails) {
      await expect(move).rejects.toThrow('Review merge failed')
      expect(removed).toBe(false)
      expect(actions).toEqual(['read', 'save', 'assets', 'merge'])
    } else {
      const moved = await move
      expect(moved).toMatchObject({ id: page.id, storageSourceId: targetId, storageSourceIds: [targetId] })
      expect(merged).toEqual(entries)
      expect(merged?.[1]).toMatchObject({ status: 'withdrawn', origin, resolutionOrigin: origin })
      expect(removed).toBe(true)
      expect(actions).toEqual(['read', 'save', 'assets', 'merge', 'delete'])
    }
  })

  it('rejects a direct S3 destination before saving or deleting when the page has shared reviews', async () => {
    native.invoke.mockImplementation(async (command: string) => {
      if (command === 'list_page_reviews') return { entries }
      throw new Error(`Unexpected native command ${command}`)
    })
    await expect(storageRegistry.transferPage(original, 's3:unsupported_reviews')).rejects.toThrow('目标存储源不支持共享变更与讨论')
    expect(native.invoke.mock.calls.map(([command]) => command)).toEqual(['list_page_reviews'])
  })

  it.each([
    { toRemote: true, unlocked: false }, { toRemote: false, unlocked: false },
    { toRemote: true, unlocked: true }, { toRemote: false, unlocked: true },
  ])('copies protected review ciphertext byte-for-byte toRemote=$toRemote unlocked=$unlocked', async ({ toRemote, unlocked }) => {
    const key = await importEncryptionPassword('fixture-protected-transfer-password')
    const sourceId = toRemote ? localId : remoteId
    const targetId = toRemote ? remoteId : localId
    const page = { ...original, storageSourceId: sourceId, storageSourceIds: [sourceId], markdown: await encryptMarkdown('# Moving\n\nfixture-private-page', key) }
    // No metadata-only change entry: a redacted UI list would silently lose all records.
    const raw = await protectReviewEntries([
      { ...entries[1]!, quote: 'fixture-private-quote', body: 'fixture-private-body', resolutionNote: 'fixture-private-resolution' },
      { id: 'v_private', at: '', actor: 'Owner', kind: 'version', status: 'open', markdown: 'fixture-private-version' },
    ], key)
    let merged: ReviewEntry[] | undefined
    let saved: Page | undefined
    const actions: string[] = []
    native.invoke.mockImplementation(async (command: string, args?: { page?: Page; entries?: ReviewEntry[] }) => {
      if (command === 'get_change_origin') return origin
      if (command === 'list_page_reviews') return { entries: raw }
      if (command === 'list_file_page_assets') return []
      if (command === 'save_page') { saved = args!.page; actions.push('save'); return saved }
      if (command === 'merge_page_reviews') { merged = args!.entries; actions.push('merge'); return { entries: merged } }
      if (command === 'permanently_delete_pages') { actions.push('delete'); return null }
      throw new Error(`Unexpected native command ${command}`)
    })
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input))
      const method = init?.method || 'GET'
      if (url.pathname.endsWith('/reviews')) {
        if (method === 'PUT') { merged = JSON.parse(String(init?.body)).entries; actions.push('merge') }
        return Response.json({ entries: raw })
      }
      if (url.pathname.endsWith('/assets')) return Response.json({ assets: [] })
      if (method === 'PUT') { saved = JSON.parse(String(init?.body)); actions.push('save'); return Response.json(saved) }
      if (method === 'POST') { actions.push('delete'); return new Response(null, { status: 204 }) }
      throw new Error(`Unexpected HTTP request ${method} ${url.pathname}`)
    }))
    if (unlocked) await unlockProtectedPage(page, key)
    const view = await listPageReviews(page)
    expect(view.entries).toEqual(unlocked ? expect.arrayContaining([expect.objectContaining({ body: 'fixture-private-body' })]) : [])
    await storageRegistry.transferPage(page, targetId)
    expect(merged).toEqual(raw)
    expect(saved?.markdown).toBe(page.markdown)
    expect(actions).toEqual(['save', 'merge', 'delete'])
    expect(JSON.stringify({ merged, saved })).not.toContain('fixture-private-')
  })

  it('rejects old plaintext protected reviews before creating or deleting a transfer destination', async () => {
    const key = await importEncryptionPassword('fixture-protected-transfer-password')
    const page = { ...original, markdown: await encryptMarkdown('private page', key) }
    native.invoke.mockImplementation(async (command: string) => {
      if (command === 'list_page_reviews') return { entries }
      throw new Error(`Unexpected native command ${command}`)
    })
    await expect(storageRegistry.transferPage(page, remoteId)).rejects.toThrow('意见格式无效')
    expect(native.invoke.mock.calls.map(([command]) => command)).toEqual(['list_page_reviews'])
  })

  it('copies nonempty protected reviews through backend adapters before a Pinia store exists', async () => {
    vi.stubGlobal('window', new EventTarget())
    const profile = useBackendStore().profile
    backendService.saveProfile(profile)
    setActivePinia(undefined)
    const key = await importEncryptionPassword('fixture-protected-transfer-password')
    const page = { ...original, storageSourceId: remoteId, storageSourceIds: [remoteId], markdown: await encryptMarkdown('fixture-prestore-page', key) }
    const raw = await protectReviewEntries([{ ...entries[1]!, body: 'fixture-prestore-body', quote: 'fixture-prestore-quote' }], key)
    const actions: string[] = []
    let merged: ReviewEntry[] | undefined
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input))
      const method = init?.method || 'GET'
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${profile.accessToken}`)
      if (url.pathname.endsWith('/reviews')) {
        if (method === 'PUT') { merged = JSON.parse(String(init?.body)).entries; actions.push('merge') }
        else actions.push('read')
        return Response.json({ entries: raw })
      }
      if (url.pathname.endsWith('/assets')) return Response.json({ assets: [] })
      if (method === 'PUT') { actions.push('save'); return Response.json(JSON.parse(String(init?.body))) }
      if (method === 'POST') { actions.push('delete'); return new Response(null, { status: 204 }) }
      throw new Error(`Unexpected HTTP request ${method} ${url.pathname}`)
    }))
    const moved = await storageRegistry.transferPageCrossAdapter(page, 'backend:ws_target')
    expect(moved.markdown).toBe(page.markdown)
    expect(merged).toEqual(raw)
    expect(actions).toEqual(['read', 'save', 'merge', 'delete'])
    expect(JSON.stringify(merged)).not.toContain('fixture-prestore-')
    expect(native.invoke).not.toHaveBeenCalled()
  })
})
