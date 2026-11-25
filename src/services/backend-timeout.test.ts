import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { backendService, BackendRequestError, fetchBackendJsonWithTimeout, type BackendProfile } from './backend'
import { useBackendStore } from '@/stores/backend'

const endpoint = 'https://backend.example.test'

function profile(): BackendProfile {
  return {
    endpoint,
    accessToken: 'test-access',
    refreshToken: 'test-refresh',
    accessExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    user: { id: 'user_test', email: 'test@example.test', name: 'Test', createdAt: '' },
  }
}

describe('backend read deadlines', () => {
  const storage = new Map<string, string>()

  beforeEach(() => {
    vi.useFakeTimers()
    setActivePinia(createPinia())
    storage.clear()
    vi.stubGlobal('window', undefined)
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value) },
      removeItem: (key: string) => { storage.delete(key) },
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('returns normal JSON and clears the timer and caller abort listener', async () => {
    const caller = new AbortController()
    const remove = vi.spyOn(caller.signal, 'removeEventListener')
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await fetchBackendJsonWithTimeout<{ ok: boolean }>(`${endpoint}/health`, {
      signal: caller.signal, headers: { accept: 'application/json' },
    })

    expect(result.body).toEqual({ ok: true })
    expect(fetchMock.mock.calls[0]?.[1].headers).toEqual({ accept: 'application/json' })
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
    expect(vi.getTimerCount()).toBe(0)
  })

  it('aborts a pending health request after ten seconds', async () => {
    let signal: AbortSignal | undefined
    vi.stubGlobal('fetch', vi.fn((_url, options: RequestInit) => {
      signal = options.signal as AbortSignal
      return new Promise<Response>(() => {})
    }))
    const pending = backendService.health(endpoint)
    const rejected = expect(pending).rejects.toMatchObject({ status: 0, message: '后台响应超时，请稍后重试' })
    await vi.advanceTimersByTimeAsync(9_999)
    expect(signal?.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await rejected
    expect(signal?.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps the deadline active while the JSON body is stalled', async () => {
    let signal: AbortSignal | undefined
    vi.stubGlobal('fetch', vi.fn((_url, options: RequestInit) => {
      signal = options.signal as AbortSignal
      return Promise.resolve({ status: 200, ok: true, json: () => new Promise(() => {}) } as Response)
    }))

    const pending = backendService.me(profile())
    const rejected = expect(pending).rejects.toBeInstanceOf(BackendRequestError)
    await vi.advanceTimersByTimeAsync(10_000)
    await rejected
    expect(signal?.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('respects caller cancellation and removes its deadline', async () => {
    const caller = new AbortController()
    const reason = new Error('cancelled by caller')
    const remove = vi.spyOn(caller.signal, 'removeEventListener')
    let requestSignal: AbortSignal | undefined
    vi.stubGlobal('fetch', vi.fn((_url, options: RequestInit) => {
      requestSignal = options.signal as AbortSignal
      return new Promise<Response>(() => {})
    }))
    const pending = fetchBackendJsonWithTimeout(`${endpoint}/health`, { signal: caller.signal })
    const rejected = expect(pending).rejects.toBe(reason)
    caller.abort(reason)
    await rejected
    expect(requestSignal?.aborted).toBe(true)
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not start a request that the caller already cancelled', async () => {
    const caller = new AbortController()
    caller.abort()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(fetchBackendJsonWithTimeout(`${endpoint}/health`, { signal: caller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['timeout', 'network failure'])('retains a saved login after %s during account verification', async (failure) => {
    const saved = profile()
    storage.set('tie-backend-profile-v1', JSON.stringify(saved))
    vi.stubGlobal('fetch', failure === 'timeout'
      ? vi.fn(() => new Promise<Response>(() => {}))
      : vi.fn().mockRejectedValue(new TypeError('network failed')))
    const store = useBackendStore()
    const initializing = store.initialize()
    if (failure === 'timeout') await vi.advanceTimersByTimeAsync(10_000)
    await initializing
    expect(store.connected).toBe(true)
    expect(store.profile.accessToken).toBe(saved.accessToken)
    expect(store.profile.refreshToken).toBe(saved.refreshToken)
    expect(JSON.parse(storage.get('tie-backend-profile-v1')!)).toEqual(saved)
    expect(store.loading).toBe(false)
    expect(store.error).toBe('暂时无法确认登录，将自动重试')
  })

  it('marks a pending native session restore as loading and retains the profile if it fails', async () => {
    const saved = profile()
    storage.set('tie-backend-profile-v1', JSON.stringify(saved))
    let rejectRestore!: (reason: unknown) => void
    vi.spyOn(backendService, 'readSession').mockImplementation(() => new Promise((_resolve, reject) => { rejectRestore = reject }))
    const store = useBackendStore()
    const initializing = store.initialize()
    expect(store.loading).toBe(true)
    expect(store.profile).toEqual(saved)

    rejectRestore(new Error('native session restore unavailable'))
    await initializing
    expect(store.loading).toBe(false)
    expect(store.connected).toBe(true)
    expect(store.profile).toEqual(saved)
    expect(store.error).toBe('暂时无法确认登录，将自动重试')
    expect(JSON.parse(storage.get('tie-backend-profile-v1')!)).toEqual(saved)
  })

  it('clears the loading flag when there is no saved session', async () => {
    vi.spyOn(backendService, 'readSession').mockResolvedValue({
      endpoint, accessToken: null, refreshToken: null, accessExpiresAt: null, user: null,
    })
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const store = useBackendStore()
    const initializing = store.initialize()
    expect(store.loading).toBe(true)
    await initializing
    expect(store.loading).toBe(false)
    expect(store.connected).toBe(false)
    expect(store.error).toBe('')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('leaves write requests outside the read deadline', async () => {
    let complete!: (response: Response) => void
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => { complete = resolve }))
    vi.stubGlobal('fetch', fetchMock)
    const pending = backendService.createWorkspace(profile(), 'New workspace')
    let settled = false
    void pending.then(() => { settled = true })
    await vi.advanceTimersByTimeAsync(30_000)
    expect(settled).toBe(false)
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: 'POST' })
    expect(vi.getTimerCount()).toBe(0)
    complete(Response.json({ id: 'workspace_test', name: 'New workspace' }))
    await expect(pending).resolves.toMatchObject({ id: 'workspace_test' })
  })
})
