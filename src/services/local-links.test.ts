import { describe, expect, it } from 'vitest'
import {
  applyLocalLinkClasses,
  buildPathUrl,
  classifyLocalLink,
  convertFileProtocolHref,
  localLinkClass,
  migratePageLocalHrefs,
  normalizeRelativePath,
  parsePathUrl,
  resolveRelativeToWorkspace,
} from '@/services/local-links'
import { buildFileUrl } from '@/services/files'

const localSource = 'src_local_2e27348a0aa628a6'
const s3Source = 's3:248d6286-f69f-4dab-8870-583d92f3529c'

describe('local-links', () => {
  it('builds and parses relative path urls', () => {
    expect(buildPathUrl('docs/spec.pdf')).toBe('tie://path/docs/spec.pdf')
    expect(parsePathUrl('tie://path/docs%2Fnotes/a.md')).toEqual({ relativePath: 'docs/notes/a.md' })
    expect(parsePathUrl('tie://file/file_1')).toBeNull()
  })

  it('rejects unsafe relative paths', () => {
    expect(() => normalizeRelativePath('../secret')).toThrow(/\.\./)
    expect(() => normalizeRelativePath('/etc/passwd')).toThrow(/绝对/)
    expect(() => normalizeRelativePath('C:/Windows')).toThrow(/绝对/)
  })

  it('classifies link kinds without changing absolute file urls', () => {
    expect(classifyLocalLink(buildFileUrl('file_abc'))).toEqual({
      kind: 'workspace-file',
      form: 'absolute',
      href: 'tie://file/file_abc',
      fileId: 'file_abc',
    })
    expect(classifyLocalLink('tie://path/assets/readme.md')).toEqual({
      kind: 'relative',
      form: 'relative',
      href: 'tie://path/assets/readme.md',
      relativePath: 'assets/readme.md',
    })
    expect(classifyLocalLink('file:///C:/Users/Admin/Docs/a.pdf')).toMatchObject({
      kind: 'absolute',
      form: 'absolute',
      absolutePath: 'C:\\Users\\Admin\\Docs\\a.pdf',
    })
  })

  it('resolves relative paths against workspace roots', () => {
    expect(resolveRelativeToWorkspace('/home/sanye/ws', 'docs/a.md')).toBe('/home/sanye/ws/docs/a.md')
    expect(resolveRelativeToWorkspace('C:\\Users\\sanye\\ws', 'docs/a.md')).toBe('C:\\Users\\sanye\\ws\\docs\\a.md')
  })

  it('maps kinds to distinct style classes', () => {
    expect(localLinkClass({ kind: 'absolute', form: 'absolute', href: 'file:///tmp/a' })).toContain('file-link-absolute')
    expect(localLinkClass({ kind: 'relative', form: 'relative', href: 'tie://path/a', relativePath: 'a' })).toContain('file-link-relative')
    expect(localLinkClass({ kind: 'workspace-file', form: 'absolute', href: buildFileUrl('x'), fileId: 'x' })).toContain('file-link-absolute')
  })

  it('marks cross-source chips with source name', () => {
    const classes = new Set<string>()
    const dataset: Record<string, string> = {}
    const anchor = {
      classList: {
        add: (...tokens: string[]) => { for (const token of tokens) if (token) classes.add(token) },
        remove: (...tokens: string[]) => { for (const token of tokens) classes.delete(token) },
      },
      dataset,
    } as unknown as HTMLAnchorElement
    applyLocalLinkClasses(anchor, buildFileUrl('file_ab', s3Source), {
      pageSourceId: localSource,
      sources: [
        { id: localSource, name: '本机', kind: 'local', path: '/tmp/ws' },
        { id: s3Source, name: 'MinIO', kind: 's3', path: '' },
      ],
    })
    expect(dataset.linkCross).toBe('1')
    expect(dataset.linkSourceName).toBe('S3·MinIO')
    expect(classes.has('file-link-cross-source')).toBe(true)
  })

  it('rewrites file:/// under a source root to relative tie://path', async () => {
    const href = await convertFileProtocolHref('file:///tmp/ws/docs/a.pdf', {
      pageSourceId: localSource,
      sources: [{ id: localSource, name: '本机', kind: 'local', path: '/tmp/ws', available: true }],
    })
    expect(href).toBe(buildPathUrl('docs/a.pdf', localSource))
  })

  it('migrates page markdown file:/// links in the shared pipeline', async () => {
    const page = {
      markdown: '见 [x](file:///tmp/ws/readme.md) 与 tie://file/file_old',
      storageSourceId: localSource,
    }
    const result = await migratePageLocalHrefs(page, [
      { id: localSource, name: '本机', kind: 'local', path: '/tmp/ws', available: true },
    ])
    expect(result.converted).toBe(1)
    expect(result.page.markdown).toContain(`](${buildPathUrl('readme.md', localSource)})`)
    expect(result.page.markdown).toContain(buildFileUrl('file_old', localSource))
    expect(result.page.markdown).not.toMatch(/file:\/\//i)
  })
})
