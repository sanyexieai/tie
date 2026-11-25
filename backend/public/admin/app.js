const tokenKey = 'tie.admin.token'
const state = {
  token: '',
  refreshToken: '',
  me: null,
  view: 'overview',
  workspaceId: null,
  userId: null,
  pageId: null,
  userQuery: '',
  userStatus: '',
  workspaceQuery: '',
}

const loginEl = document.querySelector('#login')
const shellEl = document.querySelector('#shell')
const mainEl = document.querySelector('#main')
const loginError = document.querySelector('#login-error')
const editor = document.querySelector('#editor')
const editorForm = document.querySelector('#editor-form')
const editorFields = document.querySelector('#editor-fields')
const editorError = document.querySelector('#editor-error')

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char]))
}

function bytes(size) {
  const n = Number(size) || 0
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

async function api(pathname, options = {}) {
  const headers = new Headers(options.headers || {})
  if (state.token) headers.set('authorization', `Bearer ${state.token}`)
  let body = options.body
  if (options.json !== undefined) {
    headers.set('content-type', 'application/json')
    body = JSON.stringify(options.json)
  }
  const response = await fetch(pathname, { method: options.method || 'GET', headers, body })
  const text = await response.text()
  let payload = null
  if (text) {
    try { payload = JSON.parse(text) } catch { payload = { message: text } }
  }
  if (!response.ok) {
    if (response.status === 401 && state.refreshToken && !options.retried && pathname !== '/api/v1/auth/refresh') {
      const rotated = await fetch('/api/v1/auth/refresh', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ refreshToken: state.refreshToken }),
      })
      if (rotated.ok) {
        rememberSession(await rotated.json())
        return api(pathname, { ...options, retried: true })
      }
    }
    const error = new Error(payload?.message || `请求失败（${response.status}）`)
    error.status = response.status
    throw error
  }
  return payload
}

function showLogin(message = '') {
  state.me = null
  shellEl.classList.remove('on')
  loginEl.style.display = ''
  loginError.textContent = message
}

function showShell() {
  loginEl.style.display = 'none'
  shellEl.classList.add('on')
  document.querySelector('#who').textContent = `${state.me.name} · ${state.me.email}`
  document.querySelectorAll('.nav button').forEach((button) => {
    button.classList.toggle('on', button.dataset.view === state.view)
  })
}

function rememberSession(session) {
  if (typeof session === 'string') {
    state.token = session
    state.refreshToken = ''
  } else {
    state.token = session?.accessToken || ''
    state.refreshToken = session?.refreshToken || ''
  }
  sessionStorage.setItem(tokenKey, JSON.stringify({ accessToken: state.token, refreshToken: state.refreshToken }))
}

async function enter(session) {
  rememberSession(session)
  const me = await api('/api/v1/me')
  if (me.role !== 'admin') {
    sessionStorage.setItem('tie.me.token', JSON.stringify({
      accessToken: state.token,
      refreshToken: state.refreshToken,
    }))
    sessionStorage.removeItem(tokenKey)
    window.location.replace('/me/')
    return
  }
  state.me = me
  showShell()
  await render()
}

function openEditor(title, fields, onSubmit) {
  document.querySelector('#editor-title').textContent = title
  editorError.textContent = ''
  editorFields.innerHTML = fields.map((field) => {
    if (field.type === 'checkbox') {
      return `<label class="check"><input name="${field.name}" type="checkbox" ${field.checked ? 'checked' : ''}>${esc(field.label)}</label>`
    }
    if (field.type === 'select') {
      const options = field.options.map((option) => `<option value="${esc(option.value)}" ${option.value === field.value ? 'selected' : ''}>${esc(option.label)}</option>`).join('')
      return `<label>${esc(field.label)}<select name="${field.name}">${options}</select></label>`
    }
    return `<label>${esc(field.label)}<input name="${field.name}" type="${field.type || 'text'}" value="${esc(field.value || '')}" ${field.required ? 'required' : ''}></label>`
  }).join('')
  editorForm.onsubmit = async (event) => {
    event.preventDefault()
    const data = new FormData(editorForm)
    const value = {}
    for (const field of fields) {
      if (field.type === 'checkbox') value[field.name] = data.get(field.name) === 'on'
      else value[field.name] = String(data.get(field.name) ?? '')
    }
    editorError.textContent = ''
    try {
      await onSubmit(value)
      editor.close()
      await render()
    } catch (error) {
      editorError.textContent = error.message
    }
  }
  editor.showModal()
}

function askConfirm(message) {
  const dialog = document.querySelector('#confirm')
  document.querySelector('#confirm-message').textContent = message
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok'), { once: true })
    dialog.showModal()
  })
}

async function confirmAction(message, action) {
  if (!(await askConfirm(message))) return
  try {
    await action()
    await render()
  } catch (error) {
    window.alert(error.message)
  }
}

function openUser(userId) {
  state.view = 'users'
  state.userId = userId
  state.workspaceId = null
  state.pageId = null
  render()
}

function openWorkspace(workspaceId) {
  state.view = 'workspaces'
  state.workspaceId = workspaceId
  state.userId = null
  state.pageId = null
  render()
}

function userTags(user) {
  const role = user.role === 'admin' ? '<span class="tag admin">管理员</span>' : '<span class="tag">用户</span>'
  const stateTag = user.disabled ? '<span class="tag off">已停用</span>' : ''
  return `${role} ${stateTag}`
}

async function renderOverview() {
  const data = await api('/api/v1/admin/overview')
  const recentUsers = (data.recentUsers || []).map((user) => `
    <button class="link" data-user="${esc(user.id)}" type="button">${esc(user.name)} · ${esc(user.email)}</button>
  `).join('') || '<p class="hint">还没有用户</p>'
  const recentWorkspaces = (data.recentWorkspaces || []).map((item) => `
    <button class="link" data-open="${esc(item.id)}" type="button">${esc(item.name)} · ${esc(item.ownerEmail || '未知用户')}</button>
  `).join('') || '<p class="hint">还没有工作区</p>'
  mainEl.innerHTML = `
    <h2>概览</h2>
    <p class="lead">这台后台里的租户和数据。</p>
    <div class="cards">
      <button class="card" data-go="users" type="button"><span>用户</span><strong>${data.users}</strong></button>
      <button class="card" data-go="users" data-status="admin" type="button"><span>管理员</span><strong>${data.admins}</strong></button>
      <button class="card" data-go="users" data-status="disabled" type="button"><span>已停用</span><strong>${data.disabledUsers}</strong></button>
      <button class="card" data-go="workspaces" type="button"><span>工作区</span><strong>${data.workspaces}</strong></button>
      <div class="card"><span>在用页面</span><strong>${data.activePages ?? data.pages}</strong></div>
      <div class="card"><span>回收站页面</span><strong>${data.trashedPages ?? 0}</strong></div>
      <div class="card"><span>磁盘占用</span><strong>${bytes(data.bytes)}</strong></div>
    </div>
    <div class="split">
      <section class="panel"><h3>最近注册</h3>${recentUsers}</section>
      <section class="panel"><h3>最近的工作区</h3>${recentWorkspaces}</section>
    </div>`
  mainEl.querySelectorAll('[data-go]').forEach((button) => {
    button.onclick = () => {
      state.view = button.dataset.go
      state.userId = null
      state.workspaceId = null
      state.pageId = null
      if (button.dataset.status) state.userStatus = button.dataset.status
      else if (button.dataset.go === 'users') state.userStatus = ''
      render()
    }
  })
  mainEl.querySelectorAll('[data-user]').forEach((button) => {
    button.onclick = () => openUser(button.dataset.user)
  })
  mainEl.querySelectorAll('[data-open]').forEach((button) => {
    button.onclick = () => openWorkspace(button.dataset.open)
  })
}

async function renderUsers() {
  const query = state.userQuery
  const status = state.userStatus
  const users = await api(`/api/v1/admin/users?q=${encodeURIComponent(query)}&status=${encodeURIComponent(status)}`)
  const rows = users.length ? users.map((user) => `
    <tr>
      <td><button class="link" data-user="${esc(user.id)}" type="button">${esc(user.name)}</button><div class="hint">${esc(user.email)}</div></td>
      <td>${userTags(user)}</td>
      <td>${user.workspaceCount}</td>
      <td>${esc(user.createdAt?.slice(0, 10) || '')}</td>
      <td class="actions">
        <button class="ghost" data-edit="${esc(user.id)}">编辑</button>
        <button class="ghost" data-reset="${esc(user.id)}">重置密码</button>
        <button class="danger" data-delete="${esc(user.id)}" ${user.id === state.me.id ? 'disabled' : ''}>删除</button>
      </td>
    </tr>`).join('') : '<tr><td colspan="5" class="empty">没有符合条件的用户</td></tr>'
  mainEl.innerHTML = `
    <h2>用户</h2>
    <p class="lead">每个用户只能看到自己的工作区。停用后无法登录，已发出的令牌也会失效。</p>
    <div class="toolbar">
      <input id="user-q" placeholder="搜索邮箱或用户名" value="${esc(query)}">
      <select id="user-status">
        <option value="" ${status === '' ? 'selected' : ''}>全部</option>
        <option value="active" ${status === 'active' ? 'selected' : ''}>可用</option>
        <option value="disabled" ${status === 'disabled' ? 'selected' : ''}>已停用</option>
        <option value="admin" ${status === 'admin' ? 'selected' : ''}>管理员</option>
      </select>
      <button class="ghost" id="user-search" type="button">筛选</button>
      <button class="primary" id="user-create" type="button">新建用户</button>
    </div>
    <div class="table-wrap"><table>
      <thead><tr><th>用户</th><th>角色</th><th>工作区</th><th>创建</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`
  const applyUserFilter = () => {
    state.userQuery = document.querySelector('#user-q').value
    state.userStatus = document.querySelector('#user-status').value
    renderUsers()
  }
  document.querySelector('#user-search').onclick = applyUserFilter
  document.querySelector('#user-q').onkeydown = (event) => { if (event.key === 'Enter') applyUserFilter() }
  document.querySelector('#user-status').onchange = applyUserFilter
  mainEl.querySelectorAll('[data-user]').forEach((button) => {
    button.onclick = () => openUser(button.dataset.user)
  })
  document.querySelector('#user-create').onclick = () => openEditor('新建用户', [
    { name: 'name', label: '用户名', required: true },
    { name: 'email', label: '邮箱', type: 'email', required: true },
    { name: 'password', label: '初始密码', type: 'password', required: true },
    { name: 'role', label: '角色', type: 'select', value: 'user', options: [{ value: 'user', label: '用户' }, { value: 'admin', label: '管理员' }] },
  ], (value) => api('/api/v1/admin/users', { method: 'POST', json: value }))
  const byId = new Map(users.map((user) => [user.id, user]))
  mainEl.querySelectorAll('[data-edit]').forEach((button) => {
    button.onclick = () => {
      const user = byId.get(button.dataset.edit)
      openEditor('编辑用户', [
        { name: 'name', label: '用户名', value: user.name, required: true },
        { name: 'email', label: '邮箱', type: 'email', value: user.email, required: true },
        { name: 'role', label: '角色', type: 'select', value: user.role, options: [{ value: 'user', label: '用户' }, { value: 'admin', label: '管理员' }] },
        { name: 'disabled', label: '停用这个账号', type: 'checkbox', checked: user.disabled },
      ], (value) => api(`/api/v1/admin/users/${user.id}`, {
        method: 'PATCH',
        json: { ...value, disabled: Boolean(value.disabled), role: value.role },
      }))
    }
  })
  mainEl.querySelectorAll('[data-reset]').forEach((button) => {
    button.onclick = () => {
      const user = byId.get(button.dataset.reset)
      openEditor(`重置密码 · ${user.email}`, [
        { name: 'password', label: '新密码', type: 'password', required: true },
      ], (value) => api(`/api/v1/admin/users/${user.id}`, { method: 'PATCH', json: { password: value.password } }))
    }
  })
  mainEl.querySelectorAll('[data-delete]').forEach((button) => {
    button.onclick = () => {
      const user = byId.get(button.dataset.delete)
      confirmAction(`删除 ${user.email} 及其工作区？此操作不能撤销。`, () => api(`/api/v1/admin/users/${user.id}`, { method: 'DELETE' }))
    }
  })
}

async function renderUserDetail() {
  const user = await api(`/api/v1/admin/users/${state.userId}`)
  const rows = user.workspaces.length ? user.workspaces.map((item) => `
    <tr>
      <td><button class="link" data-open="${esc(item.id)}" type="button">${esc(item.name)}</button><div class="hint">${esc(item.id)}</div></td>
      <td class="path">${esc(item.serverPath || '')}</td>
      <td>${item.activePageCount} 在用 / ${item.trashedPageCount} 回收站</td>
      <td>${bytes(item.bytes)}</td>
    </tr>`).join('') : '<tr><td colspan="4" class="empty">这个用户还没有工作区</td></tr>'
  mainEl.innerHTML = `
    <button class="ghost back" id="back" type="button">返回用户列表</button>
    <h2>${esc(user.name)}</h2>
    <p class="lead">${esc(user.email)} · ${userTags(user)} · ${esc(user.createdAt?.slice(0, 10) || '')}</p>
    <div class="toolbar">
      <button class="ghost" id="edit" type="button">编辑</button>
      <button class="ghost" id="reset" type="button">重置密码</button>
      <button class="ghost" id="toggle" type="button" ${user.id === state.me.id ? 'disabled' : ''}>${user.disabled ? '恢复使用' : '停用'}</button>
      <button class="primary" id="create-ws" type="button">新建工作区</button>
      <button class="danger" id="delete" type="button" ${user.id === state.me.id ? 'disabled' : ''}>删除用户</button>
    </div>
    <div class="table-wrap"><table>
      <thead><tr><th>工作区</th><th>服务器路径</th><th>页面</th><th>占用</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`
  document.querySelector('#back').onclick = () => { state.userId = null; render() }
  document.querySelector('#edit').onclick = () => openEditor('编辑用户', [
    { name: 'name', label: '用户名', value: user.name, required: true },
    { name: 'email', label: '邮箱', type: 'email', value: user.email, required: true },
    { name: 'role', label: '角色', type: 'select', value: user.role, options: [{ value: 'user', label: '用户' }, { value: 'admin', label: '管理员' }] },
    { name: 'disabled', label: '停用这个账号', type: 'checkbox', checked: user.disabled },
  ], (value) => api(`/api/v1/admin/users/${user.id}`, {
    method: 'PATCH',
    json: { ...value, disabled: Boolean(value.disabled), role: value.role },
  }))
  document.querySelector('#reset').onclick = () => openEditor(`重置密码 · ${user.email}`, [
    { name: 'password', label: '新密码', type: 'password', required: true },
  ], (value) => api(`/api/v1/admin/users/${user.id}`, { method: 'PATCH', json: { password: value.password } }))
  document.querySelector('#toggle').onclick = () => api(`/api/v1/admin/users/${user.id}`, {
    method: 'PATCH',
    json: { disabled: !user.disabled },
  }).then(() => render()).catch((error) => window.alert(error.message))
  document.querySelector('#create-ws').onclick = () => openEditor('为该用户新建工作区', [
    { name: 'name', label: '工作区名称', required: true },
  ], (value) => api('/api/v1/admin/workspaces', { method: 'POST', json: { name: value.name, ownerId: user.id } }))
  document.querySelector('#delete').onclick = () => confirmAction(
    `删除 ${user.email} 及其工作区？此操作不能撤销。`,
    async () => {
      await api(`/api/v1/admin/users/${user.id}`, { method: 'DELETE' })
      state.userId = null
    },
  )
  mainEl.querySelectorAll('[data-open]').forEach((button) => {
    button.onclick = () => openWorkspace(button.dataset.open)
  })
}

async function renderWorkspaces() {
  const query = state.workspaceQuery
  const [items, users] = await Promise.all([
    api(`/api/v1/admin/workspaces?q=${encodeURIComponent(query)}`),
    api('/api/v1/admin/users'),
  ])
  const rows = items.length ? items.map((item) => `
    <tr>
      <td><button class="link" data-open="${esc(item.id)}" type="button">${esc(item.name)}</button><div class="hint">${esc(item.id)}</div></td>
      <td><button class="link" data-user="${esc(item.ownerId)}" type="button">${esc(item.ownerName || '未知')}</button><div class="hint">${esc(item.ownerEmail || item.ownerId)}</div></td>
      <td class="path">${esc(item.serverPath || '')}</td>
      <td>服务器磁盘</td>
      <td>${item.activePageCount} / ${item.trashedPageCount}</td>
      <td>${bytes(item.bytes)}</td>
      <td class="actions">
        <button class="danger" data-delete="${esc(item.id)}">删除</button>
      </td>
    </tr>`).join('') : '<tr><td colspan="7" class="empty">没有符合条件的工作区</td></tr>'
  mainEl.innerHTML = `
    <h2>数据</h2>
    <p class="lead">每个工作区都属于一个用户，页面都在服务器磁盘上。删除会清掉该目录里的页面。</p>
    <div class="toolbar">
      <input id="ws-q" placeholder="搜索名称、用户或 id" value="${esc(query)}">
      <button class="ghost" id="ws-search" type="button">搜索</button>
      <button class="primary" id="ws-create" type="button">新建工作区</button>
    </div>
    <div class="table-wrap"><table>
      <thead><tr><th>工作区</th><th>所属用户</th><th>服务器路径</th><th>存储方式</th><th>页面</th><th>占用</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`
  const applyWorkspaceFilter = () => {
    state.workspaceQuery = document.querySelector('#ws-q').value
    renderWorkspaces()
  }
  document.querySelector('#ws-search').onclick = applyWorkspaceFilter
  document.querySelector('#ws-q').onkeydown = (event) => { if (event.key === 'Enter') applyWorkspaceFilter() }
  document.querySelector('#ws-create').onclick = () => openEditor('新建工作区', [
    { name: 'name', label: '名称', required: true },
    {
      name: 'ownerId',
      label: '所属用户',
      type: 'select',
      value: users.find((user) => !user.disabled)?.id || '',
      options: users.filter((user) => !user.disabled).map((user) => ({ value: user.id, label: `${user.name} · ${user.email}` })),
    },
  ], (value) => api('/api/v1/admin/workspaces', { method: 'POST', json: value }))
  const byId = new Map(items.map((item) => [item.id, item]))
  mainEl.querySelectorAll('[data-open]').forEach((button) => {
    button.onclick = () => openWorkspace(button.dataset.open)
  })
  mainEl.querySelectorAll('[data-user]').forEach((button) => {
    button.onclick = () => openUser(button.dataset.user)
  })
  mainEl.querySelectorAll('[data-delete]').forEach((button) => {
    button.onclick = () => {
      const item = byId.get(button.dataset.delete)
      confirmAction(`删除工作区「${item.name}」？`, () => api(`/api/v1/admin/workspaces/${item.id}`, { method: 'DELETE' }))
    }
  })
}

async function renderWorkspaceDetail() {
  const item = await api(`/api/v1/admin/workspaces/${state.workspaceId}`)
  const rows = item.pages.length ? item.pages.map((page) => `
    <tr>
      <td><button class="link" data-read="${esc(page.id)}" type="button">${esc(page.title)}</button>${page.deletedAt ? ' <span class="tag off">回收站</span>' : ''}<div class="hint">${esc(page.id)}</div></td>
      <td>${esc((page.tags || []).join('、'))}</td>
      <td>${esc(page.updatedAt?.replace('T', ' ').slice(0, 19) || '')}</td>
      <td class="actions">
        ${page.deletedAt ? `<button class="ghost" data-restore="${esc(page.id)}">恢复</button>` : ''}
        <button class="danger" data-page="${esc(page.id)}">彻底删除</button>
      </td>
    </tr>`).join('') : '<tr><td colspan="4" class="empty">这个工作区还没有页面</td></tr>'
  mainEl.innerHTML = `
    <button class="ghost back" id="back" type="button">返回工作区列表</button>
    <h2>${esc(item.name)}</h2>
    <p class="lead">所属用户 ${esc(item.ownerName || '未知')} · ${esc(item.ownerEmail || item.ownerId)} · 在用 ${item.activePageCount} · 回收站 ${item.trashedPageCount} · ${bytes(item.bytes)}</p>
    <p class="path-line">服务器路径 ${esc(item.serverPath || '')}</p>
    <p class="lead">存储方式 服务器磁盘</p>
    ${item.notice ? `<div class="notice">${esc(item.notice)}</div>` : ''}
    <div class="toolbar">
      <button class="ghost" id="rename" type="button">重命名</button>
      <button class="ghost" id="transfer" type="button">转移给其他用户</button>
    </div>
    <div class="table-wrap"><table>
      <thead><tr><th>页面</th><th>标签</th><th>更新</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`
  document.querySelector('#back').onclick = () => { state.workspaceId = null; state.pageId = null; render() }
  document.querySelector('#rename').onclick = () => openEditor('重命名工作区', [
    { name: 'name', label: '名称', value: item.name, required: true },
  ], (value) => api(`/api/v1/admin/workspaces/${item.id}`, { method: 'PATCH', json: value }))
  const owners = await api('/api/v1/admin/users?status=active')
  document.querySelector('#transfer').onclick = () => openEditor('转移工作区', [
    {
      name: 'ownerId',
      label: '新的所属用户',
      type: 'select',
      value: item.ownerId,
      options: owners.map((user) => ({ value: user.id, label: `${user.name} · ${user.email}` })),
    },
  ], (value) => api(`/api/v1/admin/workspaces/${item.id}`, { method: 'PATCH', json: { ownerId: value.ownerId } }))
  mainEl.querySelectorAll('[data-read]').forEach((button) => {
    button.onclick = () => { state.pageId = button.dataset.read; render() }
  })
  mainEl.querySelectorAll('[data-restore]').forEach((button) => {
    button.onclick = () => api(`/api/v1/admin/workspaces/${item.id}/pages/${button.dataset.restore}/restore`, { method: 'POST' })
      .then(() => render())
      .catch((error) => window.alert(error.message))
  })
  mainEl.querySelectorAll('[data-page]').forEach((button) => {
    button.onclick = () => confirmAction('彻底删除这个页面？磁盘上的正文和历史都会去掉。', () => api(`/api/v1/admin/workspaces/${item.id}/pages/${button.dataset.page}`, { method: 'DELETE' }))
  })
}

async function renderPage() {
  const page = await api(`/api/v1/admin/workspaces/${state.workspaceId}/pages/${state.pageId}`)
  mainEl.innerHTML = `
    <button class="ghost back" id="back" type="button">返回页面列表</button>
    <h2>${esc(page.title)}</h2>
    <p class="lead">${esc(page.id)} · ${esc((page.tags || []).join('、'))} · ${esc(page.updatedAt?.replace('T', ' ').slice(0, 19) || '')}${page.deletedAt ? ' · 在回收站' : ''}</p>
    <div class="toolbar">
      ${page.deletedAt ? '<button class="ghost" id="restore" type="button">恢复</button>' : ''}
      <button class="danger" id="delete" type="button">彻底删除</button>
    </div>
    <pre class="preview">${esc(page.markdown || '')}</pre>`
  document.querySelector('#back').onclick = () => { state.pageId = null; render() }
  document.querySelector('#restore')?.addEventListener('click', () => {
    api(`/api/v1/admin/workspaces/${state.workspaceId}/pages/${state.pageId}/restore`, { method: 'POST' })
      .then(() => render())
      .catch((error) => window.alert(error.message))
  })
  document.querySelector('#delete').onclick = () => confirmAction('彻底删除这个页面？', async () => {
    await api(`/api/v1/admin/workspaces/${state.workspaceId}/pages/${state.pageId}`, { method: 'DELETE' })
    state.pageId = null
  })
}

async function renderSettings() {
  const settings = await api('/api/v1/admin/settings')
  mainEl.innerHTML = `
    <h2>服务</h2>
    <p class="lead">这些能力存在这台后台的数据里。进程怎么监听、数据目录和登录签名密钥仍由启动环境决定，因为后台还没起来时读不到数据库。</p>
    <form id="settings" class="panel">
      <h3>MCP</h3>
      <p class="hint">打开后，用户在「我的账号」里选择自己的工作区并签发令牌。调用走 Rust 的 tie-cli mcp，不再启动 Node 网关。</p>
      <label class="check"><input name="mcpEnabled" type="checkbox" ${settings.mcp.enabled ? 'checked' : ''}>开启 HTTP MCP</label>
      <label>tie-cli 路径<input name="cliPath" value="${esc(settings.mcp.cliPath || '')}" placeholder="${esc(settings.mcp.resolvedCli || '留空则自动查找 tie-cli')}"></label>
      <p class="${settings.mcp.cliOk ? 'hint' : 'error'}">${settings.mcp.cliOk ? `将使用 ${esc(settings.mcp.resolvedCli)}` : esc(settings.mcp.cliError || '还没有可用的 tie-cli')}</p>
      <h3>标签建议</h3>
      <p class="hint">不填密钥时只用正文里的标题和已有标签。密钥只保存在服务器上，这里不会再显示出来。</p>
      <label>接口地址<input name="baseUrl" value="${esc(settings.ai.baseUrl)}"></label>
      <label>模型<input name="model" value="${esc(settings.ai.model)}"></label>
      <label>API Key<input name="apiKey" type="password" autocomplete="new-password" placeholder="${settings.ai.hasApiKey ? '已保存，留空则不修改' : '可选'}"></label>
      <label class="check"><input name="clearKey" type="checkbox">清除已保存的 API Key</label>
      <div class="toolbar"><button class="primary" type="submit">保存</button></div>
      <p class="error" id="settings-error"></p>
    </form>`
  document.querySelector('#settings').onsubmit = async (event) => {
    event.preventDefault()
    const form = event.currentTarget
    const data = new FormData(form)
    const errorEl = document.querySelector('#settings-error')
    errorEl.textContent = ''
    const json = {
      mcp: { enabled: data.get('mcpEnabled') === 'on', cliPath: String(data.get('cliPath') ?? '') },
      ai: { baseUrl: String(data.get('baseUrl') ?? ''), model: String(data.get('model') ?? '') },
    }
    if (data.get('clearKey') === 'on') json.ai.apiKey = ''
    else if (String(data.get('apiKey') ?? '')) json.ai.apiKey = String(data.get('apiKey'))
    try {
      await api('/api/v1/admin/settings', { method: 'PUT', json })
      await renderSettings()
    } catch (error) {
      errorEl.textContent = error.message
    }
  }
}

async function render() {
  showShell()
  try {
    if (state.view === 'overview') await renderOverview()
    else if (state.view === 'users' && state.userId) await renderUserDetail()
    else if (state.view === 'users') await renderUsers()
    else if (state.view === 'workspaces' && state.workspaceId && state.pageId) await renderPage()
    else if (state.view === 'workspaces' && state.workspaceId) await renderWorkspaceDetail()
    else if (state.view === 'workspaces' || state.view === 'providers') await renderWorkspaces()
    else if (state.view === 'settings') await renderSettings()
  } catch (error) {
    if (error.status === 401 || error.status === 403) {
      sessionStorage.removeItem(tokenKey)
      state.token = ''
      showLogin(error.message)
      return
    }
    mainEl.innerHTML = `<h2>无法加载</h2><p class="error">${esc(error.message)}</p>`
  }
}

const gateForm = document.querySelector('#login-form')
const nameField = document.querySelector('#name-field')
const gateSubmit = document.querySelector('#gate-submit')
const gateSwitch = document.querySelector('#gate-switch')
const gateLead = document.querySelector('#gate-lead')
let gateMode = 'login'

function setAccountField(registering) {
  const label = document.querySelector('#account-field span')
  const input = document.querySelector('#account-field input')
  label.textContent = registering ? '邮箱' : '用户名或邮箱'
  input.type = registering ? 'email' : 'text'
  input.autocomplete = registering ? 'email' : 'username'
  input.placeholder = registering ? 'name@example.com' : '用户名或 name@example.com'
}

function setGateMode(mode) {
  gateMode = mode
  const registering = mode === 'register'
  nameField.hidden = !registering
  setAccountField(registering)
  gateSubmit.textContent = registering ? '注册并登录' : '登录'
  gateSwitch.textContent = registering ? '已有账号？登录' : '没有账号？注册'
  gateLead.textContent = registering
    ? '注册后自动登录。用户名在这台服务器上唯一，留空时使用邮箱前缀。第一名用户成为管理员。'
    : '管理员进入管理后台，普通用户自动进入我的账号。'
  gateForm.querySelector('input[name="password"]').autocomplete = registering ? 'new-password' : 'current-password'
}

gateSwitch.onclick = () => {
  loginError.textContent = ''
  setGateMode(gateMode === 'login' ? 'register' : 'login')
}

gateForm.onsubmit = async (event) => {
  event.preventDefault()
  loginError.textContent = ''
  const data = new FormData(event.currentTarget)
  const email = data.get('email')
  const password = data.get('password')
  try {
    const result = gateMode === 'register'
      ? await api('/api/v1/auth/register', {
        method: 'POST',
        json: { email, password, name: data.get('name') },
      })
      : await api('/api/v1/auth/login', {
        method: 'POST',
        json: { email, password },
      })
    await enter(result)
  } catch (error) {
    loginError.textContent = error.message
  }
}

document.querySelectorAll('.nav button').forEach((button) => {
  button.onclick = () => {
    state.view = button.dataset.view
    state.workspaceId = null
    state.userId = null
    state.pageId = null
    render()
  }
})

document.querySelector('#logout').onclick = () => {
  const refreshToken = state.refreshToken
  sessionStorage.removeItem(tokenKey)
  state.token = ''
  state.refreshToken = ''
  if (refreshToken) {
    void fetch('/api/v1/auth/logout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    })
  }
  showLogin()
}

document.querySelector('#editor-cancel').onclick = () => editor.close()

const savedRaw = sessionStorage.getItem(tokenKey)
let saved = null
if (savedRaw?.startsWith('{')) {
  try { saved = JSON.parse(savedRaw) } catch { saved = savedRaw }
} else if (savedRaw) saved = savedRaw
if (saved) enter(saved).catch((error) => showLogin(error.message))
else showLogin()
