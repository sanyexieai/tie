import { describe, expect, it } from 'vitest'
import { isCrossSourceLink, linkableSources, pickLinkedResource, rebindLinkedResource, sourceChipLabel } from '@/services/link-actions'
import type { StorageSource } from '@/types'

function source(partial: Partial<StorageSource> & Pick<StorageSource, 'id' | 'kind'>): StorageSource {
  return { name: 't', path: '', ...partial }
}

describe('link-actions source helpers', () => {
  it('labels sources with kind and a short name', () => {
    expect(sourceChipLabel({ name: '工作区 A', kind: 'local' })).toBe('本地·工作区 A')
    expect(sourceChipLabel({ name: 'MinIO notes', kind: 's3' })).toBe('S3·MinIO no…')
    expect(sourceChipLabel({ name: '飞牛', kind: 'backend' })).toBe('后台·飞牛')
  })

  it('detects cross-source links', () => {
    expect(isCrossSourceLink('s3:abc', 'src_local_1')).toBe(true)
    expect(isCrossSourceLink('src_local_1', 'src_local_1')).toBe(false)
    expect(isCrossSourceLink('', 'src_local_1')).toBe(false)
  })

  it('lists linkable sources with the page source first', () => {
    const local = source({ id: 'src_local_2e27348a0aa628a6', kind: 'local', path: '/tmp/ws', name: '本机' })
    const s3 = source({ id: 's3:248d6286-f69f-4dab-8870-583d92f3529c', kind: 's3', name: '云' })
    const demo = source({ id: 'source-demo-local', kind: 'local', name: '演示' })
    const ordered = linkableSources([s3, demo, local], s3.id)
    expect(ordered.map((item) => item.id)).toEqual([s3.id, demo.id, local.id])
  })

  it('rejects rebind outside desktop or Android', async () => {
    const local = source({ id: 'src_local_2e27348a0aa628a6', kind: 'local', path: '/tmp/ws' })
    await expect(rebindLinkedResource(local, 'file_ab')).rejects.toThrow(/不能重新绑定/)
  })

  it('rejects directory pick in the browser', async () => {
    const demo = source({ id: 'source-demo-local', kind: 'local' })
    await expect(pickLinkedResource('directory', demo)).rejects.toThrow(/不能选择目录/)
  })
})
