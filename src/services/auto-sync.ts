/** Run immediately, on reconnect/focus, and periodically while the app is open. */
export function startAutoSync(run: () => Promise<unknown>, onError: (error: unknown) => void, interval = 30_000) {
  let stopped = false
  let running = false
  const tick = async () => {
    if (stopped || running || !navigator.onLine) return
    running = true
    try { await run() } catch (error) { onError(error) }
    finally { running = false }
  }
  const timer = setInterval(() => { void tick() }, interval)
  window.addEventListener('online', tick)
  window.addEventListener('focus', tick)
  void tick()
  return () => {
    stopped = true
    clearInterval(timer)
    window.removeEventListener('online', tick)
    window.removeEventListener('focus', tick)
  }
}
