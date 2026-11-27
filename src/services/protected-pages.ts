import { ref } from 'vue'
import type { Page } from '@/types'
import { decryptMarkdown, isEncryptedMarkdown } from '@/services/encrypted-markdown'

interface AuthorizedPage {
  ciphertext: string
  markdown: string
  key: CryptoKey
}

const authorizedPages = new Map<string, AuthorizedPage>()
const pageGenerations = new Map<string, number>()
let epoch = 0

export const protectedPagesRevision = ref(0)

/** This view is for reading and editing only; workspace pages remain ciphertext. */
export function protectedPageView(page: Page): Page | null {
  void protectedPagesRevision.value
  if (!isEncryptedMarkdown(page.markdown)) return page
  const cached = authorizedPages.get(pageKey(page))
  return cached?.ciphertext === page.markdown ? { ...page, markdown: cached.markdown } : null
}

export async function unlockProtectedPage(page: Page, key: CryptoKey): Promise<Page> {
  if (!isEncryptedMarkdown(page.markdown)) return page
  const stored = { ...page }
  const id = pageKey(stored)
  const generation = nextGeneration(id)
  const currentEpoch = epoch
  const markdown = await decryptMarkdown(stored.markdown, key)
  requireCurrent(id, currentEpoch, generation)
  const view = { ...stored, markdown }
  authorizedPages.set(id, { ciphertext: stored.markdown, markdown, key })
  protectedPagesRevision.value += 1
  return view
}

export function cacheProtectedPage(storedPage: Page, plaintextPage: Page, key: CryptoKey): void {
  if (pageKey(storedPage) !== pageKey(plaintextPage)) throw new Error('解密正文不属于当前页面')
  const id = pageKey(storedPage)
  nextGeneration(id)
  if (isEncryptedMarkdown(storedPage.markdown)) {
    authorizedPages.set(id, { ciphertext: storedPage.markdown, markdown: plaintextPage.markdown, key })
  } else authorizedPages.delete(id)
  protectedPagesRevision.value += 1
}

export async function decryptProtectedSnapshot(page: Page): Promise<Page> {
  if (!isEncryptedMarkdown(page.markdown)) return page
  const stored = { ...page }
  const id = pageKey(stored)
  const key = authorizedPages.get(id)?.key
  if (!key) throw new Error('请先解锁页面')
  const currentEpoch = epoch
  const generation = pageGenerations.get(id)
  const markdown = await decryptMarkdown(stored.markdown, key)
  requireCurrent(id, currentEpoch, generation)
  return { ...stored, markdown }
}

export function protectedPageKey(page: Page): CryptoKey | undefined {
  void protectedPagesRevision.value
  return authorizedPages.get(pageKey(page))?.key
}

export function protectedPageAuthorization(page: Page): { key: CryptoKey; ciphertext: string; generation: number; epoch: number } | undefined {
  void protectedPagesRevision.value
  const id = pageKey(page)
  const cached = authorizedPages.get(id)
  if (!cached || (page.markdown !== cached.ciphertext && page.markdown !== cached.markdown)) return undefined
  return { key: cached.key, ciphertext: cached.ciphertext, generation: pageGenerations.get(id)!, epoch }
}

export function lockProtectedPage(page: Page): void {
  const id = pageKey(page)
  nextGeneration(id)
  authorizedPages.delete(id)
  protectedPagesRevision.value += 1
}

export function clearProtectedPages(): void {
  epoch += 1
  authorizedPages.clear()
  pageGenerations.clear()
  protectedPagesRevision.value += 1
}

function pageKey(page: Page) {
  return JSON.stringify([page.storageSourceId, page.id])
}

function nextGeneration(id: string) {
  const generation = (pageGenerations.get(id) ?? 0) + 1
  pageGenerations.set(id, generation)
  return generation
}

function requireCurrent(id: string, currentEpoch: number, generation: number | undefined) {
  if (epoch !== currentEpoch || pageGenerations.get(id) !== generation) throw new Error('页面解锁已取消，请重新解锁')
}
