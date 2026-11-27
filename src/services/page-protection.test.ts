import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Page } from '@/types'
import type { PageProtectionBundle } from '@/services/page-protection-types'
import { decryptMarkdown, encryptMarkdown, importEncryptionPassword, isEncryptedMarkdown } from '@/services/encrypted-markdown'
import { decodeBase64, encodeBase64, planPageProtectionChanges, readPageProtection, replacePageProtection, transformPageProtection } from '@/services/page-protection'
import { browserStorageAdapter } from '@/services/storage/browser-adapter'
import { resetBrowserBlobStoreForTests } from '@/services/storage/blobs-browser'
import * as browserBlobs from '@/services/storage/blobs-browser'

const sourceId = 'source-demo-local'
const page = (markdown: string): Page => ({ id: 'pg_transition', title: 'Page', markdown, icon: '', parentId: null, sortKey: 0, tags: ['tag'],
  createdAt: '2026-11-27T00:00:00Z', updatedAt: '2026-11-27T00:00:00Z', deletedAt: null, storageSourceId: sourceId, storageSourceIds: [sourceId] })
let values: Map<string, string>
beforeEach(() => {
  values = new Map()
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) })
  vi.stubGlobal('indexedDB', undefined)
  resetBrowserBlobStoreForTests()
})
afterEach(() => { resetBrowserBlobStoreForTests(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('whole-page protection using real Web Crypto', () => {
  it('round trips body, history, discussion, manual versions and orphan bytes without plaintext mirrors', async () => {
    const key = await importEncryptionPassword('fixture-conversion-password')
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jp1EAAAAASUVORK5CYII='
    const body = '# Page\n\nfixture-private-body\n\n![picture](tie://asset/pg_transition/image.png)'
    const bundle: PageProtectionBundle = { snapshot: 'fixture-snapshot', page: page(body), revisions: [{ id: 'rev_old', page: page('fixture-private-old') }],
      reviews: { entries: [
        { id: 'op_1', kind: 'opinion', status: 'resolved', actor: 'Owner', at: '', quote: 'fixture-private-quote', body: 'fixture-private-opinion', resolutionNote: 'fixture-private-resolution' },
        { id: 'v_1', kind: 'version', status: 'open', actor: 'Owner', at: '', markdown: 'fixture-private-manual-version' },
      ] }, assets: [{ name: 'image.png', data: png }, { name: 'orphan.bin', data: encodeBase64(new TextEncoder().encode('fixture-private-orphan')) }] }
    const protectedBundle = await transformPageProtection(bundle, key, true)
    expect(JSON.stringify(protectedBundle)).not.toContain('fixture-private-')
    expect(protectedBundle.snapshot).toBe(bundle.snapshot)
    expect(protectedBundle.assets.map((asset) => asset.name)).toEqual(['orphan.bin'])
    const imageMarkdown = await decryptMarkdown(protectedBundle.page.markdown, key)
    expect(imageMarkdown).toContain(`data:image/png;base64,${png}`)
    const restored = await transformPageProtection(protectedBundle, key, false)
    expect(restored.page).toEqual({ ...bundle.page, markdown: imageMarkdown })
    expect(restored.revisions).toEqual(bundle.revisions)
    expect(restored.reviews.entries).toEqual(bundle.reviews.entries)
    expect(new TextDecoder().decode(decodeBase64(restored.assets[0]!.data))).toBe('fixture-private-orphan')
    expect(bundle.page.markdown).toBe(body)
  })

  it('replaces real browser history instead of archiving the old plaintext on conversion', async () => {
    const key = await importEncryptionPassword('fixture-conversion-password')
    const first = page('fixture-private-first-version')
    await browserStorageAdapter.savePage(first)
    const second = { ...first, markdown: 'fixture-private-second-version', updatedAt: '2026-11-27T00:00:01Z' }
    await browserStorageAdapter.savePage(second)
    const before = await readPageProtection(second)
    const encrypted = await replacePageProtection(await transformPageProtection(before, key, true), before.page.updatedAt)
    expect(encrypted.id).toBe(first.id)
    expect(isEncryptedMarkdown(encrypted.markdown)).toBe(true)
    expect([...values.values()].join('\n')).not.toContain('fixture-private-')
    const locked = await readPageProtection(encrypted)
    const ordinary = await replacePageProtection(await transformPageProtection(locked, key, false), locked.page.updatedAt)
    expect(ordinary.markdown).toBe(second.markdown)
    const after = await readPageProtection(ordinary)
    expect(after.revisions.find((revision) => revision.id === before.revisions[0]!.id)?.page.markdown).toBe(first.markdown)
    expect(after.revisions.every((revision) => !isEncryptedMarkdown(revision.page.markdown))).toBe(true)
  })

  it('refuses a stale snapshot or wrong password without writing any page/history bytes', async () => {
    const key = await importEncryptionPassword('fixture-conversion-password')
    const first = page('fixture-private-original')
    await browserStorageAdapter.savePage(first)
    const original = await readPageProtection(first)
    const transformed = await transformPageProtection(original, key, true)
    const latest = { ...first, markdown: 'fixture-private-newer', updatedAt: '2026-11-27T00:00:02Z' }
    await browserStorageAdapter.savePage(latest)
    const unchanged = [...values]
    await expect(replacePageProtection(transformed, first.updatedAt)).rejects.toThrow('已更新')
    expect([...values]).toEqual(unchanged)
    const locked = await replacePageProtection(await transformPageProtection(await readPageProtection(latest), key, true), latest.updatedAt)
    const raw = [...values]
    await expect(transformPageProtection(await readPageProtection(locked), await importEncryptionPassword('wrong-password'), false)).rejects.toThrow('无法解密')
    expect([...values]).toEqual(raw)
  })

  it('reuses ciphertext for equal content during one multi-workspace conversion', async () => {
    const key = await importEncryptionPassword('fixture-conversion-password')
    const bundle: PageProtectionBundle = { snapshot: 'first', page: page('fixture-private-same'), revisions: [], reviews: { entries: [] }, assets: [] }
    const sealed = new Map<string, Promise<string>>()
    const first = await transformPageProtection(bundle, key, true, sealed)
    const second = await transformPageProtection({ ...bundle, snapshot: 'second', page: { ...bundle.page, storageSourceId: 'backend:fixture' } }, key, true, sealed)
    expect(first.page.markdown).toBe(second.page.markdown)
    expect(second.snapshot).toBe('second')
  })

  it.each([false, true])('aligns an ordinary local page with an authenticated encrypted server copy (server first=%s)', async (serverFirst) => {
    const key = await importEncryptionPassword('fixture-conversion-password')
    const local: PageProtectionBundle = { sourceId, snapshot: 'local', page: page('fixture-private-same'),
      revisions: [{ id: 'local-only-history', page: page('fixture-private-local-history') }],
      reviews: { entries: [{ id: 'local-only-opinion', kind: 'opinion', status: 'open', actor: 'Owner', at: '', body: 'fixture-private-local-opinion' }] }, assets: [] }
    const remote = await transformPageProtection({ ...local, sourceId: 'backend:fixture', snapshot: 'server', revisions: [], reviews: { entries: [] } }, key, true)
    const originalLocal = JSON.stringify(local)
    const originalRemote = JSON.stringify(remote)
    const changes = await planPageProtectionChanges(serverFirst ? [remote, local] : [local, remote], key, true)
    expect(changes).toHaveLength(1)
    const after = changes[0]!.after
    expect(changes[0]!.before).toBe(local)
    expect(after.page.markdown).toBe(remote.page.markdown)
    expect(after.revisions[0]!.id).toBe('local-only-history')
    expect(await decryptMarkdown(after.revisions[0]!.page.markdown, key)).toBe('fixture-private-local-history')
    expect(after.reviews.entries[0]!.id).toBe('local-only-opinion')
    expect(JSON.stringify(after)).not.toContain('fixture-private-')
    expect(JSON.stringify(local)).toBe(originalLocal)
    expect(JSON.stringify(remote)).toBe(originalRemote)
  })

  it('preserves real content differences when aligning protection modes and authenticates before planning', async () => {
    const key = await importEncryptionPassword('fixture-conversion-password')
    const local: PageProtectionBundle = { sourceId, snapshot: 'local', page: page('fixture-private-local-edit'), revisions: [], reviews: { entries: [] }, assets: [] }
    const remote = await transformPageProtection({ ...local, sourceId: 'backend:fixture', snapshot: 'server', page: page('fixture-private-server-edit') }, key, true)
    const original = JSON.stringify([local, remote])
    await expect(planPageProtectionChanges([local, remote], await importEncryptionPassword('wrong-password'), true)).rejects.toThrow('无法解密')
    expect(JSON.stringify([local, remote])).toBe(original)
    const changes = await planPageProtectionChanges([local, remote], key, true)
    expect(changes).toHaveLength(1)
    expect(changes[0]!.after.page.markdown).not.toBe(remote.page.markdown)
    expect(await decryptMarkdown(changes[0]!.after.page.markdown, key)).toBe(local.page.markdown)
    expect(JSON.stringify([local, remote])).toBe(original)
  })

  it('authenticates the current encrypted page before converting older plaintext records and binary assets', async () => {
    const key = await importEncryptionPassword('fixture-conversion-password')
    const bytes = new Uint8Array([255, 0, 254, 1])
    const bundle: PageProtectionBundle = { snapshot: 'legacy', page: page(await encryptMarkdown('fixture-private-current', key)),
      revisions: [{ id: 'old', page: page('fixture-private-legacy-history') }],
      reviews: { entries: [{ id: 'old-opinion', kind: 'opinion', status: 'open', actor: 'Owner', at: '', quote: 'fixture-private-quote', body: 'fixture-private-legacy-opinion' }] },
      assets: [{ name: 'legacy.bin', data: encodeBase64(bytes) }] }
    await expect(transformPageProtection(bundle, await importEncryptionPassword('wrong'), false)).rejects.toThrow('无法解密')
    const ordinary = await transformPageProtection(bundle, key, false)
    expect(ordinary.page.markdown).toBe('fixture-private-current')
    expect(ordinary.revisions).toEqual(bundle.revisions)
    expect(ordinary.reviews).toEqual(bundle.reviews)
    expect(decodeBase64(ordinary.assets[0]!.data)).toEqual(bytes)
  })

  it.each([false, true])('keeps saves made while browser assets are committing (same page=$samePage)', async (samePage) => {
    const key = await importEncryptionPassword('fixture-conversion-password')
    const first = page('fixture-private-original')
    const other = { ...page('other-original'), id: 'pg_other' }
    await browserStorageAdapter.savePage(first)
    await browserStorageAdapter.savePage(other)
    const before = await readPageProtection(first)
    const transformed = await transformPageProtection(before, key, true)
    const write = browserBlobs.replaceBrowserPageAssets
    let resume!: () => void
    let started!: () => void
    const gate = new Promise<void>((resolve) => { resume = resolve })
    const waiting = new Promise<void>((resolve) => { started = resolve })
    vi.spyOn(browserBlobs, 'replaceBrowserPageAssets').mockImplementationOnce(async (...args) => { await write(...args); started(); await gate })
    const conversion = replacePageProtection(transformed, first.updatedAt)
    await waiting
    const edited = { ...(samePage ? first : other), markdown: 'saved-during-conversion', updatedAt: '2026-11-27T00:00:02Z' }
    await browserStorageAdapter.savePage(edited)
    resume()
    if (samePage) await expect(conversion).rejects.toThrow('已更新')
    else await expect(conversion).resolves.toMatchObject({ id: first.id })
    expect((await browserStorageAdapter.readLatestPage!(edited))?.markdown).toBe(edited.markdown)
    const history = await browserStorageAdapter.listPageRevisions!(edited)
    expect((await browserStorageAdapter.readPageRevision!(edited, history[0]!.id)).markdown).toBe(samePage ? first.markdown : other.markdown)
  })
})
