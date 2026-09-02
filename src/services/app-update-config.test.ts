import { describe, expect, it, beforeEach, vi } from 'vitest'
import {
  hasCustomUpdateEndpoints,
  loadUpdateEndpoints,
  resetUpdateEndpoints,
  saveUpdateEndpoints,
} from '@/services/app-update-config'

describe('app-update-config', () => {
  const memory = new Map<string, string>()

  beforeEach(() => {
    memory.clear()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => memory.get(key) ?? null,
      setItem: (key: string, value: string) => {
        memory.set(key, value)
      },
      removeItem: (key: string) => {
        memory.delete(key)
      },
      clear: () => {
        memory.clear()
      },
    })
  })

  it('loads defaults when unset', () => {
    expect(loadUpdateEndpoints()[0]).toContain('latest.json')
    expect(hasCustomUpdateEndpoints()).toBe(false)
  })

  it('persists custom endpoints', () => {
    saveUpdateEndpoints(['https://minio.example.com/tie/latest.json'])
    expect(hasCustomUpdateEndpoints()).toBe(true)
    expect(loadUpdateEndpoints()).toEqual(['https://minio.example.com/tie/latest.json'])
    resetUpdateEndpoints()
    expect(hasCustomUpdateEndpoints()).toBe(false)
  })
})
