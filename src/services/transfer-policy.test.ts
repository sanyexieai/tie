import { describe, expect, it } from 'vitest'
import {
  canTransferBetweenSources,
  transferBlockedMessage,
  transferPreservesHistory,
} from '@/services/transfer-policy'

describe('transfer-policy', () => {
  it('allows file and s3 transfers in both directions', () => {
    expect(canTransferBetweenSources('file:home', 's3:notes')).toBe(true)
    expect(canTransferBetweenSources('s3:notes', 'file:home')).toBe(true)
    expect(canTransferBetweenSources('file:a', 'file:b')).toBe(true)
    expect(canTransferBetweenSources('s3:a', 's3:b')).toBe(true)
  })

  it('blocks backend workspace and backend-s3 cross transfers', () => {
    expect(canTransferBetweenSources('backend:ws1', 'backend-s3:prov1')).toBe(false)
    expect(canTransferBetweenSources('backend-s3:prov1', 'backend:ws1')).toBe(false)
    expect(canTransferBetweenSources('backend-s3:a', 'backend-s3:b')).toBe(false)
  })

  it('allows local managed sources to transfer with backend sources', () => {
    expect(canTransferBetweenSources('file:home', 'backend:ws1')).toBe(true)
    expect(canTransferBetweenSources('backend:ws1', 's3:notes')).toBe(true)
    expect(canTransferBetweenSources('backend-s3:prov1', 'file:home')).toBe(true)
  })

  it('preserves history for file and s3 transfers only', () => {
    expect(transferPreservesHistory('file:a', 'file:b')).toBe(true)
    expect(transferPreservesHistory('file:a', 's3:b')).toBe(true)
    expect(transferPreservesHistory('s3:a', 'file:b')).toBe(true)
    expect(transferPreservesHistory('backend:ws1', 'file:a')).toBe(false)
    expect(transferPreservesHistory('file:a', 'backend-s3:prov1')).toBe(false)
  })

  it('returns readable blocked messages', () => {
    expect(transferBlockedMessage('backend-s3:a', 'backend-s3:b')).toContain('后台 S3 Provider')
    expect(transferBlockedMessage('backend:ws1', 'backend-s3:prov1')).toContain('后台工作区')
  })
})
