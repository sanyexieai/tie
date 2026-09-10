import { afterEach, describe, expect, it } from 'vitest'
import { blobStoreFor, resetBrowserBlobStoreForTests } from '@/services/storage/blobs'
import { ingestCopiedBlob } from '@/services/files'
import { getPlatformAccess, isContentUri } from '@/services/platform-access'
import type { StorageSource } from '@/types'

function source(partial: Partial<StorageSource> & Pick<StorageSource, 'id' | 'kind'>): StorageSource {
  return { name: 't', path: '', ...partial }
}

describe('platform access', () => {
  it('uses browser access outside Tauri', () => {
    const access = getPlatformAccess()
    expect(access.kind).toBe('browser')
    expect(access.canPick).toBe(false)
    expect(access.canPickFile).toBe(true)
    expect(access.canRegisterAbsolute).toBe(false)
  })

  it('recognizes Android content uris', () => {
    expect(isContentUri('content://com.android.providers.media.documents/document/1')).toBe(true)
    expect(isContentUri('/storage/emulated/0/Download/a.pdf')).toBe(false)
  })
})

describe('blobStoreFor', () => {
  afterEach(() => {
    resetBrowserBlobStoreForTests()
  })

  it('routes local/smb to the file store and remote elsewhere', () => {
    expect(blobStoreFor(source({ id: 'src_local_2e27348a0aa628a6', kind: 'local', path: '/tmp/ws' })).canRegister).toBe(true)
    expect(blobStoreFor(source({ id: 'src_smb_aaaaaaaaaaaaaaaa', kind: 'smb', path: '/mnt/share' })).canRegister).toBe(true)
    expect(blobStoreFor(source({ id: 's3:248d6286-f69f-4dab-8870-583d92f3529c', kind: 's3' })).canRegister).toBe(true)
    expect(blobStoreFor(source({ id: 'backend:ws', kind: 'backend' })).canRegister).toBe(true)
    expect(blobStoreFor(source({ id: 'source-demo-local', kind: 'local' })).canRegister).toBe(true)
  })

  it('parses copy relative paths back to file ids', async () => {
    const { fileIdFromFilesRelative } = await import('@/services/storage/blobs-path')
    expect(fileIdFromFilesRelative('.tie/files/file_ab12cd34ef56ab78/original.pdf')).toBe('file_ab12cd34ef56ab78')
    expect(fileIdFromFilesRelative('docs/a.pdf')).toBeNull()
    const { assetRefFromRelative, joinWorkspaceRelative } = await import('@/services/storage/blobs-path')
    expect(assetRefFromRelative('.tie/assets/pg_abc/a1.png')).toEqual({ pageId: 'pg_abc', assetName: 'a1.png' })
    expect(joinWorkspaceRelative('/tmp/ws', 'docs/a.pdf')).toBe('/tmp/ws/docs/a.pdf')
  })

  it('rejects native-path ingest on remote and browser stores', async () => {
    await expect(blobStoreFor(source({ id: 's3:abc', kind: 's3' })).ingest(source({ id: 's3:abc', kind: 's3' }), '/tmp/a.pdf'))
      .rejects.toThrow(/仅桌面|Android/)
    await expect(blobStoreFor(source({ id: 'source-demo-local', kind: 'local' })).ingest(source({ id: 'source-demo-local', kind: 'local' }), '/tmp/a.pdf'))
      .rejects.toThrow(/导入副本/)
  })

  it('imports a browser copy and round-trips asset bytes', async () => {
    const demo = source({ id: 'source-demo-local', kind: 'local' })
    const file = new File([Uint8Array.from([1, 2, 3, 4])], 'notes.pdf', { type: 'application/pdf' })
    const resource = await ingestCopiedBlob(demo, file)
    expect(resource.mode).toBe('copy')
    expect(resource.storedPath).toMatch(/^\.tie\/files\/file_[0-9a-f]+\/original\.pdf$/)
    const store = blobStoreFor(demo)
    expect(await store.existsRelative?.(demo, resource.storedPath)).toBe(true)
    expect(Array.from((await store.readRelative!(demo, resource.storedPath)))).toEqual([1, 2, 3, 4])
    await store.writeRelative!(demo, '.tie/assets/pg_demo/a.png', Uint8Array.from([9, 8]))
    expect(Array.from((await store.readRelative!(demo, '.tie/assets/pg_demo/a.png')))).toEqual([9, 8])
  })
})
