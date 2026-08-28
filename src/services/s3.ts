import { invoke } from '@tauri-apps/api/core'
import type { StorageSource } from '@/types'

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

let cachedProviders: LocalS3Provider[] | null = null

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
      cachedProviders = (await invoke<LocalS3Provider[]>('load_s3_providers')).map(normalizeProvider)
    } else {
      cachedProviders = readLegacyProviders()
    }
  } catch (error) {
    console.warn('S3 Provider 加载失败，将使用本地缓存', error)
    cachedProviders = readLegacyProviders()
  }
  window.dispatchEvent(new Event('tie:s3-providers-changed'))
  return cachedProviders ?? []
}

async function persistProviders(providers: LocalS3Provider[]) {
  cachedProviders = providers.map(normalizeProvider)
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
  const providers = loadLocalS3Providers()
  const index = providers.findIndex((item) => item.id === provider.id)
  const next = normalizeProvider(provider)
  if (index === -1) providers.push(next)
  else providers[index] = next
  if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
    void invoke('upsert_s3_provider', { provider: next }).then((saved) => {
      cachedProviders = (saved as LocalS3Provider[]).map(normalizeProvider)
      window.dispatchEvent(new Event('tie:s3-providers-changed'))
    })
    cachedProviders = providers
  } else {
    void persistProviders(providers)
  }
}

export async function upsertS3ProviderAsync(provider: LocalS3Provider) {
  const next = normalizeProvider(provider)
  if (await isTauri()) {
    cachedProviders = (await invoke<LocalS3Provider[]>('upsert_s3_provider', { provider: next })).map(normalizeProvider)
  } else {
    const providers = loadLocalS3Providers()
    const index = providers.findIndex((item) => item.id === next.id)
    if (index === -1) providers.push(next)
    else providers[index] = next
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
