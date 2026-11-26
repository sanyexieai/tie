import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useBackendStore } from '@/stores/backend'
import { storageRegistry } from './registry'
import { reviewState, type ReviewEntry } from '@/services/review-service'
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
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

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
})
