import { afterEach, expect, it, vi } from 'vitest'
import { startAutoSync } from './auto-sync'

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

it('syncs immediately, retries failures, reacts to online, and cleans up', async () => {
  vi.useFakeTimers()
  const surface = new EventTarget()
  vi.stubGlobal('window', surface)
  vi.stubGlobal('navigator', { onLine: true })
  const run = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined)
  const error = vi.fn()
  const stop = startAutoSync(run, error)
  await vi.advanceTimersByTimeAsync(0)
  expect(error).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(30_000)
  expect(run).toHaveBeenCalledTimes(2)
  surface.dispatchEvent(new Event('online'))
  await vi.advanceTimersByTimeAsync(0)
  expect(run).toHaveBeenCalledTimes(3)
  stop()
  surface.dispatchEvent(new Event('focus'))
  await vi.advanceTimersByTimeAsync(60_000)
  expect(run).toHaveBeenCalledTimes(3)
})

it('does not overlap runs or start while offline', async () => {
  vi.useFakeTimers()
  const surface = new EventTarget()
  const network = { onLine: false }
  vi.stubGlobal('window', surface)
  vi.stubGlobal('navigator', network)
  let finish!: () => void
  const run = vi.fn(() => new Promise<void>((resolve) => { finish = resolve }))
  const stop = startAutoSync(run, vi.fn())
  expect(run).not.toHaveBeenCalled()
  network.onLine = true
  surface.dispatchEvent(new Event('online'))
  surface.dispatchEvent(new Event('focus'))
  await vi.advanceTimersByTimeAsync(60_000)
  expect(run).toHaveBeenCalledTimes(1)
  finish()
  await vi.advanceTimersByTimeAsync(30_000)
  expect(run).toHaveBeenCalledTimes(2)
  stop()
  finish()
})
