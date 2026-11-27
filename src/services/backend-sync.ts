import type { BackendProfile } from '@/services/backend'

export interface SyncManifestEntry { id: string; version: string }
export interface BackendSyncManifest {
  version: 1
  revision: string
  pages: SyncManifestEntry[]
  reviews: SyncManifestEntry[]
  assets: SyncManifestEntry[]
  files: SyncManifestEntry[]
}

export interface LocalSyncVersions {
  pages: Record<string, string>
  reviews: Record<string, string>
  assets: Record<string, string>
  files: Record<string, string>
}

export interface SyncedResources {
  sourceId: string
  assetPageIds: string[]
  fileIds: string[]
}

let browserManifest: { scope: string; manifest: BackendSyncManifest } | undefined
let browserManifestHolds = 0

export function holdBrowserManifest() {
  browserManifestHolds += 1
  let held = true
  return () => { if (held) { held = false; browserManifestHolds -= 1 } }
}

export function backendSyncScope(profile: BackendProfile, workspaceId: string) {
  return JSON.stringify([profile.endpoint, profile.user?.id ?? '', workspaceId])
}

export function rememberedBrowserManifest(profile: BackendProfile, workspaceId: string) {
  return browserManifest?.scope === backendSyncScope(profile, workspaceId) ? browserManifest.manifest : undefined
}

export function rememberBrowserManifest(profile: BackendProfile, workspaceId: string, manifest: BackendSyncManifest) {
  if (browserManifestHolds) return
  browserManifest = { scope: backendSyncScope(profile, workspaceId), manifest }
}

export function changedManifestIds(previous: SyncManifestEntry[] | undefined, current: SyncManifestEntry[]) {
  const versions = new Map(previous?.map((item) => [item.id, item.version]))
  return current.filter((item) => versions.get(item.id) !== item.version).map((item) => item.id)
}

export function removedManifestIds(previous: SyncManifestEntry[] | undefined, current: SyncManifestEntry[]) {
  const ids = new Set(current.map((item) => item.id))
  return previous?.filter((item) => !ids.has(item.id)).map((item) => item.id) ?? []
}
