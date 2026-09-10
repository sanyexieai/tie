import { describe, expect, it } from 'vitest'
import { fileMetaToJson, normalizeFileMeta } from '@/services/storage/file-meta'

describe('file-meta', () => {
  it('fills locator and sourceId from legacy sourcePath records', () => {
    const meta = normalizeFileMeta({
      id: 'file_ab12cd34',
      title: '手册',
      mode: 'link',
      kind: 'file',
      sourcePath: '/home/sanye/book.pdf',
      storedPath: '/home/sanye/book.pdf',
      mime: 'application/pdf',
      ext: 'pdf',
      size: 12,
    }, { sourceId: 'src_local_2e27348a0aa628a6', now: '2026-09-10T00:00:00.000Z' })
    expect(meta.sourceId).toBe('src_local_2e27348a0aa628a6')
    expect(meta.locator).toEqual({
      type: 'desktop',
      desktopPath: '/home/sanye/book.pdf',
      displayPath: '/home/sanye/book.pdf',
    })
    expect(fileMetaToJson(meta).locator).toEqual(meta.locator)
  })

  it('keeps android locator fields and aliases contentHash', () => {
    const meta = normalizeFileMeta({
      id: 'file_aa',
      mode: 'link',
      locator: { type: 'android', androidUri: 'content://doc/1', displayPath: 'a.pdf' },
      sha256: 'abc',
    })
    expect(meta.locator.type).toBe('android')
    expect(meta.locator.androidUri).toBe('content://doc/1')
    expect(meta.contentHash).toBe('abc')
    expect(meta.sha256).toBe('abc')
  })

  it('treats content:// sourcePath as an android locator', () => {
    const meta = normalizeFileMeta({
      id: 'file_cc',
      mode: 'link',
      sourcePath: 'content://com.android.providers.media.documents/document/42',
      storedPath: 'content://com.android.providers.media.documents/document/42',
      title: 'photo.jpg',
    })
    expect(meta.locator.type).toBe('android')
    expect(meta.locator.androidUri).toBe('content://com.android.providers.media.documents/document/42')
    expect(meta.locator.desktopPath).toBeUndefined()
    expect(meta.locator.displayPath).toBe('photo.jpg')
  })
})
