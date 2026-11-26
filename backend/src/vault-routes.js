import express from 'express'
import * as vault from './vault.js'
import { store } from './store.js'

export function mountVault(app, { auth }) {
  const router = express.Router()
  router.use((req, _res, next) => /^\/(secrets|secret-grants|secret-usage|secret-sessions)(\/|$)/.test(req.path) ? next() : next('router'))
  router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next() })
  router.use(auth)
  router.use((req, res, next) => {
    const session = store.loadSessions().find(item => item.id === req.user.sid && item.userId === req.user.sub)
    if (!session || session.revokedAt || !(Date.parse(session.expiresAt) > Date.now())) {
      return res.status(401).json({ code: 'VAULT_SESSION_REQUIRED', message: '凭据管理需要有效登录会话，请重新登录' })
    }
    next()
  })

  router.get('/secrets', (req, res) => res.json(vault.listSecrets(req.user.sub, req.query)))
  router.post('/secrets', (req, res) => res.status(201).json(vault.createSecret(req.user.sub, req.body)))
  router.get('/secrets/:secretId', (req, res) => res.json(vault.getSecret(req.user.sub, req.params.secretId)))
  router.put('/secrets/:secretId', (req, res) => res.json(vault.updateSecret(req.user.sub, req.params.secretId, req.body)))
  router.delete('/secrets/:secretId', (req, res) => {
    vault.deleteSecret(req.user.sub, req.params.secretId)
    res.status(204).end()
  })
  router.get('/secrets/:secretId/value', (req, res) => res.json({ value: vault.revealSecret(req.user.sub, req.params.secretId) }))
  router.post('/secrets/:secretId/grants', (req, res) => {
    const input = { ...req.body }
    if (input.principal?.type === 'session' && input.principal.id === 'current') {
      input.principal = { type: 'session', id: req.user.sid }
    }
    res.status(201).json(vault.createGrant(req.user.sub, req.params.secretId, input))
  })
  router.get('/secret-grants', (req, res) => res.json(vault.listGrants(req.user.sub, req.query)))
  router.delete('/secret-grants/:grantId', (req, res) => {
    vault.revokeGrant(req.user.sub, req.params.grantId)
    res.status(204).end()
  })
  router.get('/secret-usage', (req, res) => res.json(vault.listUsage(req.user.sub, req.query)))
  router.get('/secret-sessions', (req, res) => res.json(store.loadSessions()
    .filter(item => item.userId === req.user.sub && !item.revokedAt && Date.parse(item.expiresAt) > Date.now())
    .map(item => ({ id: item.id, expiresAt: item.expiresAt, current: item.id === req.user.sid }))))

  router.use((error, _req, res, _next) => {
    const status = error.status || 500
    res.status(status).json({ code: error.code || 'VAULT_ERROR', message: status >= 500 ? '凭据服务暂时不可用' : error.message })
  })
  app.use('/api/v1/me', router)
}
