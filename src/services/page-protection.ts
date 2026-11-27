import type { Page } from '@/types'
import type { PageProtectionBundle } from '@/services/page-protection-types'
import { decryptMarkdown, encryptMarkdown, isEncryptedMarkdown } from '@/services/encrypted-markdown'
import { protectReviewEntries, revealReviewEntries } from '@/services/protected-review-format'
import { protectedImageDataUrl } from '@/services/protected-images'
import { storageRegistry } from '@/services/storage/registry'

export async function readPageProtection(page: Page): Promise<PageProtectionBundle> {
  const adapter = storageRegistry.resolve(page.storageSourceId)
  if (!adapter.readPageProtection) throw new Error('请先将页面移到本地或服务器工作区后转换')
  return { ...await adapter.readPageProtection(page), sourceId: page.storageSourceId }
}

export async function replacePageProtection(bundle: PageProtectionBundle, expectedUpdatedAt: string): Promise<Page> {
  const adapter = storageRegistry.resolve(bundle.sourceId ?? bundle.page.storageSourceId)
  if (!adapter.replacePageProtection) throw new Error('此工作区暂不支持页面保护转换')
  return adapter.replacePageProtection(bundle, expectedUpdatedAt)
}

/** Transform every stored copy before committing, so old history cannot retain plaintext. */
export async function transformPageProtection(bundle: PageProtectionBundle, key: CryptoKey, encrypted: boolean, sealed = new Map<string, Promise<string>>()): Promise<PageProtectionBundle> {
  if (isEncryptedMarkdown(bundle.page.markdown) === encrypted) throw new Error(encrypted ? '页面已经加密' : '页面已经是普通页面')
  const usedAssets = new Set<string>()
  const assets = new Map(bundle.assets.map((asset) => [asset.name, asset.data]))
  const seal = (text: string) => {
    if (!sealed.has(text)) sealed.set(text, encryptMarkdown(text, key))
    return sealed.get(text)!
  }
  const inline = async (text: string) => {
    const pattern = new RegExp(`tie://asset/${escapeRegExp(bundle.page.id)}/([A-Za-z0-9._-]+)`, 'g')
    const replacements = new Map<string, string>()
    for (const match of text.matchAll(pattern)) {
      const name = decodeURIComponent(match[1]!)
      const data = assets.get(name)
      if (!data) throw new Error(`无法读取页面图片：${name}`)
      if (!replacements.has(match[0])) replacements.set(match[0], await protectedImageDataUrl(new Blob([decodeBase64(data)])))
      usedAssets.add(name)
    }
    return text.replace(pattern, (url) => replacements.get(url)!)
  }
  const transform = async (text: string) => encrypted
    ? seal(await inline(isEncryptedMarkdown(text) ? await decryptMarkdown(text, key) : text))
    : isEncryptedMarkdown(text) ? decryptMarkdown(text, key) : text
  const page = { ...bundle.page, markdown: await transform(bundle.page.markdown) }
  const revisions = await Promise.all(bundle.revisions.map(async (revision) => ({ ...revision, page: { ...revision.page, markdown: await transform(revision.page.markdown) } })))
  const entries = encrypted ? await Promise.all(bundle.reviews.entries.map(async (entry) => ({
    ...entry,
    ...(entry.quote ? { quote: await inline(entry.quote) } : {}),
    ...(entry.body ? { body: await inline(entry.body) } : {}),
    ...(entry.markdown ? { markdown: await inline(entry.markdown) } : {}),
    ...(entry.resolutionNote ? { resolutionNote: await inline(entry.resolutionNote) } : {}),
  }))) : bundle.reviews.entries
  // The current page was authenticated above before accepting older plaintext records.
  const reviews = { entries: encrypted ? await protectReviewEntries(entries, key, seal) : await revealReviewEntries(entries, key, true) }
  const remaining = encrypted ? bundle.assets.filter((asset) => !usedAssets.has(asset.name)) : bundle.assets
  const protectedAssets = await Promise.all(remaining.map(async (asset) => {
    const armored = encrypted ? '' : new TextDecoder().decode(decodeBase64(asset.data))
    return { name: asset.name, data: encrypted
      ? encodeBase64(new TextEncoder().encode(await seal(asset.data)))
      : isEncryptedMarkdown(armored) ? await decryptMarkdown(armored, key) : asset.data }
  }))
  return { ...bundle, page, revisions, reviews, assets: protectedAssets }
}

export function encodeBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 32_768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768))
  return btoa(binary)
}

export function decodeBase64(text: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(text), (character) => character.charCodeAt(0))
}

function escapeRegExp(text: string) { return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }
