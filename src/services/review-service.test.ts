import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { Page } from '@/types'
import { backendService } from './backend'
import { useBackendStore } from '@/stores/backend'
import { useWorkspaceStore } from '@/stores/workspace'
import { addPageOpinion, listPageReviews, mergePageReviews, resolvePageOpinion, reviewOriginLabel, reviewState, reviewsForPage, type ReviewEntry } from './review-service'
import { focusPheromone, loadPheromones, pheromoneState, pheromonesFor, startPheromoneDraft } from './pheromone'
import { decryptMarkdown, encryptMarkdown, importEncryptionPassword, isEncryptedMarkdown } from './encrypted-markdown'
import { clearProtectedPages, lockProtectedPage, unlockProtectedPage } from './protected-pages'

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
  pheromoneState.draft = null
  native.invoke.mockReset()
})
afterEach(() => { clearProtectedPages(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

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
    focusPheromone(opinion.id)
    clearProtectedPages()
    expect(pheromoneState.activeId).toBe(opinion.id)
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

describe('authorized protected review views', () => {
  async function fixture() {
    const key = await importEncryptionPassword('fixture-review-password')
    const stored = { ...page, markdown: await encryptMarkdown('Original passage.', key) }
    const store = useWorkspaceStore()
    store.pages = [stored]
    store.activePageId = stored.id
    await unlockProtectedPage(stored, key)
    return { key, stored, store }
  }

  it('encrypts every write while exposing quotes, replies, processing and versions only in authorized memory', async () => {
    const { stored, key, store } = await fixture()
    const requests: Record<string, unknown>[] = []
    let entries: ReviewEntry[] = []
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input, init) => {
      const body = JSON.parse(String(init?.body || '{}'))
      requests.push(body)
      if (String(input).endsWith('/signals')) entries.push({ ...opinion, ...body })
      else if (String(input).endsWith('/resolve')) entries = entries.map((entry) => entry.id === opinion.id ? { ...entry, ...body } : entry)
      else if (init?.method === 'PUT') entries.push(...body.entries)
      return Response.json({ entries })
    }))
    await addPageOpinion(stored, { id: opinion.id, opinionKind: 'correction', quote: opinion.quote!, body: opinion.body!, baseUpdatedAt: stored.updatedAt })
    await addPageOpinion(stored, { id: 'ph_reply', opinionKind: 'support', quote: opinion.quote!, body: 'fixture-private-reply', baseUpdatedAt: stored.updatedAt, replyTo: opinion.id })
    await resolvePageOpinion(stored, reviewsForPage(stored.id, stored.storageSourceId)[0]!, 'resolved', 'fixture-private-resolution')
    const version: ReviewEntry = { id: 'v_private', at: '', actor: 'Owner', kind: 'version', status: 'open', markdown: 'fixture-private-version' }
    await mergePageReviews(stored, [version])
    expect(requests[0]?.quote).toBe('')
    expect(isEncryptedMarkdown(String(requests[0]?.body))).toBe(true)
    expect(JSON.parse(await decryptMarkdown(String(requests[0]?.body), key))).toEqual({ version: 1, quote: opinion.quote, body: opinion.body })
    expect(isEncryptedMarkdown(String(requests[2]?.resolutionNote))).toBe(true)
    expect(JSON.stringify(requests)).not.toContain('fixture-private-')
    expect(JSON.stringify(reviewState.byPage)).not.toContain('fixture-private-')
    expect(JSON.stringify(reviewState.byPage)).not.toContain(opinion.body)
    expect(reviewsForPage(stored.id, stored.storageSourceId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: opinion.id, quote: opinion.quote, body: opinion.body, resolutionNote: 'fixture-private-resolution' }),
      expect.objectContaining({ id: 'ph_reply', replyTo: opinion.id, body: 'fixture-private-reply' }),
      expect.objectContaining(version),
    ]))
    startPheromoneDraft(stored.id, opinion.quote!, 'correction')
    pheromoneState.draft!.body = 'fixture-unsaved-private-draft'
    focusPheromone(opinion.id)
    lockProtectedPage(stored)
    expect(pheromoneState.draft).toBeNull()
    expect(pheromoneState.activeId).toBeNull()
    expect(reviewsForPage(stored.id, stored.storageSourceId)).toEqual([])
    await expect(addPageOpinion(stored, { opinionKind: 'support', quote: '', body: 'Must not send', baseUpdatedAt: stored.updatedAt })).rejects.toThrow('请先解锁页面')
    await unlockProtectedPage(stored, await importEncryptionPassword('fixture-review-password'))
    expect((await listPageReviews(stored)).entries.find((entry) => entry.id === opinion.id)?.body).toBe(opinion.body)
    store.pages[0] = { ...stored, markdown: await encryptMarkdown('new ciphertext', key) }
    expect(reviewsForPage(stored.id, stored.storageSourceId)).toEqual([])
  })

  it('does not recache a decrypt or response completed after a lock or account change', async () => {
    const { stored } = await fixture()
    let complete!: (response: Response) => void
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(() => new Promise((resolve) => { complete = resolve })))
    const key = await importEncryptionPassword('fixture-review-password')
    const { protectReviewEntries } = await import('./protected-review-format')
    const raw = await protectReviewEntries([opinion], key)
    let decryptStarted!: () => void
    let release!: () => void
    const started = new Promise<void>((resolve) => { decryptStarted = resolve })
    const held = new Promise<void>((resolve) => { release = resolve })
    const decrypt = crypto.subtle.decrypt.bind(crypto.subtle)
    vi.spyOn(crypto.subtle, 'decrypt').mockImplementation(async (...args) => {
      const result = await decrypt(...args)
      decryptStarted(); await held
      return result
    })
    const pending = listPageReviews(stored)
    complete(Response.json({ entries: raw }))
    await started
    lockProtectedPage(stored)
    release()
    expect((await pending).entries).toEqual([])
    expect(reviewsForPage(stored.id, stored.storageSourceId)).toEqual([])
    vi.restoreAllMocks()
    await unlockProtectedPage(stored, key)
    const late = listPageReviews(stored)
    useBackendStore().profile.user!.id = 'usr_another'
    complete(Response.json({ entries: raw }))
    await late
    expect(reviewsForPage(stored.id, stored.storageSourceId)).toEqual([])
    useBackendStore().profile.user!.id = 'usr_fixture'
    expect(reviewsForPage(stored.id, stored.storageSourceId)).toEqual([])
  })

  it('never caches or migrates old plaintext protected discussions', async () => {
    const { stored } = await fixture()
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ entries: [opinion] }))
    vi.stubGlobal('fetch', fetcher)
    await expect(listPageReviews(stored)).rejects.toThrow('意见格式无效')
    expect(JSON.stringify(reviewState.byPage)).not.toContain(opinion.body)
    pheromoneState.legacyByPage[stored.id] = [{ id: opinion.id, pageId: stored.id, kind: 'correction', actor: 'Old', quote: opinion.quote!, body: opinion.body!, createdAt: opinion.at }]
    expect(pheromonesFor(stored.id, stored.storageSourceId)).toEqual([])
    fetcher.mockResolvedValue(Response.json({ entries: [] }))
    await loadPheromones(stored)
    expect(fetcher.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true)
    expect(pheromoneState.legacyByPage[stored.id]).toHaveLength(1)
  })
})
