import { beforeEach, describe, expect, it, vi } from 'vitest'
import { backendService, defaultBackendEndpoint, localBackendEndpoint } from '@/services/backend'

describe('backend endpoint choice', () => {
  const memory = new Map<string, string>()

  beforeEach(() => {
    memory.clear()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => memory.get(key) ?? null,
      setItem: (key: string, value: string) => { memory.set(key, value) },
      removeItem: (key: string) => { memory.delete(key) },
      clear: () => { memory.clear() },
    })
  })

  it('moves the built-in localhost default to the published server once', () => {
    memory.set('tie-backend-servers-v1', JSON.stringify([
      { id: 'default-local', endpoint: localBackendEndpoint, defaultPrompt: false },
    ]))
    expect(backendService.loadServers()[0]?.endpoint).toBe(defaultBackendEndpoint)
    backendService.updateServer('default-local', localBackendEndpoint)
    expect(backendService.loadServers()[0]?.endpoint).toBe(localBackendEndpoint)
  })

  it('keeps a separately chosen local server', () => {
    memory.set('tie-backend-servers-v1', JSON.stringify([
      { id: 'custom-local', endpoint: localBackendEndpoint, defaultPrompt: false },
    ]))
    expect(backendService.loadServers()[0]?.endpoint).toBe(localBackendEndpoint)
    expect(backendService.loadServers()[0]?.endpoint).toBe(localBackendEndpoint)
  })

  it('keeps a saved local login', () => {
    memory.set('tie-backend-profile-v1', JSON.stringify({
      endpoint: localBackendEndpoint,
      accessToken: 'token',
      user: { id: 'usr_local', email: 'local@tie.dev', name: '本机' },
    }))
    expect(backendService.loadProfile().endpoint).toBe(localBackendEndpoint)
    expect(backendService.loadProfile().user?.email).toBe('local@tie.dev')
  })
})
