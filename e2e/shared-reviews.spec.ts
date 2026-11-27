import { expect, test } from '@playwright/test'

test('browser shares replies and withdrawal, highlights synced quotes, and refreshes changes after a save', async ({ page }) => {
  const endpoint = 'https://reviews.example.test'
  const user = { id: 'usr_review', name: 'Review Owner', email: 'review@example.test', createdAt: '' }
  const profile = { endpoint, user, accessToken: 'review-fixture-session', refreshToken: null, accessExpiresAt: null }
  const origin = { clientId: 'fixture-agent', clientName: 'Codex', clientVersion: 'test', deviceId: 'dev_other', deviceName: '另一台电脑', platform: 'linux', actor: 'Codex' }
  let document = { id: 'pg_review', title: '协作测试', markdown: '# 协作测试\n\n需要共同确认的原文。', icon: '', tags: [], parentId: null, sortKey: 0,
    createdAt: '2026-11-25T00:00:00Z', updatedAt: '2026-11-25T00:00:00Z', deletedAt: null, storageSourceId: 'backend:ws_review', storageSourceIds: ['backend:ws_review'] }
  const entries: Record<string, unknown>[] = [{ id: 'ph_synced', at: document.updatedAt, updatedAt: document.updatedAt, actor: 'Codex', origin,
    kind: 'opinion', status: 'open', opinionKind: 'objection', quote: '需要共同确认的原文。', body: '请补充结论依据。', baseUpdatedAt: document.updatedAt }]
  const actions: { path: string; body: Record<string, unknown> }[] = []
  let saveStarted = false
  let revision = 1
  let releaseSave!: () => void
  const saveGate = new Promise<void>((resolve) => { releaseSave = resolve })
  const docPath = '/api/v1/workspaces/ws_review/pages/pg_review'
  await page.addInitScript((profile) => {
    localStorage.clear()
    localStorage.setItem('tie-backend-profile-v1', JSON.stringify(profile))
  }, profile)
  await page.routeWebSocket('**/*', () => {})
  await page.route(`${endpoint}/**`, async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    const method = request.method()
    let body: unknown = []
    if (path === '/health') body = { ok: true }
    else if (path === '/api/v1/me') body = user
    else if (path === '/api/v1/workspaces') body = [{ id: 'ws_review', name: '我的工作区', default: true, ownerId: user.id }]
    else if (path === '/api/v1/workspaces/ws_review/sync/manifest') body = {
      version: 1, revision: String(revision), pages: [{ id: document.id, version: document.updatedAt }],
      reviews: [{ id: document.id, version: String(revision) }], assets: [], files: [],
    }
    else if (path === '/api/v1/workspaces/ws_review/pages') body = [document]
    else if (path === docPath + '/reviews') body = { entries }
    else if (path === docPath + '/signals' && method === 'POST') {
      const input = request.postDataJSON()
      actions.push({ path, body: input })
      revision += 1
      entries.push({ ...input, id: input.id || 'ph_reply', at: new Date().toISOString(), updatedAt: new Date().toISOString(), kind: 'opinion', status: 'open',
        actor: input.actor || user.name, origin: { ...origin, clientName: 'Tie 网页', deviceName: '浏览器', actor: input.actor || user.name } })
      body = { entries }
    } else if (path.endsWith('/signals/ph_synced/resolve') && method === 'POST') {
      const input = request.postDataJSON()
      actions.push({ path, body: input })
      revision += 1
      Object.assign(entries[0]!, input, { updatedAt: new Date().toISOString(), resolutionOrigin: origin })
      body = { entries }
    } else if (path === docPath && method === 'PUT') {
      saveStarted = true
      await saveGate
      document = request.postDataJSON()
      revision += 1
      entries.push({ id: 'ch_saved', at: document.updatedAt, actor: 'Review Owner', origin: { ...origin, clientName: 'Tie 网页', deviceName: '当前浏览器' },
        kind: 'change', status: 'recorded', type: 'update', pageId: document.id, changedFields: ['markdown'] })
      body = document
    } else if (path === docPath) body = document
    await route.fulfill({ json: body, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } })
  })
  await page.goto('/')
  await expect(page.getByRole('textbox', { name: '页面标题' })).toHaveValue('协作测试')
  await page.locator('.context-tabs').getByRole('button', { name: '变更', exact: true }).click()
  const initial = page.locator('[data-pheromone-card="ph_synced"]')
  await expect(initial).toContainText('另一台电脑')
  await expect(page.locator('.tiptap [data-pheromone-id="ph_synced"]')).toHaveText('需要共同确认的原文。')
  await expect(initial.getByRole('button', { name: '采用已保存修改', exact: true })).toBeDisabled()
  await initial.getByRole('button', { name: '回复支持', exact: true }).click()
  const draft = page.locator('.pheromone-draft')
  await draft.getByRole('combobox', { name: '来源 Agent' }).selectOption('Cursor')
  await draft.locator('textarea').fill('同意，先补依据再采用。')
  await draft.getByRole('button', { name: '留下', exact: true }).click()
  await expect(page.locator('.pheromone-card').filter({ hasText: '同意，先补依据再采用。' })).toContainText('Cursor')
  expect(actions[0]).toMatchObject({ path: docPath + '/signals', body: { replyTo: 'ph_synced', actor: 'Cursor', opinionKind: 'support', baseUpdatedAt: '2026-11-25T00:00:00Z' } })
  await initial.getByRole('button', { name: '撤回', exact: true }).click()
  await expect(initial).toHaveCount(0)
  await expect(page.locator('.tiptap [data-pheromone-id="ph_synced"]')).toHaveCount(0)
  await page.getByLabel('显示已撤回（1）').check()
  await expect(initial).toContainText('已撤回')
  expect(actions[1]).toMatchObject({ body: { status: 'withdrawn' } })

  await page.locator('.tiptap').click()
  await page.locator('.tiptap').press('Control+End')
  await page.keyboard.press('Enter')
  await page.keyboard.type('已补充结论依据。')
  await page.keyboard.press('Control+s')
  try {
    await expect.poll(() => saveStarted).toBe(true)
    await expect(page.locator('[data-change-id="ch_saved"]')).toHaveCount(0)
  } finally { releaseSave() }
  await expect(page.locator('[data-change-id="ch_saved"]')).toContainText('保存修改')
  await expect(page.locator('[data-change-id="ch_saved"]')).toContainText('当前浏览器')
  await expect(page.locator('[data-change-id="ch_saved"]')).toContainText('正文')
  await page.reload()
  await page.locator('.context-tabs').getByRole('button', { name: '变更', exact: true }).click()
  await expect(page.locator('.pheromone-card').filter({ hasText: '同意，先补依据再采用。' })).toBeVisible()
  await expect(page.locator('[data-pheromone-card="ph_synced"]')).toHaveCount(0)
})
