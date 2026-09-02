import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ASSET_URL_PREFIX,
  assetWriteSourceIds,
  buildAssetUrl,
  collectAssetNamesFromMarkdown,
  inlineImageSrcFromHtml,
  parseAssetUrl,
  preparePageExportBundle,
  rewriteMarkdownAssetsForExport,
} from '@/services/attachments'
import type { Page } from '@/types'

describe('attachments', () => {
  it('builds and parses asset urls', () => {
    const url = buildAssetUrl('pg_abc', 'a1b2.png')
    expect(url).toBe(`${ASSET_URL_PREFIX}pg_abc/a1b2.png`)
    expect(parseAssetUrl(url)).toEqual({ pageId: 'pg_abc', assetName: 'a1b2.png' })
  })

  it('rejects non asset urls', () => {
    expect(parseAssetUrl('https://example.com/a.png')).toBeNull()
    expect(parseAssetUrl(`${ASSET_URL_PREFIX}only-id`)).toBeNull()
  })

  it('collects asset names from markdown', () => {
    const markdown = '![](tie://asset/pg_abc/a1.png) and ![](/tie://asset/pg_abc/b2.jpg)'
    expect(collectAssetNamesFromMarkdown(markdown, 'pg_abc')).toEqual(['a1.png', 'b2.jpg'])
  })

  it('rewrites asset urls for export', () => {
    const markdown = '![](tie://asset/pg_abc/a1.png) text ![](/tie://asset/pg_abc/b2.jpg)'
    expect(rewriteMarkdownAssetsForExport(markdown, 'pg_abc')).toBe(
      '![](assets/a1.png) text ![](/assets/b2.jpg)',
    )
  })

  it('extracts inline image src from html clipboard', () => {
    expect(inlineImageSrcFromHtml('<img src="blob:http://localhost/abc">')).toBe('blob:http://localhost/abc')
    expect(inlineImageSrcFromHtml('<img src="data:image/png;base64,abc">')).toBe('data:image/png;base64,abc')
    expect(inlineImageSrcFromHtml('<img src="https://example.com/a.png">')).toBeNull()
  })

  describe('assetWriteSourceIds', () => {
    beforeEach(() => {
      vi.stubGlobal('window', { __TAURI_INTERNALS__: {} })
    })
    afterEach(() => {
      vi.unstubAllGlobals()
    })

    it('prefers cloud bindings over local primary', () => {
      expect(assetWriteSourceIds({
        storageSourceId: 'src_local_a',
        storageSourceIds: ['src_local_a', 's3:cloud'],
      })).toEqual(['s3:cloud'])
    })

    it('falls back to local primary when no cloud binding', () => {
      expect(assetWriteSourceIds({
        storageSourceId: 'src_local_a',
        storageSourceIds: ['src_local_a'],
      })).toEqual(['src_local_a'])
    })
  })

  it('prepares export bundle and rewrites markdown when assets are unavailable', async () => {
    const page: Page = {
      id: 'pg_export',
      title: '导出测试',
      icon: '',
      markdown: '![](tie://asset/pg_export/a1.png)\n\nplain text',
      tags: [],
      parentId: null,
      sortKey: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      deletedAt: null,
      storageSourceId: 'source-demo-local',
    }
    const bundle = await preparePageExportBundle(page)
    expect(bundle.markdown).toBe('![](assets/a1.png)\n\nplain text')
    expect(bundle.assets).toEqual({})
    expect(collectAssetNamesFromMarkdown(page.markdown, page.id)).toEqual(['a1.png'])
    expect(buildAssetUrl(page.id, 'a1.png')).toBe(`${ASSET_URL_PREFIX}${page.id}/a1.png`)
  })
})
