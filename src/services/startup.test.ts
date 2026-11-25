import { expect, it, vi } from 'vitest'
import { initializeWorkspaceStartup } from './startup'

function deferred() {
  let resolve!: () => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

function start(tasks: Omit<Parameters<typeof initializeWorkspaceStartup>[0], 'afterFirstPaint' | 'initializeBackground' | 'onBackgroundError'>) {
  return initializeWorkspaceStartup({
    afterFirstPaint: async () => undefined,
    initializeBackground: async () => undefined,
    onBackgroundError: vi.fn(),
    ...tasks,
  })
}

it('opens native files without waiting for a pending server initialization', async () => {
  const local = deferred()
  const remote = deferred()
  const order: string[] = []
  const startup = start({
    localFirst: true,
    initializeWorkspace: () => { order.push('local'); return local.promise },
    initializeBackend: () => { order.push('remote'); return remote.promise },
    onBackendError: vi.fn(),
  })

  expect(order).toEqual(['local'])
  local.resolve()
  await startup
  expect(order).toEqual(['local', 'remote'])
  remote.resolve()
})

it('handles a background server failure after opening native files', async () => {
  const remote = deferred()
  const failed = vi.fn()
  await start({
    localFirst: true,
    initializeWorkspace: async () => undefined,
    initializeBackend: () => remote.promise,
    onBackendError: failed,
  })

  const error = new Error('offline')
  remote.reject(error)
  await Promise.resolve()
  expect(failed).toHaveBeenCalledExactlyOnceWith(error)
})

it('restores the browser account before opening its workspace', async () => {
  const local = deferred()
  const remote = deferred()
  const order: string[] = []
  let ready = false
  const startup = start({
    localFirst: false,
    initializeWorkspace: () => { order.push('workspace'); return local.promise },
    initializeBackend: () => { order.push('account'); return remote.promise },
    onBackendError: vi.fn(),
  }).then(() => { ready = true })

  expect(order).toEqual(['account'])
  remote.resolve()
  await Promise.resolve()
  expect(order).toEqual(['account', 'workspace'])
  expect(ready).toBe(false)
  local.resolve()
  await startup
  expect(ready).toBe(true)
})

it('does not open the browser demo when account restoration fails', async () => {
  const openWorkspace = vi.fn()
  const failed = vi.fn()
  const error = new Error('account restoration failed')
  await expect(start({
    localFirst: false,
    initializeWorkspace: openWorkspace,
    initializeBackend: async () => { throw error },
    onBackendError: failed,
  })).rejects.toBe(error)
  expect(openWorkspace).not.toHaveBeenCalled()
  expect(failed).not.toHaveBeenCalled()
})

it('waits for the first painted frame before starting independent background tasks', async () => {
  const paint = deferred()
  const credentials = deferred()
  const backend = deferred()
  const order: string[] = []
  const startup = initializeWorkspaceStartup({
    localFirst: true,
    initializeWorkspace: async () => { order.push('local') },
    afterFirstPaint: () => { order.push('paint'); return paint.promise },
    initializeBackend: () => { order.push('backend'); return backend.promise },
    initializeBackground: () => { order.push('credentials'); return credentials.promise },
    onBackendError: vi.fn(),
    onBackgroundError: vi.fn(),
  })
  await Promise.resolve()
  expect(order).toEqual(['local', 'paint'])
  paint.resolve()
  await startup
  expect(order).toEqual(['local', 'paint', 'backend', 'credentials'])
  credentials.resolve()
  backend.resolve()
})
