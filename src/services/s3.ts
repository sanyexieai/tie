import { invoke } from '@tauri-apps/api/core'
import type { StorageSource } from '@/types'
import {
  looksLikeLegacyS3ProviderId,
  s3ProviderIdFromEndpointBucket,
} from '@/services/storage-identity'
import { loadS3SyncState, saveS3SyncState } from '@/services/s3-sync-state'

export interface LocalS3Provider {
  id: string
  name: string
  endpoint: string
  bucket: string
  region?: string
  credentialStored?: boolean
  createdAt: string
}

export const LOCAL_S3_PROVIDERS_KEY = 'tie-s3-providers-v1'
const SOURCE_ID_REMAP_KEY = 'tie-s3-source-id-remap-v1'

let cachedProviders: LocalS3Provider[] | null = null
/** 最近一次指纹迁移：旧 `s3:uuid` → 新 `s3:fingerprint` */
let lastSourceIdRemap = new Map<string, string>()

function readPersistedSourceIdRemap(): Map<string, string> {
  try {
    const raw = JSON.parse(localStorage.getItem(SOURCE_ID_REMAP_KEY) ?? '{}') as unknown
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return new Map()
    return new Map(
      Object.entries(raw as Record<string, unknown>)
        .filter((entry): entry is [string, string] => typeof entry[0] === 'string' && typeof entry[1] === 'string')
        .filter(([from, to]) => isS3SourceId(from) && isS3SourceId(to)),
    )
  } catch {
    return new Map()
  }
}

function persistSourceIdRemap(remap: Map<string, string>) {
  if (!remap.size) return
  const merged = readPersistedSourceIdRemap()
  for (const [from, to] of remap) merged.set(from, to)
  const payload: Record<string, string> = {}
  for (const [from, to] of merged) payload[from] = to
  localStorage.setItem(SOURCE_ID_REMAP_KEY, JSON.stringify(payload))
}

function rememberSourceIdRemap(remap: Map<string, string>) {
  if (!remap.size) return
  for (const [from, to] of remap) lastSourceIdRemap.set(from, to)
  persistSourceIdRemap(remap)
}

async function isTauri() {
  return '__TAURI_INTERNALS__' in window
}

function normalizeProvider(raw: LocalS3Provider): LocalS3Provider {
  return {
    id: raw.id,
    name: raw.name,
    endpoint: raw.endpoint,
    bucket: raw.bucket,
    region: raw.region,
    credentialStored: raw.credentialStored ?? false,
    createdAt: raw.createdAt ?? new Date().toISOString(),
  }
}

function readLegacyProviders(): LocalS3Provider[] {
  try {
    const raw = JSON.parse(localStorage.getItem(LOCAL_S3_PROVIDERS_KEY) ?? '[]') as unknown
    return Array.isArray(raw) ? raw.filter((item): item is LocalS3Provider => Boolean(
      item && typeof item === 'object'
      && typeof (item as LocalS3Provider).id === 'string'
      && typeof (item as LocalS3Provider).endpoint === 'string'
      && typeof (item as LocalS3Provider).bucket === 'string',
    )).map(normalizeProvider) : []
  } catch {
    return []
  }
}

export function loadLocalS3Providers(): LocalS3Provider[] {
  if (cachedProviders) return cachedProviders
  return readLegacyProviders()
}

export function takeS3SourceIdRemap() {
  const map = new Map([...readPersistedSourceIdRemap(), ...lastSourceIdRemap])
  lastSourceIdRemap = new Map()
  return map
}

/** 不消费 lastSourceIdRemap：每次加载都应用持久化映射。 */
export function peekS3SourceIdRemap() {
  return new Map([...readPersistedSourceIdRemap(), ...lastSourceIdRemap])
}

/**
 * 磁盘 frontmatter 可能仍写着迁移前的 `s3:uuid`。
 * 用持久化 remap；若仅有一个 S3 连接，则把未知 legacy id 一并收束到它。
 */
export function buildS3SourceIdHealingRemap(pages: Array<{ storageSourceId: string; storageSourceIds?: string[] }>) {
  const remap = peekS3SourceIdRemap()
  const providers = loadLocalS3Providers()
  const known = new Set(providers.map((provider) => s3SourceId(provider.id)))
  if (providers.length === 1) {
    const target = s3SourceId(providers[0]!.id)
    for (const page of pages) {
      for (const sourceId of [page.storageSourceId, ...(page.storageSourceIds ?? [])]) {
        const id = sourceId.trim()
        if (!isS3SourceId(id) || known.has(id) || remap.has(id)) continue
        if (looksLikeLegacyS3ProviderId(id.slice('s3:'.length))) remap.set(id, target)
      }
    }
  }
  if (remap.size) persistSourceIdRemap(remap)
  return remap
}

function migrateSyncState(fromProviderId: string, toProviderId: string) {
  if (fromProviderId === toProviderId) return
  const from = loadS3SyncState(fromProviderId)
  const to = loadS3SyncState(toProviderId)
  if (!from.lastSyncAt && !Object.keys(from.objects).length) return
  saveS3SyncState(toProviderId, {
    lastSyncAt: to.lastSyncAt ?? from.lastSyncAt,
    objects: { ...from.objects, ...to.objects },
  })
  try {
    localStorage.removeItem(`tie-s3-sync-state-v1:${fromProviderId}`)
  } catch {
    // ignore
  }
}

/**
 * 将随机 UUID provider id 迁到 endpoint+bucket 指纹；返回 `s3:old` → `s3:new`。
 * 凭据迁移由 Rust `load_s3_providers` 完成；此处负责配置与 sync-state。
 */
export function stabilizeS3ProviderIds(providers: LocalS3Provider[]): {
  providers: LocalS3Provider[]
  sourceIdRemap: Map<string, string>
} {
  const sourceIdRemap = new Map<string, string>()
  const byStable = new Map<string, LocalS3Provider>()

  for (const raw of providers) {
    const provider = normalizeProvider(raw)
    const stableId = s3ProviderIdFromEndpointBucket(provider.endpoint, provider.bucket)
    if (provider.id !== stableId) {
      sourceIdRemap.set(s3SourceId(provider.id), s3SourceId(stableId))
      migrateSyncState(provider.id, stableId)
    }
    const next = { ...provider, id: stableId }
    const existing = byStable.get(stableId)
    if (!existing) {
      byStable.set(stableId, next)
      continue
    }
    byStable.set(stableId, {
      ...existing,
      ...next,
      name: existing.name || next.name,
      credentialStored: existing.credentialStored || next.credentialStored,
      createdAt: existing.createdAt <= next.createdAt ? existing.createdAt : next.createdAt,
    })
  }

  if (sourceIdRemap.size) rememberSourceIdRemap(sourceIdRemap)
  return { providers: [...byStable.values()], sourceIdRemap }
}

export async function refreshS3Providers(options: { migrateLegacy?: boolean } = {}) {
  try {
    if (await isTauri()) {
      if (options.migrateLegacy) {
        const legacy = readLegacyProviders()
        const current = await invoke<LocalS3Provider[]>('load_s3_providers')
        if (legacy.length && !current.length) {
          await invoke('save_s3_providers', { providers: legacy.map(normalizeProvider) })
          localStorage.removeItem(LOCAL_S3_PROVIDERS_KEY)
        }
      }
      // Rust 侧会做指纹规范化 + 凭据迁移
      const loaded = (await invoke<LocalS3Provider[]>('load_s3_providers')).map(normalizeProvider)
      const { providers, sourceIdRemap } = stabilizeS3ProviderIds(loaded)
      const changed = sourceIdRemap.size > 0
        || providers.length !== loaded.length
        || providers.some((item) => !loaded.some((raw) => raw.id === item.id && raw.endpoint === item.endpoint && raw.bucket === item.bucket))
      if (changed) {
        await invoke('save_s3_providers', { providers })
      }
      cachedProviders = providers
    } else {
      const { providers, sourceIdRemap } = stabilizeS3ProviderIds(readLegacyProviders())
      cachedProviders = providers
      if (sourceIdRemap.size) localStorage.setItem(LOCAL_S3_PROVIDERS_KEY, JSON.stringify(providers))
    }
  } catch (error) {
    console.warn('S3 Provider 加载失败，将使用本地缓存', error)
    const { providers } = stabilizeS3ProviderIds(readLegacyProviders())
    cachedProviders = providers
  }
  window.dispatchEvent(new Event('tie:s3-providers-changed'))
  return cachedProviders ?? []
}

async function persistProviders(providers: LocalS3Provider[]) {
  const stabilized = stabilizeS3ProviderIds(providers)
  if (stabilized.sourceIdRemap.size) {
    for (const [from, to] of stabilized.sourceIdRemap) lastSourceIdRemap.set(from, to)
  }
  cachedProviders = stabilized.providers
  if (await isTauri()) {
    await invoke('save_s3_providers', { providers: cachedProviders })
  } else {
    localStorage.setItem(LOCAL_S3_PROVIDERS_KEY, JSON.stringify(cachedProviders))
  }
  window.dispatchEvent(new Event('tie:s3-providers-changed'))
}

export function saveLocalS3Providers(providers: LocalS3Provider[]) {
  void persistProviders(providers)
}

export async function saveLocalS3ProvidersAsync(providers: LocalS3Provider[]) {
  await persistProviders(providers)
}

export function upsertS3Provider(provider: LocalS3Provider) {
  const stable = {
    ...normalizeProvider(provider),
    id: s3ProviderIdFromEndpointBucket(provider.endpoint, provider.bucket),
  }
  if (provider.id && provider.id !== stable.id) {
    lastSourceIdRemap.set(s3SourceId(provider.id), s3SourceId(stable.id))
    migrateSyncState(provider.id, stable.id)
  }
  const providers = loadLocalS3Providers()
  const index = providers.findIndex((item) => item.id === stable.id)
  if (index === -1) providers.push(stable)
  else providers[index] = stable
  if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
    void invoke('upsert_s3_provider', { provider: stable }).then((saved) => {
      cachedProviders = stabilizeS3ProviderIds((saved as LocalS3Provider[]).map(normalizeProvider)).providers
      window.dispatchEvent(new Event('tie:s3-providers-changed'))
    })
    cachedProviders = providers
  } else {
    void persistProviders(providers)
  }
}

export async function upsertS3ProviderAsync(provider: LocalS3Provider) {
  const stable = {
    ...normalizeProvider(provider),
    id: s3ProviderIdFromEndpointBucket(provider.endpoint, provider.bucket),
  }
  if (provider.id && provider.id !== stable.id) {
    lastSourceIdRemap.set(s3SourceId(provider.id), s3SourceId(stable.id))
    migrateSyncState(provider.id, stable.id)
  }
  if (await isTauri()) {
    cachedProviders = stabilizeS3ProviderIds(
      (await invoke<LocalS3Provider[]>('upsert_s3_provider', { provider: stable })).map(normalizeProvider),
    ).providers
  } else {
    const providers = loadLocalS3Providers()
    const index = providers.findIndex((item) => item.id === stable.id)
    if (index === -1) providers.push(stable)
    else providers[index] = stable
    await persistProviders(providers)
  }
  window.dispatchEvent(new Event('tie:s3-providers-changed'))
}

export function removeS3Provider(providerId: string) {
  if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
    void invoke('remove_s3_provider_config', { providerId }).then((saved) => {
      cachedProviders = (saved as LocalS3Provider[]).map(normalizeProvider)
      window.dispatchEvent(new Event('tie:s3-providers-changed'))
    })
    if (cachedProviders) cachedProviders = cachedProviders.filter((provider) => provider.id !== providerId)
  } else {
    void persistProviders(loadLocalS3Providers().filter((provider) => provider.id !== providerId))
  }
}

export async function removeS3ProviderAsync(providerId: string) {
  if (await isTauri()) {
    cachedProviders = (await invoke<LocalS3Provider[]>('remove_s3_provider_config', { providerId })).map(normalizeProvider)
  } else {
    await persistProviders(loadLocalS3Providers().filter((provider) => provider.id !== providerId))
  }
  window.dispatchEvent(new Event('tie:s3-providers-changed'))
}

export function getS3Provider(providerId: string) {
  return loadLocalS3Providers().find((provider) => provider.id === providerId) ?? null
}

export function s3SourceId(providerId: string) { return `s3:${providerId}` }

export function isS3SourceId(sourceId: string) { return sourceId.startsWith('s3:') }

export { isBackendManagedS3SourceId } from '@/services/backend'

export function s3StorageSource(provider: LocalS3Provider): StorageSource {
  return {
    id: s3SourceId(provider.id),
    name: provider.name,
    kind: 's3',
    path: `${provider.endpoint}/${provider.bucket}`,
    available: Boolean(provider.credentialStored),
  }
}

export function providerForS3Source(sourceId: string) {
  const providerId = sourceId.slice('s3:'.length)
  return getS3Provider(providerId)
}

export function s3ConnectionForSource(sourceId: string) {
  const provider = providerForS3Source(sourceId)
  if (!provider) throw new Error('未找到 S3 连接配置')
  if (!provider.credentialStored) throw new Error('未找到 S3 本机密钥，请重新保存该连接')
  return {
    providerId: provider.id,
    endpoint: provider.endpoint,
    bucket: provider.bucket,
    region: provider.region,
  }
}

export function createStableS3ProviderId(endpoint: string, bucket: string) {
  return s3ProviderIdFromEndpointBucket(endpoint, bucket)
}

export function shouldMigrateS3ProviderId(provider: Pick<LocalS3Provider, 'id' | 'endpoint' | 'bucket'>) {
  const stable = s3ProviderIdFromEndpointBucket(provider.endpoint, provider.bucket)
  return provider.id !== stable || looksLikeLegacyS3ProviderId(provider.id)
}
