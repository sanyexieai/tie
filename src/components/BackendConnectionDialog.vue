<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { backendService, localBackendEndpoint, type BackendMcpToken } from '@/services/backend'
import { clearTemporaryBrowserPages, pushTemporaryBrowserPages, temporaryBrowserPages } from '@/services/browser-backend'
import { isTauriDesktop } from '@/services/platform'
import { useBackendStore } from '@/stores/backend'
import { useWorkspaceStore } from '@/stores/workspace'

const emit = defineEmits<{ close: []; 'temporary-settled': [] }>()
defineProps<{ startupPrompt?: boolean; offerTemporary?: boolean }>()
const backend = useBackendStore()
const store = useWorkspaceStore()
const mode = ref<'login' | 'register'>('login')
const endpoint = ref(backend.profile.endpoint)
const selectedServerId = ref(
  backend.servers.find((item) => item.endpoint === backend.profile.endpoint)?.id
    ?? backend.servers.find((item) => item.defaultPrompt)?.id
    ?? backend.servers[0]?.id
    ?? '',
)
const newServerEndpoint = ref('')
const email = ref('')
const password = ref('')
const name = ref('')
const notice = ref('')
const pushingTemporary = ref(false)
const temporaryTick = ref(0)
const temporaryCount = computed(() => {
  void temporaryTick.value
  return temporaryBrowserPages().length
})
const advancedOpen = ref(false)
const serviceEndpoint = ref(backend.profile.endpoint)
const accountName = computed(() => backend.profile.user?.name || backend.profile.user?.email || '')
const selectedServer = computed(() => backend.servers.find((item) => item.id === selectedServerId.value) ?? null)
const mcpTokensOpen = ref(false)
const mcpTokens = ref<BackendMcpToken[]>([])
const mcpTokensBusy = ref(false)
const mcpTokensError = ref('')
const mcpTokensNotice = ref('')
const mcpTokenName = ref('')
const mcpTokenWorkspace = ref('')
const mcpAccountUrl = computed(() => `${backend.profile.endpoint.replace(/\/+$/, '')}/me/`)

async function toggleMcpTokens() {
  mcpTokensOpen.value = !mcpTokensOpen.value
  if (mcpTokensOpen.value) await loadMcpTokens()
}
async function loadMcpTokens() {
  mcpTokensBusy.value = true
  mcpTokensError.value = ''
  try {
    mcpTokens.value = await backendService.listMcpTokens(backend.profile)
    if (!backend.workspaces.some((item) => item.id === mcpTokenWorkspace.value)) {
      mcpTokenWorkspace.value = backend.workspaces.find((item) => item.default)?.id ?? backend.workspaces[0]?.id ?? ''
    }
  } catch (error) {
    mcpTokensError.value = error instanceof Error ? error.message : '无法读取 MCP 令牌'
  } finally { mcpTokensBusy.value = false }
}
async function issueMcpToken() {
  mcpTokensBusy.value = true
  mcpTokensError.value = ''
  mcpTokensNotice.value = ''
  try {
    const created = await backendService.createMcpToken(backend.profile, {
      name: mcpTokenName.value.trim(), workspaceId: mcpTokenWorkspace.value,
    })
    mcpTokens.value.push(created)
    mcpTokenName.value = ''
    mcpTokensNotice.value = '已签发。请前往“我的账号”查看和复制令牌。'
  } catch (error) {
    mcpTokensError.value = error instanceof Error ? error.message : '签发 MCP 令牌失败'
  } finally { mcpTokensBusy.value = false }
}
async function revokeMcpToken(token: BackendMcpToken) {
  mcpTokensBusy.value = true
  mcpTokensError.value = ''
  mcpTokensNotice.value = ''
  try {
    await backendService.revokeMcpToken(backend.profile, token.id)
    mcpTokens.value = mcpTokens.value.filter((item) => item.id !== token.id)
    mcpTokensNotice.value = '令牌已作废，使用它的 Agent 将无法继续连接。'
  } catch (error) {
    mcpTokensError.value = error instanceof Error ? error.message : '作废 MCP 令牌失败'
  } finally { mcpTokensBusy.value = false }
}
async function openMcpAccount(section = '') {
  try {
    const url = mcpAccountUrl.value + (section === 'vault' ? '#vault' : '')
    if (isTauriDesktop()) {
      const { openUrl } = await import('@tauri-apps/plugin-opener')
      await openUrl(url)
    } else window.open(url, '_blank', 'noopener,noreferrer')
  } catch (error) {
    mcpTokensError.value = error instanceof Error ? error.message : '无法打开我的账号'
  }
}
function tokenWorkspaceName(workspaceId: string) {
  return backend.workspaces.find((item) => item.id === workspaceId)?.name ?? workspaceId
}
function addServer() { if (!newServerEndpoint.value.trim()) return; const server = backend.addServer(newServerEndpoint.value); selectedServerId.value = server.id; endpoint.value = server.endpoint; newServerEndpoint.value = '' }
function useLocalServer() {
  const server = backend.addServer(localBackendEndpoint)
  if (server.endpoint !== localBackendEndpoint) {
    notice.value = ''
    backend.error = '没能切换到本机后台'
    return
  }
  selectServer(server.id)
  notice.value = `已选择 ${server.endpoint}`
}
onMounted(() => {
  if (!import.meta.env.DEV || backend.connected) return
  void fetch(`${localBackendEndpoint}/health`).then((response) => {
    if (!response.ok) return
    const server = backend.addServer(localBackendEndpoint)
    selectServer(server.id)
  }).catch(() => { /* 本机后台没开时仍用当前地址 */ })
})
function selectServer(id: string) { selectedServerId.value = id; endpoint.value = backend.servers.find((item) => item.id === id)?.endpoint ?? '' }
function toggleDefaultPrompt(serverId: string, enabled: boolean) { backend.setDefaultPrompt(serverId, enabled) }
function onDefaultPromptChange(serverId: string, event: Event) { toggleDefaultPrompt(serverId, (event.target as HTMLInputElement).checked) }
function dismissDefaultPrompt() { if (selectedServer.value) backend.setDefaultPrompt(selectedServer.value.id, false); backend.dismissDefaultPrompt() }

async function testConnection() {
  notice.value = ''
  try {
    await backend.checkHealth(backend.connected ? serviceEndpoint.value : endpoint.value)
    notice.value = '云服务可用。'
  } catch { /* store exposes message */ }
}
async function saveServiceEndpoint() {
  notice.value = ''
  try {
    if (!selectedServer.value) throw new Error('请先选择后台服务器')
    await backend.updateServerEndpoint(selectedServer.value.id, serviceEndpoint.value)
    endpoint.value = serviceEndpoint.value = backend.profile.endpoint
    notice.value = '后台服务设置已保存。'
  } catch { /* store exposes message */ }
}
async function syncWorkspacePages() {
  await store.reloadWorkspace()
}
async function submit() {
  notice.value = ''
  try {
    if (!selectedServer.value) throw new Error('请先选择一台服务器')
    await backend.authenticate(mode.value, selectedServer.value.endpoint, email.value.trim(), password.value, name.value.trim())
    password.value = ''
    if (!isTauriDesktop()) {
      await store.reloadWorkspace()
      notice.value = temporaryBrowserPages().length
        ? '已登录。正文以后台为准，下面可以选择是否保留浏览器里的临时页面。'
        : '已登录。文档以后台为准。'
      return
    }
    await store.syncBackendNow()
    await syncWorkspacePages()
    notice.value = '已绑定服务器，云同步已开启。'
  } catch { /* store exposes message */ }
}
async function keepBackendDocuments() {
  clearTemporaryBrowserPages()
  temporaryTick.value += 1
  await store.reloadWorkspace()
  emit('temporary-settled')
  notice.value = '已改为以后台文档为准。'
}
async function pushTemporaryDocuments() {
  pushingTemporary.value = true
  notice.value = ''
  try {
    const pages = temporaryBrowserPages()
    await pushTemporaryBrowserPages(pages)
    clearTemporaryBrowserPages()
    temporaryTick.value += 1
    await store.reloadWorkspace()
    emit('temporary-settled')
    notice.value = `已把 ${pages.length} 篇临时页面推到后台。之后以后台为准。`
  } catch (error) {
    backend.error = error instanceof Error ? error.message : '推送临时页面失败'
  } finally {
    pushingTemporary.value = false
  }
}
async function logout() {
  mcpTokensOpen.value = false
  mcpTokens.value = []
  mcpTokensNotice.value = ''
  mcpTokensError.value = ''
  backend.logout()
  await syncWorkspacePages()
}
</script>

<template>
  <div class="backend-dialog-backdrop" @mousedown.self="emit('close')">
      <section class="backend-dialog" role="dialog" aria-modal="true" aria-label="绑定服务器">
      <header><div><strong>绑定服务器</strong><small>{{ isTauriDesktop() ? '只绑定一台。绑定后进入本地 + 服务器，保存时云同步' : '只绑定一台。登录后网页上的文档以后台为准' }}</small></div><button aria-label="关闭" @click="emit('close')">×</button></header>

      <template v-if="!backend.connected">
        <div class="backend-mode-tabs"><button :class="{ selected: mode === 'login' }" @click="mode = 'login'">登录</button><button :class="{ selected: mode === 'register' }" @click="mode = 'register'">注册</button></div>
        <button type="button" class="backend-link-button" @click="useLocalServer">使用本机后台</button>
        <p class="backend-notice">当前将登录 {{ selectedServer?.endpoint || '未选择服务器' }}</p>
        <button type="button" class="backend-link-button" @click="advancedOpen = !advancedOpen">{{ advancedOpen ? '收起高级选项' : '高级选项' }}</button>
        <div v-if="advancedOpen" class="backend-advanced-settings">
          <div class="backend-server-list"><strong>服务器地址（同时只绑定一台）</strong><div v-for="server in backend.servers" :key="server.id" class="backend-server-row"><button :class="{ selected: selectedServerId === server.id }" @click="selectServer(server.id)">{{ server.endpoint }}<small v-if="server.id === 'default-local'">默认地址</small></button><label><input type="checkbox" :checked="server.defaultPrompt" @change="onDefaultPromptChange(server.id, $event)"> 启动时询问</label></div><p v-if="!backend.servers.length" class="backend-empty">请先填写服务器地址。</p></div>
          <div class="backend-add-server"><input v-model="newServerEndpoint" inputmode="url" placeholder="例如 https://example.com:32043" /><button :disabled="backend.loading || !newServerEndpoint.trim()" @click="addServer">使用这个地址</button></div>
          <button class="backend-link-button" :disabled="backend.loading || !selectedServer" @click="testConnection">测试连接</button>
        </div>
        <label v-if="mode === 'register'">显示名称<input v-model="name" autocomplete="name" placeholder="你的名称" /></label>
        <label>用户名或邮箱<input v-model="email" type="text" autocomplete="username" placeholder="用户名或 name@example.com" /></label>
        <label>密码<input v-model="password" type="password" autocomplete="current-password" placeholder="至少 6 位" @keydown.enter="submit" /></label>
        <button class="backend-primary-button" :disabled="backend.loading || !email.trim() || !password" @click="submit">{{ backend.loading ? '处理中…' : mode === 'login' ? '登录' : '注册并登录' }}</button>
      </template>

      <template v-else>
        <div class="backend-account"><span>●</span><div><strong>{{ accountName }}</strong><small>{{ backend.profile.endpoint }} · 云同步已开启</small></div><button @click="logout">解除绑定</button></div>
        <p v-if="!isTauriDesktop()" class="backend-notice">网页上的文档以后台为准，不再写在浏览器里。</p>
        <div v-if="!isTauriDesktop() && (offerTemporary || temporaryCount)" class="backend-temp-choice">
          <strong>浏览器里还有 {{ temporaryCount }} 篇临时页面</strong>
          <small>它们不会自动混进正文。可以留在浏览器里以后再处理，也可以现在推到后台。</small>
          <div>
            <button type="button" :disabled="pushingTemporary" @click="keepBackendDocuments">使用后台文档</button>
            <button type="button" class="backend-primary-button" :disabled="pushingTemporary || !temporaryCount" @click="pushTemporaryDocuments">{{ pushingTemporary ? '正在推送…' : '保留并推送到后台' }}</button>
          </div>
        </div>
        <p v-if="isTauriDesktop()" class="backend-notice">本地的每个工作区都会同步到这台服务器。页面仍写在本机，保存后自动对齐。</p>
        <button type="button" class="backend-link-button" @click="openMcpAccount('vault')">凭据库与使用授权</button>
        <div class="backend-service-settings">
          <div class="backend-workspace-heading"><span>服务器</span><button :disabled="backend.loading" @click="testConnection">测试连接</button></div>
          <label>服务地址<input v-model="serviceEndpoint" inputmode="url" /></label>
          <button class="backend-link-button" :disabled="backend.loading || !serviceEndpoint.trim()" @click="saveServiceEndpoint">保存服务器地址</button>
        </div>
        <div class="backend-mcp-tokens">
          <button type="button" class="backend-mcp-toggle" :aria-expanded="mcpTokensOpen" aria-controls="backend-mcp-token-panel" @click="toggleMcpTokens">MCP 令牌 <span aria-hidden="true">{{ mcpTokensOpen ? '⌃' : '⌄' }}</span></button>
          <div v-if="mcpTokensOpen" id="backend-mcp-token-panel" class="backend-mcp-token-panel" role="group" aria-label="MCP 令牌管理">
            <small>给 Agent 授权访问指定工作区。此处可签发和作废；令牌内容只在“我的账号”页查看和复制。</small>
            <div class="backend-mcp-issue">
              <label>令牌名称<input v-model="mcpTokenName" placeholder="例如 我的 Agent" :disabled="mcpTokensBusy" /></label>
              <label>授权工作区<select v-model="mcpTokenWorkspace" :disabled="mcpTokensBusy"><option v-for="workspace in backend.workspaces" :key="workspace.id" :value="workspace.id">{{ workspace.name }}</option></select></label>
              <button type="button" class="backend-primary-button" :disabled="mcpTokensBusy || !mcpTokenWorkspace" @click="issueMcpToken">签发令牌</button>
            </div>
            <p v-if="mcpTokensBusy" class="backend-empty" role="status">正在处理…</p>
            <ul v-if="mcpTokens.length" class="backend-mcp-token-list">
              <li v-for="token in mcpTokens" :key="token.id">
                <div><strong>{{ token.name }}</strong><small>{{ tokenWorkspaceName(token.workspaceId) }} · {{ token.canReveal ? '有效' : '旧版令牌，原授权仍有效' }}</small><small>{{ token.lastUsedAt ? `最近使用 ${new Date(token.lastUsedAt).toLocaleString()}` : '尚未使用' }}</small></div>
                <button type="button" :aria-label="`作废 ${token.name}`" :disabled="mcpTokensBusy" @click="revokeMcpToken(token)">作废</button>
              </li>
            </ul>
            <p v-else-if="!mcpTokensBusy && !mcpTokensError" class="backend-empty">还没有 MCP 令牌</p>
            <button type="button" class="backend-link-button" @click="openMcpAccount()">前往我的账号查看与复制</button>
            <p v-if="mcpTokensError" class="backend-error" role="alert">{{ mcpTokensError }}</p>
            <p v-else-if="mcpTokensNotice" class="backend-notice" role="status">{{ mcpTokensNotice }}</p>
          </div>
        </div>
      </template>
      <button v-if="selectedServer?.defaultPrompt" class="backend-link-button" @click="dismissDefaultPrompt">以后不再弹出登录框</button><p v-if="backend.error" class="backend-error">{{ backend.error }}</p><p v-else-if="notice" class="backend-notice">{{ notice }}</p>
    </section>
  </div>
</template>

<style scoped>
.backend-mcp-tokens { border-top: 1px solid var(--border); padding-top: 10px; }
.backend-mcp-toggle { display: flex; justify-content: space-between; width: 100%; border: 0; padding: 3px 0; color: var(--text-muted); background: transparent; font-size: 12px; text-align: left; }
.backend-mcp-token-panel, .backend-mcp-issue { display: grid; gap: 9px; }
.backend-mcp-token-panel { margin-top: 10px; }
.backend-mcp-token-panel > small, .backend-mcp-token-list small { color: var(--text-subtle); font-size: 11px; line-height: 1.5; }
.backend-mcp-issue select { width: 100%; border: 1px solid var(--border-strong); border-radius: 6px; padding: 8px; color: var(--text-secondary); background: var(--bg-elevated); font: inherit; }
.backend-mcp-token-list { display: grid; gap: 7px; max-height: 190px; overflow: auto; padding: 0; margin: 0; list-style: none; }
.backend-mcp-token-list li { display: flex; align-items: center; gap: 8px; border: 1px solid var(--border); border-radius: 6px; padding: 8px; }
.backend-mcp-token-list li > div { display: grid; min-width: 0; flex: 1; gap: 2px; overflow-wrap: anywhere; }
.backend-mcp-token-list strong { color: var(--text-secondary); font-size: 12px; }
.backend-mcp-token-list button { flex-shrink: 0; border: 0; border-radius: 4px; padding: 4px; color: var(--danger, #a15e58); background: transparent; font-size: 11px; }
.backend-mcp-token-panel > .backend-link-button { margin-top: 0; }
</style>
