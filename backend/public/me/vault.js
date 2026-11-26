export function mountVault(container, { api, esc, workspaces, tokens, isActive }) {
  const root = document.createElement('section')
  root.className = 'vault'
  container.appendChild(root)
  let disposed = false
  let loadVersion = 0
  let secrets = []
  const active = () => !disposed && root.isConnected && isActive()
  const workspaceOptions = workspaces.map((item) => `<option value="${esc(item.id)}">${esc(item.name)}</option>`).join('')
  root.innerHTML = `
    <h2>凭据库</h2>
    <p class="lead">填写名称和密钥即可保存；需要 Agent 执行操作时再配置授权。Agent 只能查找说明，不能读取密钥原文。</p>
    <form class="toolbar" id="vault-search">
      <label>凭据库工作区<select name="workspaceId" required>${workspaceOptions}</select></label>
      <label>搜索凭据说明<input name="query" placeholder="名称、服务、环境或标签"></label>
      <button type="submit" class="ghost">搜索</button>
      <button type="button" class="primary" id="vault-create" ${workspaces.length ? '' : 'disabled'}>新增凭据</button>
    </form>
    <p class="hint vault-notice" id="vault-notice" role="status"></p>
    <div class="table-wrap"><table aria-label="凭据列表">
      <thead><tr><th>凭据</th><th>服务与环境</th><th>固定操作</th><th>管理</th></tr></thead>
      <tbody id="vault-secrets"></tbody>
    </table></div>
    <section class="vault-section"><h3>操作授权</h3>
      <p class="hint">授权绑定具体凭据版本和调用者。编辑凭据后需要重新授权。</p>
      <div class="table-wrap"><table aria-label="凭据授权"><thead><tr><th>凭据与调用者</th><th>有效期</th><th>使用次数</th><th>状态</th><th></th></tr></thead><tbody id="vault-grants"></tbody></table></div>
    </section>
    <section class="vault-section"><h3>使用记录</h3>
      <form class="toolbar" id="vault-usage-filter"><label>记录中的凭据<select name="secretRef"><option value="">全部凭据</option></select></label><button class="ghost" type="submit">刷新记录</button></form>
      <div class="table-wrap"><table aria-label="凭据使用记录"><thead><tr><th>时间</th><th>凭据与调用者</th><th>结果</th></tr></thead><tbody id="vault-usage"></tbody></table></div>
    </section>`
  const search = root.querySelector('#vault-search')
  const usageFilter = root.querySelector('#vault-usage-filter')
  const selectedWorkspace = () => search.elements.workspaceId.value
  function feedback(message, error = false) {
    if (!active()) return
    const notice = root.querySelector('#vault-notice')
    notice.classList.toggle('error', error)
    notice.textContent = message
  }
  function principalLabel(principal) {
    if (!principal) return '未识别调用者'
    if (principal.type === 'session') return `登录会话 · ${principal.id.slice(0, 8)}`
    return tokens.find((token) => token.id === principal.id)?.name || `MCP 令牌 · ${principal.id}`
  }
  function grantStatus(grant) {
    if (grant.revokedAt) return '已撤销'
    if (Date.parse(grant.expiresAt) <= Date.now()) return '已过期'
    if (grant.maxUses !== null && grant.useCount >= grant.maxUses) return '已用尽'
    const secret = secrets.find((item) => item.secretRef === grant.secretRef)
    if (secret && secret.version !== grant.version) return '凭据已更新'
    return '已授权'
  }
  function renderGrants(grants) {
    root.querySelector('#vault-grants').innerHTML = grants.length ? grants.map((grant) => `
      <tr><td><code>${esc(grant.secretRef)}</code><div class="hint">${esc(principalLabel(grant.principal))}</div><div class="hint">授权 ID：${esc(grant.id)}</div></td>
      <td>${esc(new Date(grant.expiresAt).toLocaleString())}</td><td>${esc(grant.useCount)} / ${grant.maxUses === null ? '持续' : esc(grant.maxUses)}</td>
      <td>${esc(grantStatus(grant))}</td><td>${grant.revokedAt ? '' : `<button class="danger" type="button" data-revoke-grant="${esc(grant.id)}">撤销授权</button>`}</td></tr>`).join('')
      : '<tr><td colspan="5" class="empty">还没有操作授权</td></tr>'
    root.querySelectorAll('[data-revoke-grant]').forEach((button) => {
      button.onclick = async () => {
        button.disabled = true
        try {
          await api(`/api/v1/me/secret-grants/${encodeURIComponent(button.dataset.revokeGrant)}`, { method: 'DELETE' })
          if (!active()) return
          await load()
          feedback('已撤销授权。')
        } catch (error) { feedback(error.message, true) }
        finally { button.disabled = false }
      }
    })
  }
  function renderUsage(records) {
    const statusNames = { started: '执行中', succeeded: '成功', failed: '失败', denied: '拒绝' }
    root.querySelector('#vault-usage').innerHTML = records.length ? records.map((record) => `
      <tr><td>${esc(new Date(record.at).toLocaleString())}</td><td><code>${esc(record.secretRef || '未识别凭据')}</code><div class="hint">${esc(principalLabel(record.principal))}</div>
      ${record.action ? `<div class="hint">${esc(record.action.method)} ${esc(record.action.origin)}</div>` : ''}
      ${record.version !== undefined ? `<div class="hint">凭据版本：${esc(record.version)}</div>` : ''}
      ${record.grantId ? `<div class="hint">授权 ID：${esc(record.grantId)}</div>` : ''}</td>
      <td>${esc(statusNames[record.status] || record.status)}${record.httpStatus ? ` · HTTP ${esc(record.httpStatus)}` : ''}<div class="hint">${esc(record.reason || '')}</div></td></tr>`).join('')
      : '<tr><td colspan="3" class="empty">还没有使用记录</td></tr>'
  }
  function renderSecrets() {
    root.querySelector('#vault-secrets').innerHTML = secrets.length ? secrets.map((secret) => `
      <tr data-secret-id="${esc(secret.id)}"><td><strong>${esc(secret.name)}</strong><div class="hint">${esc(secret.description)}</div><code>${esc(secret.secretRef)}</code><div class="hint">${esc(secret.tags.join(' · '))}</div></td>
      <td>${esc(secret.service)}<div class="hint">${esc(secret.environment)}</div></td><td>${secret.action ? `${esc(secret.action.method)}<div class="hint">${esc(secret.action.origin)}</div>` : '<span class="hint">仅保存</span>'}</td>
      <td><div class="token-actions">${[['details', '详情与授权'], ['view', '查看密钥'], ['copy', '复制密钥'], ['edit', '编辑'], ['delete', '删除']].map(([action, label]) => `<button type="button" class="${action === 'delete' ? 'danger' : 'ghost'}" data-vault-action="${action}" aria-label="${label} ${esc(secret.name)}">${label}</button>`).join('')}</div>
      <code class="vault-value" data-vault-value hidden></code><p class="hint" data-vault-feedback role="status"></p></td></tr>`).join('')
      : '<tr><td colspan="4" class="empty">没有匹配的凭据</td></tr>'
    const previousRef = usageFilter.elements.secretRef.value
    usageFilter.elements.secretRef.innerHTML = '<option value="">全部凭据</option>' + secrets.map((secret) => `<option value="${esc(secret.secretRef)}">${esc(secret.name)}</option>`).join('')
    usageFilter.elements.secretRef.value = secrets.some((secret) => secret.secretRef === previousRef) ? previousRef : ''
    root.querySelectorAll('[data-vault-action]').forEach((button) => {
      button.onclick = async () => {
        const row = button.closest('[data-secret-id]')
        const secret = secrets.find((item) => item.id === row.dataset.secretId)
        const action = button.dataset.vaultAction
        const valueElement = row.querySelector('[data-vault-value]')
        const notice = row.querySelector('[data-vault-feedback]')
        if (action === 'view' && !valueElement.hidden) {
          valueElement.textContent = ''
          valueElement.hidden = true
          button.textContent = '查看密钥'
          button.setAttribute('aria-label', `查看密钥 ${secret.name}`)
          return
        }
        button.disabled = true
        notice.textContent = ''
        try {
          const path = `/api/v1/me/secrets/${encodeURIComponent(secret.id)}`
          if (action === 'view' || action === 'copy') {
            const result = await api(`${path}/value`, { cache: 'no-store' })
            if (!active() || !row.isConnected) return
            if (action === 'view') {
              valueElement.textContent = result.value
              valueElement.hidden = false
              button.textContent = '隐藏密钥'
              button.setAttribute('aria-label', `隐藏密钥 ${secret.name}`)
            } else {
              await navigator.clipboard.writeText(result.value)
              notice.textContent = '密钥已复制。'
            }
          } else if (action === 'delete') {
            if (!window.confirm(`删除凭据“${secret.name}”？相关授权将无法继续使用。`)) return
            await api(path, { method: 'DELETE' })
            if (active()) { await load(); feedback('已删除凭据。') }
          } else {
            const [detail, sessions] = await Promise.all([
              api(path, { cache: 'no-store' }),
              action === 'details' ? api('/api/v1/me/secret-sessions', { cache: 'no-store' }) : Promise.resolve([]),
            ])
            if (!active() || !row.isConnected) return
            if (action === 'edit') openEditor(detail)
            else openGrant(detail, sessions)
          }
        } catch (error) { if (active() && row.isConnected) notice.textContent = error.message }
        finally { button.disabled = false }
      }
    })
  }
  async function load() {
    const version = ++loadVersion
    if (!selectedWorkspace()) { feedback('请先创建工作区。'); return }
    feedback('正在读取凭据库…')
    const query = new URLSearchParams({ workspaceId: selectedWorkspace(), query: search.elements.query.value })
    const workspaceQuery = new URLSearchParams({ workspaceId: selectedWorkspace() })
    const usageQuery = new URLSearchParams({ workspaceId: selectedWorkspace(), limit: '50' })
    if (usageFilter.elements.secretRef.value) usageQuery.set('secretRef', usageFilter.elements.secretRef.value)
    const [items, grants, usage] = await Promise.all([
      api(`/api/v1/me/secrets?${query}`, { cache: 'no-store' }),
      api(`/api/v1/me/secret-grants?${workspaceQuery}`, { cache: 'no-store' }),
      api(`/api/v1/me/secret-usage?${usageQuery}`, { cache: 'no-store' }),
    ])
    if (!active() || loadVersion !== version) return
    secrets = items
    renderSecrets()
    renderGrants(grants)
    renderUsage(usage)
    feedback('')
  }
  function openDialog(title, content) {
    const dialog = document.createElement('dialog')
    dialog.className = 'vault-dialog'
    dialog.setAttribute('aria-label', title)
    dialog.innerHTML = `<div class="vault-dialog-body"><div class="vault-close"><h3>${esc(title)}</h3><button class="ghost" type="button" data-close-dialog>关闭</button></div>${content}</div>`
    root.appendChild(dialog)
    dialog.querySelector('[data-close-dialog]').onclick = () => dialog.close()
    dialog.onclose = () => { dialog.querySelector('form')?.reset(); dialog.remove() }
    dialog.showModal()
    return dialog
  }
  function openEditor(secret = null, configureAction = false) {
    const target = secret?.target || { url: '', method: 'GET', authType: 'bearer' }
    const dialog = openDialog(secret ? '编辑凭据' : '新增凭据', `
      <form id="vault-editor">
        <label>名称<input name="name" required value="${esc(secret?.name || '')}"></label>
        <label>说明<textarea name="description" rows="2">${esc(secret?.description || '')}</textarea></label>
        <div class="split"><label>服务<input name="service" value="${esc(secret?.service || '')}" placeholder="例如 GitHub"></label><label>环境<input name="environment" value="${esc(secret?.environment || '')}" placeholder="例如 production"></label></div>
        <label>标签<input name="tags" value="${esc(secret?.tags.join(', ') || '')}" placeholder="用逗号分隔"></label>
        <label>密钥${secret ? '（留空保留）' : ''}<input name="value" type="password" autocomplete="new-password" ${secret ? '' : 'required'}></label>
        <button class="ghost" type="button" id="vault-toggle-value">显示输入</button>
        <label class="vault-action-toggle"><input name="configureAction" type="checkbox"${secret?.target || configureAction ? ' checked' : ''}> 允许 Agent 执行固定 HTTP 操作</label>
        <fieldset data-action-fields>
        <label>固定 HTTP 地址<input name="url" type="url" pattern="https://.+" title="仅支持 HTTPS 地址" required value="${esc(target.url)}" placeholder="https://api.example.com/status"></label>
        <p class="hint">授权后 Agent 不能更改目标地址、方法和请求内容。密钥请填写在密钥字段中。</p>
        <div class="split"><label>HTTP 方法<select name="method">${['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].map((value) => `<option${target.method === value ? ' selected' : ''}>${value}</option>`).join('')}</select></label>
        <label>认证方式<select name="authType"><option value="bearer"${target.authType === 'bearer' ? ' selected' : ''}>Bearer</option><option value="header"${target.authType === 'header' ? ' selected' : ''}>自定义请求头</option><option value="basic"${target.authType === 'basic' ? ' selected' : ''}>Basic</option></select></label></div>
        <label data-header-name>请求头名称<input name="headerName" value="${esc(target.headerName || '')}" placeholder="例如 X-API-Key"></label>
        <label data-username>Basic 用户名（可留空）<input name="username" value="${esc(target.username || '')}" autocomplete="off"></label>
        <label>固定请求内容（可选，GET / HEAD 不发送）<textarea name="body" rows="3">${esc(target.body || '')}</textarea></label>
        <label>允许返回的字段（每行一个）<textarea name="responseFields" rows="3" placeholder="status\ndata.id">${esc((target.responseFields || []).join('\n'))}</textarea></label>
        <p class="hint">默认仅返回 HTTP 状态。可选字段支持点分路径，仅返回标量并脱敏；只为可信服务开放，脱敏无法识别所有变形内容。</p>
        </fieldset>
        <p class="error" data-form-error role="status"></p><div class="vault-form-actions"><button type="submit" class="primary">保存凭据</button></div>
      </form>`)
    const form = dialog.querySelector('form')
    const updateAuthFields = () => {
      const type = form.elements.authType.value
      dialog.querySelector('[data-header-name]').hidden = type !== 'header'
      dialog.querySelector('[data-username]').hidden = type !== 'basic'
      form.elements.headerName.required = type === 'header'
    }
    form.elements.authType.onchange = updateAuthFields
    updateAuthFields()
    const updateBodyField = () => { form.elements.body.disabled = ['GET', 'HEAD'].includes(form.elements.method.value) }
    form.elements.method.onchange = updateBodyField
    updateBodyField()
    const updateActionFields = () => {
      const enabled = form.elements.configureAction.checked
      const fields = dialog.querySelector('[data-action-fields]')
      fields.hidden = !enabled
      fields.disabled = !enabled
    }
    form.elements.configureAction.onchange = updateActionFields
    updateActionFields()
    dialog.querySelector('#vault-toggle-value').onclick = (event) => {
      const showing = form.elements.value.type === 'password'
      form.elements.value.type = showing ? 'text' : 'password'
      event.currentTarget.textContent = showing ? '隐藏输入' : '显示输入'
    }
    form.onsubmit = async (event) => {
      event.preventDefault()
      const data = new FormData(form)
      const value = String(data.get('value'))
      const authType = String(data.get('authType'))
      const target = {
        url: String(data.get('url')), method: String(data.get('method')), authType,
        responseFields: String(data.get('responseFields')).split(/\r?\n/).map((field) => field.trim()).filter(Boolean),
      }
      if (authType === 'header') target.headerName = String(data.get('headerName'))
      if (authType === 'basic') target.username = String(data.get('username'))
      if (data.get('body')) target.body = String(data.get('body'))
      const payload = {
        name: String(data.get('name')), description: String(data.get('description')),
        service: String(data.get('service')), environment: String(data.get('environment')),
        tags: String(data.get('tags')).split(/[,，]/).map((tag) => tag.trim()).filter(Boolean),
        target: form.elements.configureAction.checked ? target : null,
      }
      if (!secret) payload.workspaceId = selectedWorkspace()
      if (!secret || value !== '') payload.value = value
      const button = form.querySelector('button[type="submit"]')
      button.disabled = true
      try {
        await api(secret ? `/api/v1/me/secrets/${encodeURIComponent(secret.id)}` : '/api/v1/me/secrets', { method: secret ? 'PUT' : 'POST', json: payload })
        form.elements.value.value = ''
        if (!active() || !dialog.isConnected) return
        dialog.close()
        await load()
        feedback(secret ? '已保存凭据，原有授权已失效；需要使用时请重新授权。' : '已保存凭据。')
      } catch (error) { if (active() && dialog.isConnected) form.querySelector('[data-form-error]').textContent = error.message }
      finally { button.disabled = false }
    }
  }
  function openGrant(secret, sessions) {
    const target = secret.target
    if (!target) {
      const dialog = openDialog(`详情与授权 · ${secret.name}`, `
        <p>${esc(secret.description)}</p><p><code>${esc(secret.secretRef)}</code> · 版本 ${esc(secret.version)}</p>
        <p>此凭据目前仅用于保存。需要 Agent 使用时，在这里配置固定操作并授权。</p>
        <button type="button" class="primary" data-configure-action>配置 Agent 操作</button>`)
      dialog.querySelector('[data-configure-action]').onclick = () => { dialog.close(); openEditor(secret, true) }
      return
    }
    const eligibleTokens = tokens.filter((token) => token.workspaceId === secret.workspaceId)
    const dialog = openDialog(`详情与授权 · ${secret.name}`, `
      <p>${esc(secret.description)}</p><p><code>${esc(secret.secretRef)}</code> · 版本 ${esc(secret.version)}</p>
      <div class="vault-detail-target"><strong>${esc(target.method)} ${esc(target.url)}</strong>
        <p>认证：${esc(target.authType)}${target.headerName ? ` · ${esc(target.headerName)}` : ''}${target.username ? ` · ${esc(target.username)}` : ''}</p>
        ${target.body ? `<p>固定请求内容：</p><pre>${esc(target.body)}</pre>` : ''}
        <p>允许返回：${target.responseFields?.length ? esc(target.responseFields.join('、')) : '仅 HTTP 状态'}</p>
      </div>
      <form id="vault-grant-form"><label>授权给<select name="principal"><option value="session:current">当前登录会话</option>${sessions.filter((session) => !session.current).map((session) => `<option value="session:${esc(session.id)}">登录会话 · ${esc(session.id.slice(0, 12))} · 到期 ${esc(new Date(session.expiresAt).toLocaleString())}</option>`).join('')}${eligibleTokens.map((token) => `<option value="mcp-token:${esc(token.id)}">MCP 令牌 · ${esc(token.name)}</option>`).join('')}</select></label>
        <p class="hint" id="vault-principal-id">当前登录会话</p>
        <div class="split"><label>有效期<select name="ttl"><option value="1">1 小时</option><option value="24">24 小时</option><option value="168">7 天</option></select></label>
        <label>使用次数<select name="uses"><option value="1">仅一次</option><option value="continuous">有效期内持续</option></select></label></div>
        <p class="hint">仅允许上述固定操作；授权不会把密钥交给 Agent。MCP 令牌需要属于此工作区。</p>
        <p class="hint">一次授权在发送请求前消耗，失败也不会返还或自动重试；需要重试时请重新授权。</p>
        <p class="error" data-form-error role="status"></p><div class="vault-form-actions"><button type="submit" class="primary">授权此操作</button></div>
      </form>`)
    const form = dialog.querySelector('form')
    form.elements.principal.onchange = () => {
      const selected = form.elements.principal.value
      dialog.querySelector('#vault-principal-id').textContent = selected === 'session:current'
        ? '当前登录会话' : `调用者 ID：${selected.slice(selected.indexOf(':') + 1)}`
    }
    form.onsubmit = async (event) => {
      event.preventDefault()
      const data = new FormData(form)
      const selected = String(data.get('principal'))
      const separator = selected.indexOf(':')
      const payload = {
        principal: { type: selected.slice(0, separator), id: selected.slice(separator + 1) },
        expiresAt: new Date(Date.now() + Number(data.get('ttl')) * 3_600_000).toISOString(),
        maxUses: data.get('uses') === '1' ? 1 : null,
      }
      const button = form.querySelector('button[type="submit"]')
      button.disabled = true
      try {
        await api(`/api/v1/me/secrets/${encodeURIComponent(secret.id)}/grants`, { method: 'POST', json: payload })
        if (!active() || !dialog.isConnected) return
        dialog.close()
        await load()
        feedback('已创建授权。Agent 可通过凭据引用执行获准的操作。')
      } catch (error) { if (active() && dialog.isConnected) form.querySelector('[data-form-error]').textContent = error.message }
      finally { button.disabled = false }
    }
  }
  root.querySelector('#vault-create').onclick = () => openEditor()
  search.onsubmit = (event) => { event.preventDefault(); void load().catch((error) => feedback(error.message, true)) }
  search.elements.workspaceId.onchange = () => {
    root.querySelectorAll('dialog').forEach((dialog) => dialog.close())
    secrets = []
    for (const id of ['vault-secrets', 'vault-grants', 'vault-usage']) root.querySelector(`#${id}`).replaceChildren()
    usageFilter.elements.secretRef.innerHTML = '<option value="">全部凭据</option>'
    void load().catch((error) => feedback(error.message, true))
  }
  usageFilter.onsubmit = (event) => { event.preventDefault(); void load().catch((error) => feedback(error.message, true)) }
  void load().catch((error) => feedback(error.message, true))
  return () => {
    disposed = true
    loadVersion += 1
    root.querySelectorAll('dialog').forEach((dialog) => dialog.close())
    root.replaceChildren()
    root.remove()
    secrets = []
  }
}
