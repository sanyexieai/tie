/** 后台工作区变化时通知桌面端，立刻走现有的那一条同步。 */

export function startBackendLive(options: {
  endpoint: string
  token: string
  onWorkspace: (workspaceId: string) => void
}) {
  if (!options.token || !options.endpoint) return () => {}
  let stopped = false
  let socket: WebSocket | null = null
  let retryMs = 1000
  let pingTimer = 0
  const url = liveUrl(options.endpoint)

  const connect = () => {
    if (stopped) return
    let opened: WebSocket
    try {
      opened = new WebSocket(url)
    } catch {
      window.setTimeout(connect, retryMs)
      retryMs = Math.min(retryMs * 2, 15000)
      return
    }
    socket = opened
    opened.onopen = () => {
      retryMs = 1000
      opened.send(JSON.stringify({ type: 'hello', token: options.token }))
      window.clearInterval(pingTimer)
      pingTimer = window.setInterval(() => {
        if (opened.readyState === WebSocket.OPEN) opened.send(JSON.stringify({ type: 'ping' }))
      }, 25000)
    }
    opened.onmessage = (event) => {
      try {
        const message = JSON.parse(String(event.data)) as { type?: string; workspaceId?: string }
        if (message.type === 'workspace' && message.workspaceId) options.onWorkspace(message.workspaceId)
      } catch {
        // 忽略无法解析的通知
      }
    }
    opened.onclose = () => {
      window.clearInterval(pingTimer)
      if (stopped) return
      window.setTimeout(connect, retryMs)
      retryMs = Math.min(retryMs * 2, 15000)
    }
  }

  connect()
  return () => {
    stopped = true
    window.clearInterval(pingTimer)
    socket?.close()
  }
}

function liveUrl(endpoint: string) {
  const trimmed = endpoint.trim().replace(/\/$/, '')
  if (trimmed.startsWith('https://')) return `wss://${trimmed.slice('https://'.length)}/api/v1/live`
  if (trimmed.startsWith('http://')) return `ws://${trimmed.slice('http://'.length)}/api/v1/live`
  return `ws://${trimmed}/api/v1/live`
}
