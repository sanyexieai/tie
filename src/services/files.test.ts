import { describe, expect, it } from 'vitest'
import {
  buildFileUrl,
  collectFileIdsFromMarkdown,
  collectFileRefsFromMarkdown,
  parseFileUrl,
} from '@/services/files'
import { fileLinkClass, fileLinkLabel, fileLinkTitle, rememberRelativeExists, resourceAvailability } from '@/services/files'
import {
  assetRelativePath,
  assetToPathUrl,
  availabilityForSource,
  buildPathUrl,
  classifyLocalLink,
  collectPathRefsFromMarkdown,
  isStorageSourceId,
  parseAssetUrl,
  parsePathUrl,
  relativePathIfInsideRoot,
  replaceFileProtocolHrefs,
  rewriteLegacyWorkspaceHrefs,
} from '@/services/link-runtime'

const localSource = 'src_local_2e27348a0aa628a6'
const s3Source = 's3:248d6286-f69f-4dab-8870-583d92f3529c'

describe('link-runtime', () => {
  it('recognizes storage source ids without treating relative folders as sources', () => {
    expect(isStorageSourceId(localSource)).toBe(true)
    expect(isStorageSourceId(s3Source)).toBe(true)
    expect(isStorageSourceId('backend:ws_1')).toBe(true)
    expect(isStorageSourceId('docs')).toBe(false)
    expect(isStorageSourceId('file_abc')).toBe(false)
  })

  it('builds and parses source-aware file urls, keeping legacy ids', () => {
    expect(parseFileUrl(buildFileUrl('file_abc123'))).toEqual({ fileId: 'file_abc123' })
    expect(parseFileUrl(buildFileUrl('file_abc123', localSource))).toEqual({
      sourceId: localSource,
      fileId: 'file_abc123',
    })
    expect(parseFileUrl(`tie://file/${s3Source}/file_ab`)).toEqual({
      sourceId: s3Source,
      fileId: 'file_ab',
    })
    expect(parseFileUrl('tie://page/pg_1')).toBeNull()
  })

  it('builds and parses source-aware path urls', () => {
    expect(buildPathUrl('docs/spec.pdf')).toBe('tie://path/docs/spec.pdf')
    expect(parsePathUrl('tie://path/docs%2Fnotes/a.md')).toEqual({ relativePath: 'docs/notes/a.md' })
    expect(parsePathUrl(buildPathUrl('docs/spec.pdf', localSource))).toEqual({
      sourceId: localSource,
      relativePath: 'docs/spec.pdf',
    })
    expect(parsePathUrl('tie://file/file_1')).toBeNull()
  })

  it('collects file refs with optional source ids', () => {
    const markdown = `see [副本](tie://file/file_a) and [跨源](tie://file/${localSource}/file_b)`
    expect(collectFileIdsFromMarkdown(markdown).sort()).toEqual(['file_a', 'file_b'])
    expect(collectFileRefsFromMarkdown(markdown)).toEqual([
      { fileId: 'file_a' },
      { sourceId: localSource, fileId: 'file_b' },
    ])
  })

  it('classifies relative, registered, and legacy file urls', () => {
    expect(classifyLocalLink(buildFileUrl('file_abc', localSource))).toMatchObject({
      kind: 'workspace-file',
      form: 'absolute',
      fileId: 'file_abc',
      sourceId: localSource,
    })
    expect(classifyLocalLink('tie://path/assets/readme.md')).toMatchObject({
      kind: 'relative',
      form: 'relative',
      relativePath: 'assets/readme.md',
    })
    expect(classifyLocalLink('file:///C:/Users/Admin/Docs/a.pdf')).toMatchObject({
      kind: 'absolute',
      form: 'absolute',
      absolutePath: 'C:\\Users\\Admin\\Docs\\a.pdf',
    })
  })

  it('detects paths inside a workspace root', () => {
    expect(relativePathIfInsideRoot('/home/sanye/ws', '/home/sanye/ws/docs/a.md')).toBe('docs/a.md')
    expect(relativePathIfInsideRoot('/home/sanye/ws', '/home/sanye/other/a.md')).toBeNull()
    expect(relativePathIfInsideRoot('C:\\Users\\sanye\\ws', 'C:\\Users\\sanye\\ws\\docs\\a.md')).toBe('docs/a.md')
  })

  it('rewrites file protocol hrefs in pasted text', () => {
    const text = 'see [x](file:///tmp/a.pdf) and file:///tmp/b.txt'
    expect(replaceFileProtocolHrefs(text, () => 'tie://path/src/a')).toBe('see [x](tie://path/src/a) and tie://path/src/a')
  })
})

describe('files labels', () => {
  it('maps to relative/absolute classes and labels per ADR', () => {
    expect(fileLinkClass('copy')).toContain('file-link-relative')
    expect(fileLinkClass('link')).toContain('file-link-absolute')
    expect(fileLinkClass('copy')).not.toEqual(fileLinkClass('link'))
    expect(fileLinkClass('link', 'directory')).toContain('file-link-directory')
    expect(fileLinkClass('link', 'directory')).toContain('file-link-absolute')
    expect(fileLinkClass(null, null, null, 'relative')).toContain('file-link-relative')
    expect(fileLinkClass('link', 'file', 'missing')).toContain('file-link-missing')
    expect(fileLinkLabel('copy')).toBe('')
    expect(fileLinkLabel('link')).toBe('')
    expect(fileLinkLabel('link', 'directory')).toBe('')
    expect(fileLinkLabel('copy', 'directory')).toBe('')
    expect(fileLinkLabel('link', 'file', 'missing')).toBe('找不到')
    expect(fileLinkLabel('relative', 'file', 'missing')).toBe('缺失')
    expect(fileLinkTitle('copy')).toBe('库内文件')
    expect(fileLinkTitle('link', 'directory')).toBe('本机目录')
    expect(fileLinkTitle('link', 'file', 'missing')).toBe('本机文件 · 找不到')
  })
})

describe('asset alias and legacy href migration', () => {
  it('treats tie://asset as a relative path alias, not a file chip', () => {
    expect(parseAssetUrl('tie://asset/pg_abc/a1.png')).toEqual({ pageId: 'pg_abc', assetName: 'a1.png' })
    expect(assetRelativePath('pg_abc', 'a1.png')).toBe('.tie/assets/pg_abc/a1.png')
    expect(assetToPathUrl('tie://asset/pg_abc/a1.png', localSource)).toBe(
      buildPathUrl('.tie/assets/pg_abc/a1.png', localSource),
    )
    expect(classifyLocalLink('tie://asset/pg_abc/a1.png')).toBeNull()
  })

  it('rewrites legacy file and path hrefs with the page source id', () => {
    const markdown = [
      '[旧登记](tie://file/file_abc)',
      '[旧相对](tie://path/docs/a.pdf)',
      `![图](tie://asset/pg_1/x.png)`,
      `[已带源](tie://file/${localSource}/file_old)`,
    ].join('\n')
    const rewritten = rewriteLegacyWorkspaceHrefs(markdown, localSource)
    expect(rewritten).toContain(`](${buildFileUrl('file_abc', localSource)})`)
    expect(rewritten).toContain(`](${buildPathUrl('docs/a.pdf', localSource)})`)
    expect(rewritten).toContain('![图](tie://asset/pg_1/x.png)')
    expect(rewritten).toContain(`tie://file/${localSource}/file_old`)
    expect(rewriteLegacyWorkspaceHrefs(rewritten, localSource)).toBe(rewritten)
  })

  it('collects path refs and marks relative missing after probe cache', () => {
    expect(collectPathRefsFromMarkdown(`[a](tie://path/${localSource}/docs/a.pdf)`)).toEqual([
      { sourceId: localSource, relativePath: 'docs/a.pdf' },
    ])
    rememberRelativeExists(localSource, 'docs/a.pdf', false)
    expect(resourceAvailability(
      { kind: 'relative', form: 'relative', href: 'tie://path/docs/a.pdf', relativePath: 'docs/a.pdf', sourceId: localSource },
      { pageSourceId: localSource, sources: [{ id: localSource, name: '本机', kind: 'local', path: '/tmp/ws', available: true }] },
    )).toBe('missing')
  })

  it('does not treat a reachable S3 source as offline just because it has no local root', () => {
    expect(availabilityForSource(
      { id: s3Source, name: '云', kind: 's3', path: '', available: true },
      true,
    )).toBe('ready')
  })
})
