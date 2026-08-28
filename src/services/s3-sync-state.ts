export interface S3ObjectSyncState {
  etag: string | null
  lastModified: string | null
}

export interface S3ProviderSyncState {
  objects: Record<string, S3ObjectSyncState>
  lastSyncAt: string | null
}

export interface S3PageIndexEntry {
  pageId: string
  etag: string | null
  lastModified: string | null
}

const KEY_PREFIX = 'tie-s3-sync-state-v1:'

function emptyState(): S3ProviderSyncState {
  return { objects: {}, lastSyncAt: null }
}

export function loadS3SyncState(providerId: string): S3ProviderSyncState {
  try {
    const raw = localStorage.getItem(`${KEY_PREFIX}${providerId}`)
    if (!raw) return emptyState()
    const parsed = JSON.parse(raw) as Partial<S3ProviderSyncState>
    return {
      objects: parsed.objects && typeof parsed.objects === 'object' ? parsed.objects : {},
      lastSyncAt: typeof parsed.lastSyncAt === 'string' ? parsed.lastSyncAt : null,
    }
  } catch {
    return emptyState()
  }
}

export function saveS3SyncState(providerId: string, state: S3ProviderSyncState) {
  localStorage.setItem(`${KEY_PREFIX}${providerId}`, JSON.stringify(state))
}

export function pageIdsNeedingDownload(index: S3PageIndexEntry[], cached: S3ProviderSyncState) {
  if (!cached.lastSyncAt) return index.map((entry) => entry.pageId)
  return index
    .filter((entry) => {
      const previous = cached.objects[entry.pageId]
      if (!previous) return true
      return previous.etag !== entry.etag || previous.lastModified !== entry.lastModified
    })
    .map((entry) => entry.pageId)
}

export function nextS3SyncState(index: S3PageIndexEntry[]): S3ProviderSyncState {
  const objects: Record<string, S3ObjectSyncState> = {}
  index.forEach((entry) => {
    objects[entry.pageId] = { etag: entry.etag, lastModified: entry.lastModified }
  })
  return { objects, lastSyncAt: new Date().toISOString() }
}
