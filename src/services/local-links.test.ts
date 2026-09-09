import { describe, expect, it } from 'vitest'
import {
  buildPathUrl,
  classifyLocalLink,
  localLinkClass,
  normalizeRelativePath,
  parsePathUrl,
  resolveRelativeToWorkspace,
} from '@/services/local-links'
import { buildFileUrl } from '@/services/files'

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
      href: 'tie://file/file_abc',
      fileId: 'file_abc',
    })
    expect(classifyLocalLink('tie://path/assets/readme.md')).toEqual({
      kind: 'relative',
      href: 'tie://path/assets/readme.md',
      relativePath: 'assets/readme.md',
    })
    expect(classifyLocalLink('file:///C:/Users/Admin/Docs/a.pdf')).toMatchObject({
      kind: 'absolute',
      absolutePath: 'C:\\Users\\Admin\\Docs\\a.pdf',
    })
  })

  it('resolves relative paths against workspace roots', () => {
    expect(resolveRelativeToWorkspace('/home/sanye/ws', 'docs/a.md')).toBe('/home/sanye/ws/docs/a.md')
    expect(resolveRelativeToWorkspace('C:\\Users\\sanye\\ws', 'docs/a.md')).toBe('C:\\Users\\sanye\\ws\\docs\\a.md')
  })

  it('maps kinds to distinct style classes', () => {
    expect(localLinkClass({ kind: 'absolute', href: 'file:///tmp/a' })).toContain('file-link-absolute')
    expect(localLinkClass({ kind: 'relative', href: 'tie://path/a', relativePath: 'a' })).toContain('file-link-relative')
    expect(localLinkClass({ kind: 'workspace-file', href: buildFileUrl('x'), fileId: 'x' })).toContain('file-link')
  })
})
