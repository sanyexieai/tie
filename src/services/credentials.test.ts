import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useBackendStore } from '@/stores/backend'
import { credentialAccountKey, credentialsService } from './credentials'

beforeEach(() => {
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) })
  vi.stubGlobal('window', new EventTarget())
  setActivePinia(createPinia())
  useBackendStore().profile = { endpoint: 'https://vault.example.test', accessToken: 'test-session', refreshToken: null, accessExpiresAt: null,
    user: { id: 'usr_owner', name: 'Owner', email: 'owner@example.test', createdAt: '' } }
})
afterEach(() => { setActivePinia(undefined); vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('stores a value only through the credential endpoint and does not request plaintext while browsing metadata', async () => {
  const requests: { path: string; method: string; body?: Record<string, unknown>; cache?: RequestCache; authorization: string | null }[] = []
  const metadata = { id: 'sec_fixture', secretRef: 'secret://sec_fixture', workspaceId: 'ws_test', name: 'Private key', description: '', service: '', environment: '', tags: [], version: 1, createdAt: '', updatedAt: '', action: null }
  const value = '  first line\nsecond line\n'
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input, init) => {
    requests.push({ path: new URL(String(input)).pathname, method: init?.method || 'GET', cache: init?.cache,
      body: init?.body ? JSON.parse(String(init.body)) : undefined, authorization: new Headers(init?.headers).get('authorization') })
    return Response.json((init?.method === 'POST') ? metadata : new URL(String(input)).pathname.endsWith('/value') ? { value } : new URL(String(input)).pathname.endsWith('/sec_fixture') ? { ...metadata, target: null } : [metadata])
  }))
  await credentialsService.list('ws_test')
  await credentialsService.get(metadata.id)
  expect(requests.every((request) => !request.path.endsWith('/value'))).toBe(true)
  await credentialsService.create({ workspaceId: 'ws_test', name: metadata.name, value, target: null })
  expect(requests[2]).toMatchObject({ path: '/api/v1/me/secrets', method: 'POST', body: { value, target: null }, authorization: 'Bearer test-session' })
  expect(await credentialsService.reveal(metadata.id)).toBe(value)
  expect(requests[3]).toMatchObject({ path: '/api/v1/me/secrets/sec_fixture/value', method: 'GET' })
  expect(requests.every((request) => request.cache === 'no-store')).toBe(true)
  expect(localStorage.getItem('tie-backend-profile-v1')).toBeNull()
  expect(requests.some((request) => request.path.includes('/pages'))).toBe(false)
})

it('preserves existing values by omitting the value field on metadata edits and uses explicit authorization endpoints', async () => {
  const requests: { path: string; method: string; body?: Record<string, unknown> }[] = []
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input, init) => {
    requests.push({ path: new URL(String(input)).pathname, method: init?.method || 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined })
    return init?.method === 'DELETE' ? new Response(null, { status: 204 }) : Response.json({ id: 'fixture' })
  }))
  await credentialsService.update('sec_fixture', { name: 'Renamed', target: null })
  expect(requests[0]?.body).not.toHaveProperty('value')
  await credentialsService.createGrant('sec_fixture', { principal: { type: 'session', id: 'current' }, maxUses: 1, expiresAt: '2026-12-01T00:00:00Z' })
  await credentialsService.revokeGrant('grant_fixture')
  await credentialsService.remove('sec_fixture')
  expect(requests.map((request) => [request.method, request.path])).toEqual([
    ['PUT', '/api/v1/me/secrets/sec_fixture'], ['POST', '/api/v1/me/secrets/sec_fixture/grants'],
    ['DELETE', '/api/v1/me/secret-grants/grant_fixture'], ['DELETE', '/api/v1/me/secrets/sec_fixture'],
  ])
})

it('uses the current account and refuses requests after logout without reading stored browser credentials', async () => {
  const originalKey = credentialAccountKey()
  const fetcher = vi.fn<typeof fetch>(async () => Response.json([]))
  vi.stubGlobal('fetch', fetcher)
  const store = useBackendStore()
  store.profile = { ...store.profile, user: { ...store.profile.user!, id: 'usr_another' } }
  expect(credentialAccountKey()).not.toBe(originalKey)
  store.profile = { ...store.profile, user: null, accessToken: null }
  await expect(credentialsService.reveal('sec_fixture')).rejects.toThrow('请先登录服务器')
  expect(fetcher).not.toHaveBeenCalled()
})
