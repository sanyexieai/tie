import { decryptMarkdown, encryptMarkdown, isEncryptedMarkdown } from '@/services/encrypted-markdown'
import type { ReviewEntry } from '@/services/review-service'

const MAX_CIPHERTEXT = 128 * 1024

export function assertProtectedReviewEntries(entries: ReviewEntry[]): void {
  for (const entry of entries) {
    if ((entry.kind === 'opinion' || entry.quote || entry.body) && (entry.quote || !isEncryptedMarkdown(entry.body ?? ''))) throw new Error('加密页面的意见格式无效')
    if (entry.resolutionNote && !isEncryptedMarkdown(entry.resolutionNote)) throw new Error('加密页面的处理说明格式无效')
    if (entry.markdown && !isEncryptedMarkdown(entry.markdown)) throw new Error('加密页面的版本记录格式无效')
  }
}

export async function protectReviewEntries(entries: ReviewEntry[], key: CryptoKey, seal = (value: string) => encryptMarkdown(value, key)): Promise<ReviewEntry[]> {
  return Promise.all(entries.map(async (entry) => {
    const next = { ...entry }
    if (entry.kind === 'opinion' || entry.quote || entry.body) {
      if (entry.quote || !isEncryptedMarkdown(entry.body ?? '')) {
        next.body = await encrypted(JSON.stringify({ version: 1, quote: entry.quote ?? '', body: entry.body ?? '' }), seal)
      }
      next.quote = ''
    }
    if (entry.resolutionNote && !isEncryptedMarkdown(entry.resolutionNote)) next.resolutionNote = await encrypted(entry.resolutionNote, seal)
    if ((entry.markdown || (entry.kind === 'version' && entry.markdown !== undefined)) && !isEncryptedMarkdown(entry.markdown!)) next.markdown = await encrypted(entry.markdown!, seal)
    return next
  }))
}

export async function revealReviewEntries(entries: ReviewEntry[], key: CryptoKey, legacyPlaintext = false): Promise<ReviewEntry[]> {
  if (!legacyPlaintext) assertProtectedReviewEntries(entries)
  return Promise.all(entries.map(async (entry) => {
    const next = { ...entry }
    if ((entry.kind === 'opinion' || entry.quote || entry.body) && isEncryptedMarkdown(entry.body ?? '') && !entry.quote) {
      const content: unknown = JSON.parse(await decryptMarkdown(entry.body!, key))
      if (!content || typeof content !== 'object' || Array.isArray(content)) throw new Error('加密意见格式无效')
      const payload = content as Record<string, unknown>
      if (payload.version !== 1 || typeof payload.quote !== 'string' || typeof payload.body !== 'string') throw new Error('加密意见格式无效')
      next.quote = payload.quote; next.body = payload.body
    }
    if (entry.resolutionNote && isEncryptedMarkdown(entry.resolutionNote)) {
      next.resolutionNote = await decryptMarkdown(entry.resolutionNote, key)
    }
    if (entry.markdown && isEncryptedMarkdown(entry.markdown)) {
      next.markdown = await decryptMarkdown(entry.markdown, key)
    }
    return next
  }))
}

async function encrypted(value: string, seal: (value: string) => Promise<string>) {
  const ciphertext = await seal(value)
  if (ciphertext.length > MAX_CIPHERTEXT) throw new Error('内容过长，无法加密保存这条意见或处理说明')
  return ciphertext
}
