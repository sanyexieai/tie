import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { backendService } from './backend'
import { currentBackendProfile } from './backend-profile'
import { useBackendStore } from '@/stores/backend'

beforeEach(() => {
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) })
  vi.stubGlobal('window', {})
  setActivePinia(undefined)
})
afterEach(() => { setActivePinia(undefined); vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('uses the existing current desktop session without loading credentials again', () => {
  vi.stubGlobal('window', { __TAURI_INTERNALS__: {} })
  setActivePinia(createPinia())
  const store = useBackendStore()
  store.profile = { endpoint: 'https://current.example.test', accessToken: 'active-fixture', refreshToken: null, accessExpiresAt: null,
    user: { id: 'usr_fixture', name: 'Fixture', email: 'fixture@example.test', createdAt: '' } }
  const load = vi.spyOn(backendService, 'loadProfile')
  expect(currentBackendProfile()).toBe(store.profile)
  expect(currentBackendProfile().accessToken).toBe('active-fixture')
  store.profile = { ...store.profile, accessToken: null, user: null }
  expect(currentBackendProfile().accessToken).toBeNull()
  expect(load).not.toHaveBeenCalled()
})

it('keeps the pre-store browser profile fallback without creating a Pinia store', () => {
  backendService.saveProfile({ endpoint: 'https://stored.example.test', accessToken: 'stored-fixture', refreshToken: null, accessExpiresAt: null,
    user: { id: 'usr_browser', name: 'Browser', email: 'browser@example.test', createdAt: '' } })
  expect(currentBackendProfile().accessToken).toBe('stored-fixture')
  vi.stubGlobal('window', { __TAURI_INTERNALS__: {} })
  expect(currentBackendProfile().accessToken).toBeNull()
})
