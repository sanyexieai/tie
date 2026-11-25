import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { refreshS3Providers, loadS3ProviderMetadata, loadLocalS3Providers, takeS3SourceIdRemap, buildS3SourceIdHealingRemap, LOCAL_S3_PROVIDERS_KEY, type LocalS3Provider } from './s3'
import { s3ProviderIdFromEndpointBucket } from './storage-identity'

const native = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }))

const provider: LocalS3Provider = {
  id: s3ProviderIdFromEndpointBucket('https://storage.example.invalid', 'knowledge'),
  name: 'Fixture',
  endpoint: 'https://storage.example.invalid',
  bucket: 'knowledge',
  credentialStored: true,
  createdAt: '2026-01-01T00:00:00.000Z',
}

beforeEach(() => {
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  })
  vi.stubGlobal('window', { __TAURI_INTERNALS__: {}, dispatchEvent: vi.fn() })
  native.invoke.mockReset()
  takeS3SourceIdRemap()
})

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

it.each([{ current: [] }, { current: [provider] }])('loads native S3 configuration once during startup: %j', async ({ current }) => {
  native.invoke.mockResolvedValue(current)
  const loaded = await refreshS3Providers({ migrateLegacy: true })
  expect(loaded).toEqual(current)
  expect(loadLocalS3Providers()).toEqual(current)
  expect(native.invoke.mock.calls).toEqual([['load_s3_providers']])
})

it('reloads canonical native configuration after importing legacy providers', async () => {
  const legacy = { ...provider, id: 'f47d9552-5349-4752-9152-f94302db5518' }
  localStorage.setItem(LOCAL_S3_PROVIDERS_KEY, JSON.stringify([legacy]))
  native.invoke.mockResolvedValueOnce([]).mockResolvedValueOnce(undefined).mockResolvedValueOnce([provider])

  const loaded = await refreshS3Providers({ migrateLegacy: true })
  expect(loaded).toEqual([provider])
  expect(loadLocalS3Providers()).toEqual([provider])
  expect(native.invoke.mock.calls).toEqual([
    ['load_s3_providers'],
    ['save_s3_providers', { providers: [legacy] }],
    ['load_s3_providers'],
  ])
  expect(localStorage.getItem(LOCAL_S3_PROVIDERS_KEY)).toBeNull()
})

it('hydrates public metadata and legacy bindings without migrating credentials or persisting remaps', async () => {
  const legacy = { ...provider, id: 'f47d9552-5349-4752-9152-f94302db5518', bucket: 'old-notes' }
  localStorage.setItem(LOCAL_S3_PROVIDERS_KEY, JSON.stringify([legacy]))
  const write = vi.spyOn(localStorage, 'setItem')
  native.invoke.mockResolvedValueOnce([provider])
  const remap = await loadS3ProviderMetadata()
  const stable = s3ProviderIdFromEndpointBucket(legacy.endpoint, legacy.bucket)
  expect(loadLocalS3Providers().map((item) => item.id)).toEqual([provider.id, stable])
  expect(remap.get(`s3:${legacy.id}`)).toBe(`s3:${stable}`)
  expect(buildS3SourceIdHealingRemap([{ storageSourceId: `s3:${legacy.id}` }]).get(`s3:${legacy.id}`)).toBe(`s3:${stable}`)
  expect(native.invoke.mock.calls).toEqual([['load_s3_provider_metadata']])
  expect(write).not.toHaveBeenCalled()
  expect(localStorage.getItem(LOCAL_S3_PROVIDERS_KEY)).not.toBeNull()
})

it('imports missing legacy providers after first paint while retaining existing native bindings', async () => {
  const legacy = { ...provider, id: 'f47d9552-5349-4752-9152-f94302db5518', bucket: 'old-notes' }
  const canonical = { ...legacy, id: s3ProviderIdFromEndpointBucket(legacy.endpoint, legacy.bucket) }
  localStorage.setItem(LOCAL_S3_PROVIDERS_KEY, JSON.stringify([legacy]))
  native.invoke.mockResolvedValueOnce([provider])
  await loadS3ProviderMetadata()
  native.invoke.mockReset()
  native.invoke.mockResolvedValueOnce([provider]).mockResolvedValueOnce(undefined).mockResolvedValueOnce([provider, canonical])
  expect(await refreshS3Providers({ migrateLegacy: true })).toEqual([provider, canonical])
  expect(native.invoke.mock.calls).toEqual([
    ['load_s3_providers'],
    ['save_s3_providers', { providers: [provider, legacy] }],
    ['load_s3_providers'],
  ])
  expect(localStorage.getItem(LOCAL_S3_PROVIDERS_KEY)).toBeNull()
  expect(JSON.parse(localStorage.getItem('tie-s3-source-id-remap-v1')!)[`s3:${legacy.id}`]).toBe(`s3:${canonical.id}`)
})
