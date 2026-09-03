export type StorageRetryKind = 'file' | 's3' | 'backend' | 'browser'

const sharedPattern = /timeout|timed out|connection|network|ECONN|fetch failed|502|503|504/i

const filePattern = /无法保存|无法写入|无法删除|无法移除|Permission denied|No such file|read-only|只读|挂载|不可用|ENOENT|EIO|Stale file handle|Input\/output error/i

const s3Pattern = /无法连接|无法读取 S3|无法列出 S3|无法下载 S3|无法保存 S3/i

export function isRetryableStorageError(error: unknown, kind: StorageRetryKind = 'file') {
  const message = error instanceof Error ? error.message : String(error)
  if (/其他设备更新/.test(message)) return false
  if (sharedPattern.test(message)) return true
  if (kind === 'file' && filePattern.test(message)) return true
  if (kind === 's3' && s3Pattern.test(message)) return true
  if (kind === 'backend' && /fetch|network|后台|502|503|504/i.test(message)) return true
  return false
}

export function queueFailureMessage(error: unknown, action: string) {
  const message = error instanceof Error ? error.message : `${action}失败`
  // 入队 ≠ 成功：云端未确认写入前不得当作已保存。
  return `${message}（未写入远程，已加入待同步队列）`
}
