import { computed } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { Page } from '@/types'
import { useWorkspaceStore } from '@/stores/workspace'
import { useBackendStore } from '@/stores/backend'
import { decryptMarkdown, encryptMarkdown, getWorkspaceEncryptionKey, importEncryptionPassword, isEncryptedMarkdown, lockAllWorkspaceEncryption, setWorkspaceEncryptionKey } from '@/services/encrypted-markdown'
import { browserStorageAdapter } from '@/services/storage/browser-adapter'
import {
  cacheProtectedPage, clearProtectedPages, decryptProtectedSnapshot, lockProtectedPage,
  protectedPageAuthorization, protectedPageKey, protectedPageView, protectedPagesRevision, unlockProtectedPage,
} from '@/services/protected-pages'

function page(markdown: string, overrides: Partial<Page> = {}): Page {
  return { id: 'pg_protected', title: 'Protected document', icon: '', parentId: null, sortKey: 0, markdown,
    tags: ['private'], createdAt: '2026-11-27T00:00:00Z', updatedAt: '2026-11-27T00:00:00Z', deletedAt: null,
    storageSourceId: 'src_local_protected', storageSourceIds: ['src_local_protected'], ...overrides }
}

afterEach(() => { clearProtectedPages(); lockAllWorkspaceEncryption(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('authorized protected page views using real encryption', () => {
  it('keeps plaintext out of the stored page and exposes the current metadata only while unlocked', async () => {
    const key = await importEncryptionPassword('fixture-only-page-password')
    const plaintext = '# Private document\n\nfixture-protected-body-62814\n'
    const stored = page(await encryptMarkdown(plaintext, key))
    const view = computed(() => protectedPageView(stored))
    expect(view.value).toBeNull()
    expect(protectedPageKey(stored)).toBeUndefined()
    expect(await unlockProtectedPage(stored, key)).toEqual({ ...stored, markdown: plaintext })
    expect(view.value?.markdown).toBe(plaintext)
    expect(protectedPageView({ ...stored, title: 'Renamed' })?.title).toBe('Renamed')
    expect(protectedPageKey(stored)).toBe(key)
    const permission = protectedPageAuthorization(stored)!
    expect(protectedPageAuthorization({ ...stored, markdown: plaintext })).toEqual(permission)
    expect(protectedPageAuthorization({ ...stored, markdown: 'different body' })).toBeUndefined()
    expect(stored.markdown).not.toContain('fixture-protected-body-62814')
    lockProtectedPage(stored)
    expect(view.value).toBeNull()
    expect(protectedPageKey(stored)).toBeUndefined()
    expect(protectedPageAuthorization(stored)).toBeUndefined()
    clearProtectedPages()
    await unlockProtectedPage(stored, key)
    expect(protectedPageAuthorization(stored)?.epoch).not.toBe(permission.epoch)
    const ordinary = page('ordinary text')
    expect(protectedPageView(ordinary)).toBe(ordinary)
    expect(await decryptProtectedSnapshot(ordinary)).toBe(ordinary)
  })

  it('requires an exact source and ciphertext version without replacing the current view when reading history', async () => {
    const key = await importEncryptionPassword('fixture-only-page-password')
    const stored = page(await encryptMarkdown('first body', key))
    const next = { ...stored, markdown: await encryptMarkdown('second body', key) }
    await unlockProtectedPage(stored, key)
    expect(protectedPageView(next)).toBeNull()
    expect((await decryptProtectedSnapshot(next)).markdown).toBe('second body')
    expect(protectedPageView(stored)?.markdown).toBe('first body')
    expect(protectedPageView(next)).toBeNull()
    const otherSource = { ...stored, storageSourceId: 'src_other' }
    expect(protectedPageView(otherSource)).toBeNull()
    expect(protectedPageKey(otherSource)).toBeUndefined()
    await expect(decryptProtectedSnapshot(otherSource)).rejects.toThrow('请先解锁页面')
    cacheProtectedPage(next, { ...next, markdown: 'second body' }, key)
    expect(protectedPageView(next)?.markdown).toBe('second body')
    expect(protectedPageView(stored)).toBeNull()
    expect(() => cacheProtectedPage(next, otherSource, key)).toThrow('解密正文不属于当前页面')
  })

  it('discards real decrypt results completed after an individual lock or account clear', async () => {
    const key = await importEncryptionPassword('fixture-only-page-password')
    const stored = page(await encryptMarkdown('private body', key))
    const pendingUnlock = unlockProtectedPage(stored, key)
    lockProtectedPage(stored)
    await expect(pendingUnlock).rejects.toThrow('页面解锁已取消')
    expect(protectedPageView(stored)).toBeNull()

    await unlockProtectedPage(stored, key)
    const pendingHistory = decryptProtectedSnapshot(stored)
    lockProtectedPage(stored)
    await expect(pendingHistory).rejects.toThrow('页面解锁已取消')

    const pendingAccount = unlockProtectedPage(stored, key)
    const revision = protectedPagesRevision.value
    clearProtectedPages()
    await expect(pendingAccount).rejects.toThrow('页面解锁已取消')
    expect(protectedPagesRevision.value).toBeGreaterThan(revision)
    expect(protectedPageKey(stored)).toBeUndefined()
  })

  it('does not let an earlier successful decrypt overwrite a later unlock request', async () => {
    const key = await importEncryptionPassword('fixture-only-page-password')
    const stored = page(await encryptMarkdown('first body', key))
    const next = { ...stored, markdown: await encryptMarkdown('second body', key) }
    const first = unlockProtectedPage(stored, key)
    const second = unlockProtectedPage(next, key)
    await expect(first).rejects.toThrow('页面解锁已取消')
    expect((await second).markdown).toBe('second body')
    expect(protectedPageView(next)?.markdown).toBe('second body')
    expect(protectedPageView(stored)).toBeNull()
  })
})

describe('workspace queries use authorized views without replacing persisted pages', () => {
  beforeEach(() => {
    const storage = new Map<string, string>()
    vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) })
    vi.stubGlobal('window', new EventTarget())
    setActivePinia(createPinia())
    const backend = useBackendStore()
    backend.profile = { endpoint: 'https://protected.example.test', accessToken: 'fixture-login-session', refreshToken: null,
      accessExpiresAt: null, user: { id: 'owner_a', name: 'A', email: 'a@example.test', createdAt: '' } }
  })

  it('withdraws plaintext search, snippets, links and mentions immediately when locked or the ciphertext changes', async () => {
    const key = await importEncryptionPassword('fixture-only-page-password')
    const plaintext = '## Private section\n\nfixture-hidden-query-59281 [Target](tie://page/pg_target) Unlinked Title\n'
    const stored = page(await encryptMarkdown(plaintext, key))
    const target = page('# Target', { id: 'pg_target', title: 'Target' })
    const mention = page('# Unlinked Title', { id: 'pg_mention', title: 'Unlinked Title' })
    const store = useWorkspaceStore()
    store.workspace = { id: 'test', name: 'Test', sources: [{ id: stored.storageSourceId, name: 'Local', kind: 'local', path: '/tmp/protected' }] }
    store.pages = [stored, target, mention]
    store.activePageId = stored.id
    store.searchQuery = 'fixture-hidden-query-59281'
    expect(store.searchResults).toEqual([])
    expect(store.links).toEqual([])
    expect(store.unlinkedMentions(stored.id)).toEqual([])

    await unlockProtectedPage(stored, key)
    expect(store.searchResults.map((item) => item.page.id)).toEqual([stored.id])
    expect(store.searchResults[0]?.snippet).toContain('fixture-hidden-query-59281')
    expect(store.searchResults[0]?.page.markdown).toBe(stored.markdown)
    expect(store.activePage?.markdown).toBe(stored.markdown)
    expect(store.links).toEqual([{ fromPageId: stored.id, toPageId: target.id }])
    expect(store.backlinks(target.id).map((item) => item.id)).toEqual([stored.id])
    expect(store.unlinkedMentions(stored.id).map((item) => item.id)).toEqual([mention.id])

    lockProtectedPage(stored)
    expect(store.searchResults).toEqual([])
    expect(store.links).toEqual([])
    expect(store.backlinks(target.id)).toEqual([])
    expect(store.unlinkedMentions(stored.id)).toEqual([])
    await unlockProtectedPage(stored, key)
    store.pages[0] = { ...stored, markdown: await encryptMarkdown('replacement body', key) }
    expect(store.searchResults).toEqual([])
    expect(store.links).toEqual([])
    expect(store.unlinkedMentions(stored.id)).toEqual([])
  })

  it('clears plaintext search access when the account or server changes', async () => {
    const key = await importEncryptionPassword('fixture-only-page-password')
    const stored = page(await encryptMarkdown('fixture-account-query-91382', key))
    const store = useWorkspaceStore()
    store.pages = [stored]
    store.searchQuery = 'fixture-account-query-91382'
    await unlockProtectedPage(stored, key)
    setWorkspaceEncryptionKey(stored.storageSourceId, key)
    expect(store.searchResults).toHaveLength(1)
    const backend = useBackendStore()
    backend.profile.user = { id: 'owner_b', name: 'B', email: 'b@example.test', createdAt: '' }
    expect(store.searchResults).toEqual([])
    expect(protectedPageKey(stored)).toBeUndefined()
    expect(getWorkspaceEncryptionKey(stored.storageSourceId)).toBeUndefined()
    await unlockProtectedPage(stored, key)
    setWorkspaceEncryptionKey(stored.storageSourceId, key)
    expect(store.searchResults).toHaveLength(1)
    backend.profile.endpoint = 'https://another.example.test'
    expect(store.searchResults).toEqual([])
    expect(protectedPageView(stored)).toBeNull()
    expect(getWorkspaceEncryptionKey(stored.storageSourceId)).toBeUndefined()
  })

  async function browserLinkFixture() {
    useBackendStore().profile.accessToken = null
    const key = await importEncryptionPassword('fixture-only-page-password')
    const plaintext = 'fixture-private-link-content-32918 Target\n'
    const stored = page(await encryptMarkdown(plaintext, key), { storageSourceId: 'source-demo-local', storageSourceIds: ['source-demo-local'] })
    const target = page('# Target', { id: 'pg_target', title: 'Target', storageSourceId: 'source-demo-local', storageSourceIds: ['source-demo-local'] })
    const workspace = { id: 'test', name: 'Test', sources: [{ id: stored.storageSourceId, name: 'Browser', kind: 'local' as const, path: 'localStorage' }] }
    localStorage.setItem('tie-demo-workspace-v1', JSON.stringify({ workspace, pages: [stored, target] }))
    const store = useWorkspaceStore()
    store.workspace = workspace
    store.pages = [stored, target]
    await unlockProtectedPage(stored, key)
    return { store, stored, target, key, plaintext }
  }

  it('links and unlinks through the real browser adapter while storing and archiving ciphertext only', async () => {
    const { store, stored, target, key, plaintext } = await browserLinkFixture()
    expect(await store.linkUnlinkedMention(stored.id, target.id)).toBe(true)
    const linked = store.pages.find((item) => item.id === stored.id)!
    expect(isEncryptedMarkdown(linked.markdown)).toBe(true)
    expect(await decryptMarkdown(linked.markdown, key)).toBe(plaintext.replace('Target', '[Target](tie://page/pg_target)'))
    expect(protectedPageView(linked)?.markdown).toContain('[Target](tie://page/pg_target)')
    expect(store.outgoingLinks(stored.id).map((item) => item.id)).toEqual([target.id])
    expect(await store.unlinkPageReference(stored.id, target.id)).toBe(true)
    const unlinked = store.pages.find((item) => item.id === stored.id)!
    expect(await decryptMarkdown(unlinked.markdown, key)).toBe(plaintext)
    expect(protectedPageView(unlinked)?.markdown).toBe(plaintext)
    expect(localStorage.getItem('tie-demo-workspace-v1')).not.toContain('fixture-private-link-content-32918')
    expect(localStorage.getItem('tie-demo-page-history-v1')).not.toContain('fixture-private-link-content-32918')
    const persisted = JSON.parse(localStorage.getItem('tie-demo-workspace-v1')!).pages.find((item: Page) => item.id === stored.id)
    expect(persisted.markdown).toBe(unlinked.markdown)
    lockProtectedPage(unlinked)
    await expect(store.linkUnlinkedMention(stored.id, target.id)).rejects.toThrow('请先解锁页面')
    await expect(store.unlinkPageReference(stored.id, target.id)).rejects.toThrow('请先解锁页面')
  })

  it('does not restore authorization when a link save finishes after changing accounts', async () => {
    const { store, stored, target, key } = await browserLinkFixture()
    let saved!: () => void
    let release!: () => void
    const started = new Promise<void>((resolve) => { saved = resolve })
    const held = new Promise<void>((resolve) => { release = resolve })
    const save = browserStorageAdapter.savePage.bind(browserStorageAdapter)
    vi.spyOn(browserStorageAdapter, 'savePage').mockImplementation(async (page, options) => {
      const result = await save(page, options)
      saved()
      await held
      return result
    })
    const pending = store.linkUnlinkedMention(stored.id, target.id)
    await started
    useBackendStore().profile.user = { id: 'owner_b', name: 'B', email: 'b@example.test', createdAt: '' }
    release()
    expect(await pending).toBe(true)
    const result = store.pages.find((item) => item.id === stored.id)!
    expect((await decryptMarkdown(result.markdown, key))).toContain('[Target](tie://page/pg_target)')
    expect(protectedPageView(result)).toBeNull()
    expect(protectedPageKey(result)).toBeUndefined()
    expect(localStorage.getItem('tie-demo-workspace-v1')).not.toContain('fixture-private-link-content-32918')
  })

  it('rejects a link operation locked during encryption before changing browser storage', async () => {
    const { store, stored, target } = await browserLinkFixture()
    const pending = store.linkUnlinkedMention(stored.id, target.id)
    await Promise.resolve()
    lockProtectedPage(stored)
    await expect(pending).rejects.toThrow('页面解锁已取消')
    const persisted = JSON.parse(localStorage.getItem('tie-demo-workspace-v1')!).pages.find((item: Page) => item.id === stored.id)
    expect(persisted.markdown).toBe(stored.markdown)
    expect(protectedPageView(stored)).toBeNull()
  })

  it.each(['lock', 'clear'])('does not replace a new same-key authorization after %s when an earlier link save returns', async (action) => {
    const { store, stored, target, key, plaintext } = await browserLinkFixture()
    let saved!: () => void
    let release!: () => void
    const started = new Promise<void>((resolve) => { saved = resolve })
    const held = new Promise<void>((resolve) => { release = resolve })
    const save = browserStorageAdapter.savePage.bind(browserStorageAdapter)
    vi.spyOn(browserStorageAdapter, 'savePage').mockImplementation(async (page, options) => {
      const result = await save(page, options)
      saved(); await held
      return result
    })
    const pending = store.linkUnlinkedMention(stored.id, target.id)
    await started
    if (action === 'lock') lockProtectedPage(stored)
    else clearProtectedPages()
    await unlockProtectedPage(stored, key)
    const permission = protectedPageAuthorization(stored)!
    release()
    expect(await pending).toBe(true)
    const result = store.pages.find((item) => item.id === stored.id)!
    expect(await decryptMarkdown(result.markdown, key)).toBe(plaintext.replace('Target', '[Target](tie://page/pg_target)'))
    expect(protectedPageView(result)).toBeNull()
    expect(protectedPageAuthorization(stored)).toEqual(permission)
  })

  it('does not append an encrypted page created before an account switch into the new account view', async () => {
    const { store, stored, key } = await browserLinkFixture()
    const originalPages = [...store.pages]
    store.activePageId = stored.id
    let saved!: () => void
    let release!: () => void
    const started = new Promise<void>((resolve) => { saved = resolve })
    const held = new Promise<void>((resolve) => { release = resolve })
    const save = browserStorageAdapter.savePage.bind(browserStorageAdapter)
    vi.spyOn(browserStorageAdapter, 'savePage').mockImplementation(async (page, options) => {
      const result = await save(page, options)
      saved(); await held
      return result
    })
    const ciphertext = await encryptMarkdown('fixture-private-created-before-account-switch', key)
    const pending = store.createEncryptedPage('Protected draft', ciphertext, stored.storageSourceId)
    await started
    useBackendStore().profile.user = { id: 'owner_b', name: 'B', email: 'b@example.test', createdAt: '' }
    release()
    const created = await pending
    expect(created.markdown).toBe(ciphertext)
    expect(store.pages).toEqual(originalPages)
    expect(store.activePageId).toBe(stored.id)
    const persisted = JSON.parse(localStorage.getItem('tie-demo-workspace-v1')!).pages.find((item: Page) => item.id === created.id)
    expect(await decryptMarkdown(persisted.markdown, key)).toBe('fixture-private-created-before-account-switch')
    expect(localStorage.getItem('tie-demo-workspace-v1')).not.toContain('fixture-private-created-before-account-switch')
  })

  it('flushes an encrypted editor before link writes and uses its newly saved body', async () => {
    const { store, stored, target, key, plaintext } = await browserLinkFixture()
    const failed = vi.fn(async () => false)
    let unregister = store.registerEditorSaveHandler(failed)
    expect(await store.linkUnlinkedMention(stored.id, target.id)).toBe(false)
    expect(await store.unlinkPageReference(stored.id, target.id)).toBe(false)
    expect(failed).toHaveBeenCalledTimes(2)
    expect(store.pages[0]?.markdown).toBe(stored.markdown)
    unregister()

    const draft = `${plaintext}new draft content\n`
    const flush = vi.fn(async () => {
      const current = store.pages.find((item) => item.id === stored.id)!
      const saved = { ...current, markdown: await encryptMarkdown(draft, key) }
      await store.persist(saved)
      const raw = store.pages.find((item) => item.id === stored.id)!
      cacheProtectedPage(raw, { ...raw, markdown: draft }, key)
      return true
    })
    unregister = store.registerEditorSaveHandler(flush)
    expect(await store.linkUnlinkedMention(stored.id, target.id)).toBe(true)
    expect(flush).toHaveBeenCalledOnce()
    const linked = store.pages.find((item) => item.id === stored.id)!
    expect(await decryptMarkdown(linked.markdown, key)).toBe(draft.replace('Target', '[Target](tie://page/pg_target)'))
    unregister()
  })
})
