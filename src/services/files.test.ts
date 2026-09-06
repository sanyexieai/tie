import { describe, expect, it } from 'vitest'
import {
  buildFileUrl,
  collectFileIdsFromMarkdown,
  fileLinkClass,
  fileLinkLabel,
  parseFileUrl,
} from '@/services/files'

describe('files', () => {
  it('parses tie://file urls', () => {
    expect(parseFileUrl(buildFileUrl('file_abc123'))).toEqual({ fileId: 'file_abc123' })
    expect(parseFileUrl('tie://page/pg_1')).toBeNull()
  })

  it('collects file ids from markdown', () => {
    const markdown = 'see [副本](tie://file/file_a) and [外链](tie://file/file_b)'
    expect(collectFileIdsFromMarkdown(markdown).sort()).toEqual(['file_a', 'file_b'])
  })

  it('maps mode to distinct classes and labels', () => {
    expect(fileLinkClass('copy')).toContain('file-link-copy')
    expect(fileLinkClass('link')).toContain('file-link-link')
    expect(fileLinkClass('copy')).not.toEqual(fileLinkClass('link'))
    expect(fileLinkLabel('copy')).toBe('副本')
    expect(fileLinkLabel('link')).toBe('外链')
  })
})
