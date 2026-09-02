import type { StorageSource } from '@/types'

/** 按 id 去重：保留首次出现顺序，值取最后一次（后写入的源信息更完整）。 */
export function dedupeStorageSources(sources: StorageSource[]): StorageSource[] {
  const latest = new Map<string, StorageSource>()
  for (const source of sources) latest.set(source.id, source)
  const order: string[] = []
  const seen = new Set<string>()
  for (const source of sources) {
    if (seen.has(source.id)) continue
    seen.add(source.id)
    order.push(source.id)
  }
  return order.map((id) => latest.get(id)!)
}

/** 去掉顺序数组里的重复 id，保留首次出现。 */
export function uniqueSourceIds(ids: string[]): string[] {
  const seen = new Set<string>()
  const next: string[] = []
  for (const id of ids) {
    if (seen.has(id)) continue
    seen.add(id)
    next.push(id)
  }
  return next
}

/** workspace.sources 里不应再挂 S3（S3 统一走 providers 列表）。 */
export function isWorkspaceFileSource(source: Pick<StorageSource, 'id' | 'kind'>) {
  if (source.kind === 's3') return false
  if (source.id.startsWith('s3:')) return false
  return source.kind === 'local' || source.kind === 'smb'
}
