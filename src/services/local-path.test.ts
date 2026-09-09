import { describe, expect, it } from 'vitest'
import { fileUrlToLocalPath, isLocalFileHref } from './local-path'

describe('fileUrlToLocalPath', () => {
  it('parses Windows drive file urls', () => {
    expect(fileUrlToLocalPath('file:///C:/Users/Admin/Docs')).toBe('C:\\Users\\Admin\\Docs')
    expect(fileUrlToLocalPath('file:///C|/Users/Admin/Docs')).toBe('C:\\Users\\Admin\\Docs')
  })

  it('parses UNC file urls', () => {
    expect(fileUrlToLocalPath('file://server/share/folder')).toBe('\\\\server\\share\\folder')
  })

  it('parses posix file urls', () => {
    expect(fileUrlToLocalPath('file:///home/sanye/code')).toBe('/home/sanye/code')
  })

  it('rejects non-file urls', () => {
    expect(fileUrlToLocalPath('https://example.com')).toBeNull()
    expect(isLocalFileHref('tie://file/abc')).toBe(false)
    expect(isLocalFileHref('file:///tmp')).toBe(true)
  })
})
