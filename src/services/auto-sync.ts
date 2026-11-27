export type AutoSyncTrigger = 'initial' | 'interval' | 'online' | 'focus'

/** The interval is a quiet change check; events can request visible synchronization. */
export function startAutoSync(run: (trigger: AutoSyncTrigger) => Promise<unknown>, onError: (error: unknown) => void, interval = 30_000) {
  let stopped = false
  let running = false
  const tick = async (trigger: AutoSyncTrigger) => {
    if (stopped || running || !navigator.onLine) return
    running = true
    try { await run(trigger) } catch (error) { onError(error) }
    finally { running = false }
  }
  const online = () => { void tick('online') }
  const focus = () => { void tick('focus') }
  const timer = setInterval(() => { void tick('interval') }, interval)
  window.addEventListener('online', online)
  window.addEventListener('focus', focus)
  void tick('initial')
  return () => {
    stopped = true
    clearInterval(timer)
    window.removeEventListener('online', online)
    window.removeEventListener('focus', focus)
  }
}
