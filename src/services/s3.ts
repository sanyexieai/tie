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

export function loadLocalS3Providers(): LocalS3Provider[] {
  try {
    const raw = JSON.parse(localStorage.getItem(LOCAL_S3_PROVIDERS_KEY) ?? '[]') as unknown
    return Array.isArray(raw) ? raw.filter((item): item is LocalS3Provider => Boolean(
      item && typeof item === 'object'
      && typeof (item as LocalS3Provider).id === 'string'
      && typeof (item as LocalS3Provider).endpoint === 'string'
      && typeof (item as LocalS3Provider).bucket === 'string',
    )) : []
  } catch { return [] }
}

export function s3SourceId(providerId: string) { return `s3:${providerId}` }

export function isS3SourceId(sourceId: string) { return sourceId.startsWith('s3:') }

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
  return loadLocalS3Providers().find((provider) => provider.id === providerId) ?? null
}
