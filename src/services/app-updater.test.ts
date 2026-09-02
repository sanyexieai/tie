import { describe, expect, it } from 'vitest'
import {
  appUpdaterUnavailableReasonForRuntime,
  extractUpdaterErrorMessage,
  formatUpdaterError,
  humanizeUpdaterError,
} from '@/services/app-updater'

describe('appUpdaterUnavailableReasonForRuntime', () => {
  it('blocks browser only', () => {
    expect(appUpdaterUnavailableReasonForRuntime('browser')).toMatch(/浏览器/)
    expect(appUpdaterUnavailableReasonForRuntime('desktop-dev')).toBeNull()
    expect(appUpdaterUnavailableReasonForRuntime('mobile-dev')).toBeNull()
    expect(appUpdaterUnavailableReasonForRuntime('mobile-release')).toBeNull()
    expect(appUpdaterUnavailableReasonForRuntime('desktop-release')).toBeNull()
  })
})

describe('extractUpdaterErrorMessage', () => {
  it('reads Error, string, and object messages', () => {
    expect(extractUpdaterErrorMessage(new Error('boom'))).toBe('boom')
    expect(extractUpdaterErrorMessage('plain')).toBe('plain')
    expect(extractUpdaterErrorMessage({ message: 'obj' })).toBe('obj')
    expect(extractUpdaterErrorMessage({ error: 'nested' })).toBe('nested')
    expect(extractUpdaterErrorMessage(null)).toBeNull()
  })
})

describe('humanizeUpdaterError', () => {
  it('adds hints for signature and network failures', () => {
    expect(humanizeUpdaterError('signature verification failed', 'install')).toMatch(/签名验证失败/)
    expect(humanizeUpdaterError('network timeout', 'check')).toMatch(/网络错误/)
    expect(humanizeUpdaterError('404 Not Found', 'install')).toMatch(/更新文件不存在/)
  })

  it('passes through unknown errors unchanged', () => {
    expect(humanizeUpdaterError('something odd', 'check')).toBe('something odd')
  })
})

describe('formatUpdaterError', () => {
  it('falls back when error is empty', () => {
    expect(formatUpdaterError(undefined, '下载或安装更新失败', 'install')).toBe('下载或安装更新失败')
  })
})
