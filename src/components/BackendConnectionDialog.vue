<script setup lang="ts">
import { computed, ref } from 'vue'
import { useBackendStore } from '@/stores/backend'
import { useWorkspaceStore } from '@/stores/workspace'

const emit = defineEmits<{ close: [] }>()
defineProps<{ startupPrompt?: boolean }>()
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
const workspaceName = ref('')
const notice = ref('')
const advancedOpen = ref(false)
const serviceEndpoint = ref(backend.profile.endpoint)
const accountName = computed(() => backend.profile.user?.name || backend.profile.user?.email || '')
const selectedServer = computed(() => backend.servers.find((item) => item.id === selectedServerId.value) ?? null)
function addServer() { if (!newServerEndpoint.value.trim()) return; const server = backend.addServer(newServerEndpoint.value); selectedServerId.value = server.id; endpoint.value = server.endpoint; newServerEndpoint.value = '' }
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
    if (!selectedServer.value) throw new Error('请先添加并选择后台服务器')
    await backend.authenticate(mode.value, selectedServer.value.endpoint, email.value.trim(), password.value, name.value.trim())
    password.value = ''
    await store.syncLocalToDefaultBackend()
    await syncWorkspacePages()
    notice.value = '已登录，默认云工作区已就绪。'
  } catch { /* store exposes message */ }
}
async function addWorkspace() {
  if (!workspaceName.value.trim()) return
  try {
    await backend.createWorkspace(workspaceName.value.trim())
    workspaceName.value = ''
    await syncWorkspacePages()
    notice.value = '已增加一个云工作区。'
  } catch { /* store exposes message */ }
}
async function removeWorkspace(workspaceId: string, workspaceName: string) {
  if (!window.confirm(`删除云工作区「${workspaceName}」？其中的全部页面会被永久删除。`)) return
  try {
    await backend.deleteWorkspace(workspaceId)
    await syncWorkspacePages()
    notice.value = '云工作区已删除。'
  } catch { /* store exposes message */ }
}
async function renameWorkspace(workspaceId: string, currentName: string) {
  const name = window.prompt('云工作区名称', currentName)
  if (name === null || !name.trim() || name.trim() === currentName) return
  try {
    await backend.renameWorkspace(workspaceId, name.trim())
    notice.value = '云工作区已重命名。'
  } catch { /* store exposes message */ }
}
async function logout() {
  backend.logout()
  await syncWorkspacePages()
}
</script>

<template>
  <div class="backend-dialog-backdrop" @mousedown.self="emit('close')">
    <section class="backend-dialog" role="dialog" aria-modal="true" aria-label="连接云服务">
      <header><div><strong>云服务</strong><small>登录后即可使用后台默认云工作区，无需配置存储</small></div><button aria-label="关闭" @click="emit('close')">×</button></header>

      <template v-if="!backend.connected">
        <div class="backend-mode-tabs"><button :class="{ selected: mode === 'login' }" @click="mode = 'login'">登录</button><button :class="{ selected: mode === 'register' }" @click="mode = 'register'">注册</button></div>
        <button type="button" class="backend-link-button" @click="advancedOpen = !advancedOpen">{{ advancedOpen ? '收起高级选项' : '高级选项' }}</button>
        <div v-if="advancedOpen" class="backend-advanced-settings">
          <div class="backend-server-list"><strong>选择后台服务器</strong><div v-for="server in backend.servers" :key="server.id" class="backend-server-row"><button :class="{ selected: selectedServerId === server.id }" @click="selectServer(server.id)">{{ server.endpoint }}<small v-if="server.id === 'default-local'">默认后台</small></button><label><input type="checkbox" :checked="server.defaultPrompt" @change="onDefaultPromptChange(server.id, $event)"> 默认弹窗</label></div><p v-if="!backend.servers.length" class="backend-empty">请先添加后台地址。</p></div>
          <div class="backend-add-server"><input v-model="newServerEndpoint" inputmode="url" placeholder="添加后台服务地址，例如 https://example.com:32043" /><button :disabled="backend.loading || !newServerEndpoint.trim()" @click="addServer">添加服务器</button></div>
          <button class="backend-link-button" :disabled="backend.loading || !selectedServer" @click="testConnection">测试连接</button>
        </div>
        <label v-if="mode === 'register'">显示名称<input v-model="name" autocomplete="name" placeholder="你的名称" /></label>
        <label>用户名或邮箱<input v-model="email" type="text" autocomplete="username" placeholder="用户名或 name@example.com" /></label>
        <label>密码<input v-model="password" type="password" autocomplete="current-password" placeholder="至少 6 位" @keydown.enter="submit" /></label>
        <button class="backend-primary-button" :disabled="backend.loading || !email.trim() || !password" @click="submit">{{ backend.loading ? '处理中…' : mode === 'login' ? '登录' : '注册并登录' }}</button>
      </template>

      <template v-else>
        <div class="backend-account"><span>●</span><div><strong>{{ accountName }}</strong><small>{{ backend.profile.endpoint }}</small></div><button @click="logout">退出登录</button></div>
        <div class="backend-service-settings">
          <div class="backend-workspace-heading"><span>后台服务</span><button :disabled="backend.loading" @click="testConnection">测试连接</button></div>
          <label>服务地址<input v-model="serviceEndpoint" inputmode="url" /></label>
          <button class="backend-link-button" :disabled="backend.loading || !serviceEndpoint.trim()" @click="saveServiceEndpoint">保存后台服务设置</button>
        </div>
        <div class="backend-workspace-heading"><span>云工作区</span><button :disabled="backend.loading" @click="backend.refreshWorkspaces">↻</button></div>
        <div v-if="backend.workspaces.length" class="backend-workspace-list"><div v-for="workspace in backend.workspaces" :key="workspace.id"><span><strong>{{ workspace.name }}</strong><small>已加入左侧存储源列表</small></span><button :disabled="backend.loading" title="重命名云工作区" @click="renameWorkspace(workspace.id, workspace.name)">✎</button><button :disabled="backend.loading" title="删除云工作区" @click="removeWorkspace(workspace.id, workspace.name)">×</button></div></div>
        <p v-else class="backend-empty">登录后会自动准备默认云工作区。</p>
        <div class="backend-create-workspace"><input v-model="workspaceName" placeholder="再加一个工作区（可选）" @keydown.enter="addWorkspace" /><button :disabled="backend.loading || !workspaceName.trim()" @click="addWorkspace">添加</button></div>
      </template>
      <button v-if="selectedServer?.defaultPrompt" class="backend-link-button" @click="dismissDefaultPrompt">以后不再弹出登录框</button><p v-if="backend.error" class="backend-error">{{ backend.error }}</p><p v-else-if="notice" class="backend-notice">{{ notice }}</p>
    </section>
  </div>
</template>
