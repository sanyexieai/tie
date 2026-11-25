<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { localBackendEndpoint } from '@/services/backend'
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
const notice = ref('')
const advancedOpen = ref(false)
const serviceEndpoint = ref(backend.profile.endpoint)
const accountName = computed(() => backend.profile.user?.name || backend.profile.user?.email || '')
const selectedServer = computed(() => backend.servers.find((item) => item.id === selectedServerId.value) ?? null)
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
    await store.syncBackendNow()
    await syncWorkspacePages()
    notice.value = '已绑定服务器，云同步已开启。'
  } catch { /* store exposes message */ }
}
async function logout() {
  backend.logout()
  await syncWorkspacePages()
}
</script>

<template>
  <div class="backend-dialog-backdrop" @mousedown.self="emit('close')">
      <section class="backend-dialog" role="dialog" aria-modal="true" aria-label="绑定服务器">
      <header><div><strong>绑定服务器</strong><small>只绑定一台。绑定后进入本地 + 服务器，保存时云同步</small></div><button aria-label="关闭" @click="emit('close')">×</button></header>

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
        <p class="backend-notice">本地的每个工作区都会同步到这台服务器。页面仍写在本机，保存后自动对齐。</p>
        <div class="backend-service-settings">
          <div class="backend-workspace-heading"><span>服务器</span><button :disabled="backend.loading" @click="testConnection">测试连接</button></div>
          <label>服务地址<input v-model="serviceEndpoint" inputmode="url" /></label>
          <button class="backend-link-button" :disabled="backend.loading || !serviceEndpoint.trim()" @click="saveServiceEndpoint">保存服务器地址</button>
        </div>
      </template>
      <button v-if="selectedServer?.defaultPrompt" class="backend-link-button" @click="dismissDefaultPrompt">以后不再弹出登录框</button><p v-if="backend.error" class="backend-error">{{ backend.error }}</p><p v-else-if="notice" class="backend-notice">{{ notice }}</p>
    </section>
  </div>
</template>
