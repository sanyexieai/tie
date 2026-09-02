import { describe, expect, it } from 'vitest'
import {
  dedupeStorageSources,
  isWorkspaceFileSource,
  uniqueSourceIds,
} from '@/services/storage-sources'
import type { StorageSource } from '@/types'

function source(partial: Partial<StorageSource> & Pick<StorageSource, 'id' | 'kind'>): StorageSource {
  return {
    name: partial.name ?? partial.id,
    path: partial.path ?? '',
    available: partial.available ?? true,
    ...partial,
  }
}

describe('storage-sources', () => {
  it('dedupes by id and keeps last value with first-seen order', () => {
    const result = dedupeStorageSources([
      source({ id: 's3:a', kind: 's3', name: 'stub', path: 'endpoint' }),
      source({ id: 'local', kind: 'local', name: '本机' }),
      source({ id: 's3:a', kind: 's3', name: '正式', path: 'endpoint/bucket', available: true }),
    ])
    expect(result.map((item) => item.id)).toEqual(['s3:a', 'local'])
    expect(result[0]?.name).toBe('正式')
    expect(result[0]?.path).toBe('endpoint/bucket')
  })

  it('uniqueSourceIds drops later duplicates', () => {
    expect(uniqueSourceIds(['a', 'b', 'a', 'c', 'b'])).toEqual(['a', 'b', 'c'])
  })

  it('filters S3 stubs out of workspace file sources', () => {
    expect(isWorkspaceFileSource(source({ id: 'src_local_1', kind: 'local' }))).toBe(true)
    expect(isWorkspaceFileSource(source({ id: 'src_smb_1', kind: 'smb' }))).toBe(true)
    expect(isWorkspaceFileSource(source({ id: 's3:abc', kind: 's3' }))).toBe(false)
    expect(isWorkspaceFileSource(source({ id: 's3:abc', kind: 'local' }))).toBe(false)
    expect(isWorkspaceFileSource(source({ id: 'backend:1', kind: 'backend' }))).toBe(false)
  })
})
