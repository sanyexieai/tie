import { isBackendManagedS3SourceId, isBackendSourceId } from '@/services/backend'
import { isS3SourceId } from '@/services/s3'
import { isFileSourceId } from '@/services/storage/types'

function isLocalManagedSource(sourceId: string) {
  return isFileSourceId(sourceId) || isS3SourceId(sourceId)
}

export function canTransferBetweenSources(fromSourceId: string, toSourceId: string) {
  if (fromSourceId === toSourceId) return false

  const fromBackendWs = isBackendSourceId(fromSourceId)
  const toBackendWs = isBackendSourceId(toSourceId)
  const fromBackendS3 = isBackendManagedS3SourceId(fromSourceId)
  const toBackendS3 = isBackendManagedS3SourceId(toSourceId)

  if (fromBackendS3 && toBackendS3) return false
  if (fromBackendWs && toBackendS3) return false
  if (fromBackendS3 && toBackendWs) return false

  if (fromBackendWs || toBackendWs) {
    return isLocalManagedSource(fromSourceId) || isLocalManagedSource(toSourceId)
  }

  if (fromBackendS3 || toBackendS3) {
    return isLocalManagedSource(fromSourceId) || isLocalManagedSource(toSourceId)
  }

  return true
}

export function transferPreservesHistory(fromSourceId: string, toSourceId: string) {
  if (isBackendSourceId(fromSourceId) || isBackendSourceId(toSourceId)) return false
  if (isBackendManagedS3SourceId(fromSourceId) || isBackendManagedS3SourceId(toSourceId)) return false
  if (isFileSourceId(fromSourceId) && isFileSourceId(toSourceId)) return true
  if (isFileSourceId(fromSourceId) && isS3SourceId(toSourceId)) return true
  if (isS3SourceId(fromSourceId) && isFileSourceId(toSourceId)) return true
  if (isS3SourceId(fromSourceId) && isS3SourceId(toSourceId)) return true
  return false
}

export function transferBlockedMessage(fromSourceId: string, toSourceId: string) {
  if (isBackendManagedS3SourceId(fromSourceId) && isBackendManagedS3SourceId(toSourceId)) {
    return '暂不支持在两个后台 S3 Provider 之间迁移页面'
  }
  if (isBackendSourceId(fromSourceId) && isBackendManagedS3SourceId(toSourceId)) {
    return '暂不支持在后台工作区与后台 S3 Provider 之间迁移页面'
  }
  if (isBackendManagedS3SourceId(fromSourceId) && isBackendSourceId(toSourceId)) {
    return '暂不支持在后台 S3 Provider 与后台工作区之间迁移页面'
  }
  return '不支持在这两个存储源之间迁移页面'
}
