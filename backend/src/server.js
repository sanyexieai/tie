import { createApp } from './app.js'
import { assertProductionReady, resolveBindHost, resolveJwtSecret } from './config.js'
import { attachLive } from './live.js'
const port = Number(process.env.PORT ?? 8787)
const jwtSecret = resolveJwtSecret()
assertProductionReady({ jwtSecret })
const host = resolveBindHost()

const server = createApp({ jwtSecret }).listen(port, host, () => {
  console.log(`Tie backend listening on http://${host}:${port}`)
  console.log(`Tie admin console at http://${host}:${port}/admin/`)
})
attachLive(server, jwtSecret)
