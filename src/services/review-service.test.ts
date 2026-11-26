import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { Page } from '@/types'
import { backendService } from './backend'
import { useBackendStore } from '@/stores/backend'
import { addPageOpinion, listPageReviews, resolvePageOpinion, reviewOriginLabel, reviewState, reviewsForPage, type ReviewEntry } from './review-service'
import { loadPheromones, pheromoneState, pheromonesFor } from './pheromone'

const native = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }))
const page: Page = {
  id: 'pg_signals', title: 'Shared review', markdown: '# Shared review\n\nOriginal passage.', icon: '', tags: [],
  parentId: null, sortKey: 0, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z',
  deletedAt: null, storageSourceId: 'backend:ws_signals', storageSourceIds: ['backend:ws_signals'],
}
const opinion: ReviewEntry = { id: 'ph_shared', at: '2026-01-02T00:00:00Z', actor: 'Codex', kind: 'opinion', status: 'open',
  opinionKind: 'correction', quote: 'Original passage.', body: 'Please clarify.', baseUpdatedAt: page.updatedAt,
}
const path = '/api/v1/workspaces/ws_signals/pages/pg_signals'

beforeEach(() => {
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: (key: string) => { values.delete(key) } })
  vi.stubGlobal('window', new EventTarget())
  setActivePinia(createPinia())
  backendService.saveProfile({ endpoint: 'https://review.example.test', accessToken: 'fixture-session', refreshToken: null,
    accessExpiresAt: null, user: { id: 'usr_fixture', name: 'Owner', email: 'owner@example.test', createdAt: '' } })
  Object.keys(reviewState.byPage).forEach((key) => delete reviewState.byPage[key])
  pheromoneState.legacyByPage = {}
  native.invoke.mockReset()
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('durable shared reviews', () => {
  it('uses browser review/action endpoints and preserves withdrawal as a durable state', async () => {
    let entries: ReviewEntry[] = []
    const requests: { method: string; path: string; body: Record<string, unknown> }[] = []
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input))
      const body = JSON.parse(String(init?.body || '{}'))
      requests.push({ method: init?.method || 'GET', path: url.pathname, body })
      if (url.pathname === path + '/signals') {
        entries = [{ ...opinion, ...body, actor: 'Codex' }]
      } else if (url.pathname === path + '/signals/ph_shared/resolve') {
        entries = entries.map((entry) => ({ ...entry, status: body.status, resolutionNote: body.resolutionNote }))
      } else if (url.pathname !== path + '/reviews') throw new Error('Unexpected request')
      return Response.json({ entries })
    }))
    await addPageOpinion(page, { id: opinion.id, actor: 'Codex', opinionKind: 'correction', quote: opinion.quote!, body: opinion.body!, baseUpdatedAt: page.updatedAt })
    expect(requests[0]).toMatchObject({ method: 'POST', path: path + '/signals', body: { actor: 'Codex', baseUpdatedAt: page.updatedAt } })
    expect(native.invoke).not.toHaveBeenCalled()
    await resolvePageOpinion(page, reviewsForPage(page.id, page.storageSourceId)[0]!, 'withdrawn', 'Superseded')
    await listPageReviews(page)
    expect(requests[1]).toMatchObject({ method: 'POST', path: path + '/signals/ph_shared/resolve', body: { status: 'withdrawn', resolutionNote: 'Superseded' } })
    expect(pheromonesFor(page.id, page.storageSourceId)[0]).toMatchObject({ id: opinion.id, status: 'withdrawn', durable: true })
    expect(requests.every((request) => request.method !== 'PUT')).toBe(true)
  })

  it('keeps old local opinions when durable migration fails, and clears only the confirmed copy on retry', async () => {
    const legacy = { id: opinion.id, pageId: page.id, kind: 'correction' as const, actor: 'Old laptop', quote: opinion.quote!, body: opinion.body!, createdAt: opinion.at }
    pheromoneState.legacyByPage = { [page.id]: [legacy] }
    localStorage.setItem('tie.pheromone.v1', JSON.stringify(pheromoneState.legacyByPage))
    let fail = true
    let written: ReviewEntry | undefined
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (_input, init) => {
      if (init?.method === 'PUT') {
        written = JSON.parse(String(init.body)).entries[0]
        if (fail) return Response.json({ message: 'Disk full' }, { status: 503 })
        return Response.json({ entries: [written] })
      }
      return Response.json({ entries: [] })
    }))
    await expect(loadPheromones(page)).rejects.toThrow('Disk full')
    expect(pheromoneState.legacyByPage[page.id]).toHaveLength(1)
    expect(JSON.parse(localStorage.getItem('tie.pheromone.v1')!)[page.id]).toHaveLength(1)
    fail = false
    await loadPheromones(page)
    expect(written).toMatchObject({ actor: 'Old laptop', at: opinion.at, baseUpdatedAt: '' })
    expect(written?.origin).toBeUndefined()
    expect(pheromoneState.legacyByPage[page.id]).toEqual([])
    expect(JSON.parse(localStorage.getItem('tie.pheromone.v1')!)[page.id]).toEqual([])
    expect(pheromonesFor(page.id, page.storageSourceId)).toHaveLength(1)
    expect(reviewOriginLabel(undefined, 'Old laptop')).toContain('设备来源未记录')
  })

  it('does not resurrect a withdrawn shared opinion while importing the same legacy id', async () => {
    pheromoneState.legacyByPage = { [page.id]: [{ id: opinion.id, pageId: page.id, kind: 'correction', actor: 'Old laptop', quote: opinion.quote!, body: opinion.body!, createdAt: opinion.at }] }
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ entries: [{ ...opinion, status: 'withdrawn' }] }))
    vi.stubGlobal('fetch', fetcher)
    await loadPheromones(page)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(pheromonesFor(page.id, page.storageSourceId)).toHaveLength(1)
    expect(pheromonesFor(page.id, page.storageSourceId)[0]?.status).toBe('withdrawn')
    expect(pheromoneState.legacyByPage[page.id]).toEqual([])
  })

  it('requires a changed saved version before adopting an opinion', async () => {
    const requests: { path: string; body?: Record<string, unknown> }[] = []
    let savedAt = page.updatedAt
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input))
      requests.push({ path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined })
      if (url.pathname === path) return Response.json({ ...page, updatedAt: savedAt })
      return Response.json({ entries: [{ ...opinion, status: 'adopted', appliedUpdatedAt: savedAt }] })
    }))
    await expect(resolvePageOpinion({ ...page, markdown: 'Unsaved changes' }, opinion, 'adopted')).rejects.toThrow('修改并保存正文')
    expect(requests).toHaveLength(1)
    await expect(resolvePageOpinion(page, { ...opinion, baseUpdatedAt: '' }, 'adopted')).rejects.toThrow('修改并保存正文')
    expect(requests).toHaveLength(2)
    savedAt = '2026-01-03T00:00:00Z'
    await resolvePageOpinion(page, opinion, 'adopted', 'Clarified and saved')
    expect(requests.at(-1)).toMatchObject({ path: path + '/signals/ph_shared/resolve', body: { status: 'adopted', appliedUpdatedAt: savedAt } })
  })

  it('isolates the in-memory review display when the signed-in account changes', async () => {
    let finish!: (response: Response) => void
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(() => new Promise((resolve) => { finish = resolve })))
    const pending = listPageReviews(page)
    useBackendStore().profile.user!.id = 'usr_another'
    finish(Response.json({ entries: [opinion] }))
    await pending
    expect(reviewsForPage(page.id, page.storageSourceId)).toEqual([])
    useBackendStore().profile.user!.id = 'usr_fixture'
    expect(reviewsForPage(page.id, page.storageSourceId)).toHaveLength(1)
  })

  it('reads temporary desktop changes from memory but rejects persistent shared opinions there', async () => {
    vi.stubGlobal('window', Object.assign(new EventTarget(), { __TAURI_INTERNALS__: {} }))
    const temporary = { ...page, storageSourceId: 'src_temporary_fixture' }
    native.invoke.mockResolvedValue({ entries: [{ ...opinion, kind: 'change', type: 'write' }] })
    await listPageReviews(temporary)
    expect(native.invoke).toHaveBeenCalledWith('list_page_reviews', { sourceId: temporary.storageSourceId, pageId: temporary.id })
    await expect(addPageOpinion(temporary, { opinionKind: 'support', quote: 'Original', body: 'Yes', baseUpdatedAt: temporary.updatedAt })).rejects.toThrow('临时文件不保存共享意见')
  })
})
