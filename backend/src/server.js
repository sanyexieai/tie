import { createApp } from './app.js'
import { assertProductionReady, resolveBindHost, resolveJwtSecret } from './config.js'

const port = Number(process.env.PORT ?? 8787)
const jwtSecret = resolveJwtSecret()
assertProductionReady({ jwtSecret })
const host = resolveBindHost()

createApp({ jwtSecret }).listen(port, host, () => {
  console.log(`Tie backend listening on http://${host}:${port}`)
})
