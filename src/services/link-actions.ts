import type { StorageSource } from '@/types'
import { buildFileUrl, ingestCopiedBlob, ingestRegisteredFile, rebindRegisteredFile } from '@/services/files'
import { buildPathUrl, fileRootForSource, relativePathIfInsideRoot } from '@/services/link-runtime'
import { getPlatformAccess } from '@/services/platform-access'
import { blobStoreFor } from '@/services/storage/blobs'

function basename(path: string) {
  return path.replace(/\\/g, '/').split('/').filter(Boolean).pop() || path
}

export function sourceKindLabel(kind: StorageSource['kind'] | string | undefined) {
  if (kind === 's3') return 'S3'
  if (kind === 'backend') return '后台'
  if (kind === 'smb') return 'SMB'
  return '本地'
}

export function sourceChipLabel(source: Pick<StorageSource, 'name' | 'kind'> | null | undefined) {
  if (!source) return ''
  const name = source.name.trim() || '未命名'
  const chars = Array.from(name)
  const short = chars.length > 8 ? `${chars.slice(0, 8).join('')}…` : name
  return `${sourceKindLabel(source.kind)}·${short}`
}

export function isCrossSourceLink(linkSourceId: string | null | undefined, pageSourceId: string | null | undefined) {
  return Boolean(linkSourceId && pageSourceId && linkSourceId !== pageSourceId)
}

export function linkableSources(sources: StorageSource[], pageSourceId?: string | null) {
  const list = sources.filter((source) => {
    if (source.available === false) return false
    return Boolean(fileRootForSource(source) || blobStoreFor(source).canRegister)
  })
  return [...list].sort((left, right) => {
    if (left.id === pageSourceId) return -1
    if (right.id === pageSourceId) return 1
    return 0
  })
}

export async function pickLinkedResource(
  kind: 'file' | 'directory',
  source: StorageSource,
): Promise<{ title: string; href: string } | null> {
  const access = getPlatformAccess()
  const store = blobStoreFor(source)
  const root = fileRootForSource(source)
  if (!root && !store.canRegister) {
    throw new Error('当前存储源不能登记或引用本机文件')
  }

  if (access.canPick) {
    const path = await access.pick(kind)
    if (!path) return null
    if (root) {
      const relative = relativePathIfInsideRoot(root, path)
      if (relative) {
        return { title: basename(relative), href: buildPathUrl(relative, source.id) }
      }
    }
    if (!access.canRegisterAbsolute) {
      throw new Error('当前平台不能登记区外路径')
    }
    if (!store.canRegister) {
      throw new Error('当前存储源不能登记区外文件')
    }
    const resource = await ingestRegisteredFile(source, path, 'link')
    return { title: resource.title || resource.id, href: buildFileUrl(resource.id, source.id) }
  }

  if (kind === 'directory') {
    throw new Error('浏览器不能选择目录，请导入单个文件副本')
  }
  if (!access.canPickFile) {
    throw new Error('当前平台不能选择本机文件，请在桌面或 Android 客户端中打开。')
  }
  if (!store.ingestBytes) {
    throw new Error('当前存储源不能在浏览器中导入文件，请在桌面客户端打开')
  }
  const file = await access.pickFile()
  if (!file) return null
  const resource = await ingestCopiedBlob(source, file)
  const stored = resource.storedPath?.trim()
  const href = stored
    ? buildPathUrl(stored, source.id)
    : buildFileUrl(resource.id, source.id)
  return { title: resource.title || file.name, href }
}

export async function rebindLinkedResource(
  source: StorageSource,
  fileId: string,
  kind: 'file' | 'directory' = 'file',
): Promise<{ title: string; href: string } | null> {
  const access = getPlatformAccess()
  if (!access.canPick || !access.canRegisterAbsolute) {
    throw new Error('当前平台不能重新绑定本机文件')
  }
  if (!blobStoreFor(source).rebind) {
    throw new Error('当前存储源不能重新绑定文件')
  }
  const path = await access.pick(kind)
  if (!path) return null
  const resource = await rebindRegisteredFile(source, fileId, path)
  return { title: resource.title || resource.id, href: buildFileUrl(resource.id, source.id) }
}
