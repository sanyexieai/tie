import { describe, expect, it } from 'vitest'
import {
  fileUrlToLocalPath,
  isLocalFileHref,
  shortenDisplayPath,
  stripWindowsExtendedPrefix,
} from './local-path'

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

describe('stripWindowsExtendedPrefix', () => {
  it('strips drive and UNC prefixes', () => {
    expect(stripWindowsExtendedPrefix('\\\\?\\C:\\Users\\sanye\\.cursor\\skills-cursor\\automate\\SKILL.md'))
      .toBe('C:\\Users\\sanye\\.cursor\\skills-cursor\\automate\\SKILL.md')
    expect(stripWindowsExtendedPrefix('\\\\?\\UNC\\server\\share\\skills'))
      .toBe('\\\\server\\share\\skills')
  })
})

describe('shortenDisplayPath', () => {
  it('shortens windows user homes after stripping extended prefix', () => {
    expect(shortenDisplayPath('\\\\?\\C:\\Users\\sanye\\.cursor\\skills\\x'))
      .toBe('~\\.cursor\\skills\\x')
  })

  it('shortens posix homes', () => {
    expect(shortenDisplayPath('/home/sanye/code/tie')).toBe('~/code/tie')
  })
})
