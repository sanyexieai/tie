import { createApp } from './app.js'
import { assertProductionReady, resolveBindHost, resolveJwtSecret } from './config.js'
import { mcpEnabledFromEnv, startMcpHttp } from './mcp-http.js'

const port = Number(process.env.PORT ?? 8787)
const jwtSecret = resolveJwtSecret()
assertProductionReady({ jwtSecret })
const host = resolveBindHost()

if (mcpEnabledFromEnv()) {
  const mcp = startMcpHttp()
  if (mcp.running) console.log(`Tie MCP HTTP enabled, proxied at /mcp (upstream 127.0.0.1:${mcp.port})`)
  else console.warn(`Tie MCP HTTP 已选中但未启动：${mcp.error}`)
}

createApp({ jwtSecret }).listen(port, host, () => {
  console.log(`Tie backend listening on http://${host}:${port}`)
})
