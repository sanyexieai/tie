import { describe, expect, it } from 'vitest'
import { decryptMarkdown, importEncryptionPassword, isEncryptedMarkdown } from '@/services/encrypted-markdown'
import { assertProtectedReviewEntries, protectReviewEntries, revealReviewEntries } from '@/services/protected-review-format'
import type { ReviewEntry } from '@/services/review-service'

const opinion: ReviewEntry = { id: 'ph_private', at: '', actor: 'Owner', kind: 'opinion', status: 'resolved',
  quote: 'fixture-private-quote', body: 'fixture-private-opinion', resolutionNote: 'fixture-private-resolution' }

describe('protected review payloads with real WebCrypto', () => {
  it('roundtrips quotes, opinions, resolution notes and manual versions without plaintext persistence', async () => {
    const key = await importEncryptionPassword('fixture-review-password')
    const version: ReviewEntry = { id: 'v_private', at: '', actor: 'Owner', kind: 'version', status: 'open', markdown: 'fixture-private-version' }
    const entries = [opinion, version]
    const stored = await protectReviewEntries(entries, key)
    expect(stored[0]?.quote).toBe('')
    expect(isEncryptedMarkdown(stored[0]!.body!)).toBe(true)
    expect(isEncryptedMarkdown(stored[0]!.resolutionNote!)).toBe(true)
    expect(isEncryptedMarkdown(stored[1]!.markdown!)).toBe(true)
    expect(JSON.stringify(stored)).not.toContain('fixture-private-')
    expect(JSON.parse(await decryptMarkdown(stored[0]!.body!, key))).toEqual({ version: 1, quote: opinion.quote, body: opinion.body })
    expect(await protectReviewEntries(stored, key)).toEqual(stored)
    const otherDeviceKey = await importEncryptionPassword('fixture-review-password')
    expect(await revealReviewEntries(stored, otherDeviceKey)).toEqual(entries)
    expect(entries[0]).toBe(opinion)
    expect(opinion.body).toBe('fixture-private-opinion')
    await expect(revealReviewEntries(stored, await importEncryptionPassword('wrong-password'))).rejects.toThrow()
    const nativeChange: ReviewEntry = { id: 'ch_native', at: '', actor: 'Tie', kind: 'change', status: 'recorded', markdown: '', quote: '', body: '', resolutionNote: '' }
    const nativeOpinion = { ...stored[0]!, markdown: '' }
    expect(await revealReviewEntries([nativeChange, nativeOpinion], key)).toEqual([nativeChange, { ...opinion, markdown: '' }])
    expect((await protectReviewEntries([nativeChange], key))[0]).toEqual(nativeChange)
  })

  it('rejects plaintext from protected records and reports the ciphertext limit before sending', async () => {
    expect(() => assertProtectedReviewEntries([opinion])).toThrow('意见格式无效')
    expect(() => assertProtectedReviewEntries([{ ...opinion, kind: 'version', quote: '', body: '', resolutionNote: '', markdown: 'plaintext' }])).toThrow('版本记录格式无效')
    const key = await importEncryptionPassword('fixture-review-password')
    await expect(protectReviewEntries([{ ...opinion, body: 'x'.repeat(100_000) }], key)).rejects.toThrow('内容过长')
  })
})
