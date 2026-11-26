const tokenKey = 'tie.me.token'
const loginEl = document.querySelector('#login')
const shellEl = document.querySelector('#shell')
const mainEl = document.querySelector('#main')
const loginError = document.querySelector('#login-error')
const state = { token: '', refreshToken: '', me: null }

function readSavedSession() {
  const raw = sessionStorage.getItem(tokenKey) || ''
  if (!raw) return
  if (raw.startsWith('{')) {
    try {
      const saved = JSON.parse(raw)
      state.token = saved.accessToken || ''
      state.refreshToken = saved.refreshToken || ''
      return
    } catch { /* 旧的纯令牌继续用 */ }
  }
  state.token = raw
}

function rememberSession(session) {
  state.token = session.accessToken || ''
  state.refreshToken = session.refreshToken || state.refreshToken
  sessionStorage.setItem(tokenKey, JSON.stringify({
    accessToken: state.token,
    refreshToken: state.refreshToken,
  }))
}

readSavedSession()

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]))
}

async function api(pathname, options = {}) {
  const headers = { accept: 'application/json' }
  if (state.token) headers.authorization = `Bearer ${state.token}`
  if (options.json !== undefined) headers['content-type'] = 'application/json'
  const response = await fetch(pathname, {
    method: options.method || 'GET',
    headers,
    body: options.json !== undefined ? JSON.stringify(options.json) : undefined,
    cache: options.cache,
  })
  if (response.status === 204) return null
  const payload = await response.json().catch(() => ({}))
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
    const error = new Error(payload.message || `请求失败（${response.status}）`)
    error.status = response.status
    throw error
  }
  return payload
}

function showLogin(message = '') {
  shellEl.classList.remove('on')
  mainEl.replaceChildren()
  loginEl.style.display = ''
  loginError.textContent = message
}

function showShell() {
  loginEl.style.display = 'none'
  shellEl.classList.add('on')
  document.querySelector('#who').textContent = `${state.me.name} · ${state.me.email}${state.me.role === 'admin' ? ' · 管理员' : ''}`
  document.querySelector('#admin-link').hidden = state.me.role !== 'admin'
}

async function render() {
  const [workspaces, tokens, health] = await Promise.all([
    api('/api/v1/workspaces'),
    api('/api/v1/me/mcp-tokens'),
    fetch('/health').then((response) => response.json()),
  ])
  const mcpOn = Boolean(health.mcp?.enabled)
  const ordered = [...workspaces].sort((a, b) => Number(Boolean(b.default)) - Number(Boolean(a.default)))
  const workspaceOptions = ordered.map((item) => `<option value="${esc(item.id)}">${esc(item.name)}</option>`).join('')
  const workspaceCards = ordered.map((workspace) => {
    return `<article class="panel"><h3>${esc(workspace.name)}${workspace.default ? ' <span class="tag">默认</span>' : ''}</h3><p class="hint">${esc(workspace.id)}</p><h4>存储方式</h4><p>服务器磁盘</p><p class="hint">页面存在这台服务器上。HTTP MCP 和各端同步读写的是同一份目录。</p></article>`
  }).join('')
  const tokenRows = tokens.length ? tokens.map((item) => `
    <tr>
      <td>${esc(item.name)}<div class="hint">${esc(item.workspaceId)}</div></td>
      <td>${esc(item.createdAt?.replace('T', ' ').slice(0, 19) || '')}<div class="hint">${item.lastUsedAt ? `最近使用 ${esc(item.lastUsedAt.replace('T', ' ').slice(0, 19))}` : '尚未使用'}</div></td>
      <td class="mcp-token-actions">
        <div class="token-actions">
          ${item.canReveal ? `<button data-view-token="${esc(item.id)}" type="button">查看</button><button data-copy-token="${esc(item.id)}" type="button">复制</button>` : '<span class="hint">旧令牌无法恢复，请重新签发；原授权仍有效。</span>'}
          <button class="danger" data-revoke="${esc(item.id)}" type="button">作废</button>
        </div>
        <code data-token-secret hidden></code><p class="hint" data-token-feedback role="status"></p>
      </td>
    </tr>`).join('') : '<tr><td colspan="3" class="empty">还没有 MCP 令牌</td></tr>'
  mainEl.innerHTML = `
    <h2>工作区</h2>
    <p class="lead">注册后已有默认工作区，页面保存在这台服务器的磁盘上。</p>
    <p class="lead">${mcpOn ? `MCP 地址是 ${esc(health.mcp.url || location.origin + '/mcp')}。在下方查看和复制本人签发的令牌。` : '管理员还没有打开 HTTP MCP。令牌可以先签发，打开之后再用。'}</p>
    <div id="issued"></div>
    <form id="workspace" class="toolbar">
      <input name="name" placeholder="再新建一个工作区" required>
      <button class="primary" type="submit">新建</button>
    </form>
    <div class="stack">${workspaceCards}</div>
    <h3>MCP 令牌</h3>
    <form id="token" class="toolbar">
      <input name="name" placeholder="令牌名称，例如 我的 Agent">
      <select name="workspaceId">${workspaceOptions}</select>
      <button class="primary" type="submit">签发</button>
    </form>
    <p id="token-notice" class="hint" role="status"></p>
    <div class="table-wrap"><table>
      <thead><tr><th>令牌</th><th>签发时间</th><th></th></tr></thead>
      <tbody>${tokenRows}</tbody>
    </table></div>`
  document.querySelector('#workspace').onsubmit = async (event) => {
    event.preventDefault()
    const name = new FormData(event.currentTarget).get('name')
    await api('/api/v1/workspaces', { method: 'POST', json: { name } })
    await render()
  }
  document.querySelector('#token').onsubmit = async (event) => {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const button = event.currentTarget.querySelector('button[type="submit"]')
    button.disabled = true
    try {
      const created = await api('/api/v1/me/mcp-tokens', {
        method: 'POST',
        json: { name: data.get('name'), workspaceId: data.get('workspaceId') },
      })
      await render()
      const box = document.querySelector('#issued')
      if (box) box.innerHTML = `<div class="notice">已签发新令牌：<code>${esc(created.token)}</code><p class="hint">刷新后可在令牌列表中查看和复制。</p></div>`
    } catch (error) {
      document.querySelector('#token-notice').textContent = error.message
    } finally { button.disabled = false }
  }
  mainEl.querySelectorAll('[data-view-token], [data-copy-token]').forEach((button) => {
    button.onclick = async () => {
      const row = button.closest('tr')
      const secret = row.querySelector('[data-token-secret]')
      const feedback = row.querySelector('[data-token-feedback]')
      const viewing = Boolean(button.dataset.viewToken)
      if (viewing && !secret.hidden) {
        secret.textContent = ''
        secret.hidden = true
        button.textContent = '查看'
        feedback.textContent = ''
        return
      }
      button.disabled = true
      feedback.textContent = ''
      const account = state.me
      try {
        const tokenId = button.dataset.viewToken || button.dataset.copyToken
        const result = await api(`/api/v1/me/mcp-tokens/${encodeURIComponent(tokenId)}/secret`, { cache: 'no-store' })
        if (!state.token || state.me !== account || !row.isConnected) return
        if (viewing) {
          secret.textContent = result.token
          secret.hidden = false
          button.textContent = '隐藏'
        } else {
          await navigator.clipboard.writeText(result.token)
          feedback.textContent = '令牌已复制。'
        }
      } catch (error) {
        feedback.textContent = error.message
      } finally { button.disabled = false }
    }
  })
  mainEl.querySelectorAll('[data-revoke]').forEach((button) => {
    button.onclick = async () => {
      button.disabled = true
      try {
        await api(`/api/v1/me/mcp-tokens/${encodeURIComponent(button.dataset.revoke)}`, { method: 'DELETE' })
        await render()
      } catch (error) {
        button.closest('tr').querySelector('[data-token-feedback]').textContent = error.message
      } finally { button.disabled = false }
    }
  })
}

async function enter(session) {
  rememberSession(session)
  state.me = await api('/api/v1/me')
  showShell()
  await render()
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
  gateLead.textContent = registering ? '注册后自动登录并进入我的账号。用户名在这台服务器上唯一，留空时使用邮箱前缀。第一名用户成为管理员。' : '登录后管理自己的工作区和 MCP 令牌。'
  gateForm.querySelector('input[name="password"]').autocomplete = registering ? 'new-password' : 'current-password'
}

gateSwitch.onclick = () => setGateMode(gateMode === 'login' ? 'register' : 'login')
gateForm.onsubmit = async (event) => {
  event.preventDefault()
  loginError.textContent = ''
  const data = new FormData(gateForm)
  try {
    const result = await api(gateMode === 'register' ? '/api/v1/auth/register' : '/api/v1/auth/login', {
      method: 'POST',
      json: { email: data.get('email'), password: data.get('password'), name: data.get('name') },
    })
    await enter(result)
  } catch (error) {
    loginError.textContent = error.message
  }
}
document.querySelector('#logout').onclick = () => {
  const refreshToken = state.refreshToken
  sessionStorage.removeItem(tokenKey)
  state.token = ''
  state.refreshToken = ''
  state.me = null
  if (refreshToken) {
    void fetch('/api/v1/auth/logout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    })
  }
  showLogin()
}
if (state.token) enter({ accessToken: state.token, refreshToken: state.refreshToken }).catch((error) => showLogin(error.message))
