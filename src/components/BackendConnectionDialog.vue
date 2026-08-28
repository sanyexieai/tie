<script setup lang="ts">
import { computed, ref } from 'vue'
import { defaultBackendEndpoint } from '@/services/backend'
import { useBackendStore } from '@/stores/backend'

import { useWorkspaceStore } from '@/stores/workspace'

const emit = defineEmits<{ close: [] }>()
const backend = useBackendStore()
const store = useWorkspaceStore()
const mode = ref<'login' | 'register'>('login')
const endpoint = ref(backend.profile.endpoint || defaultBackendEndpoint)
const email = ref('')
const password = ref('')
const name = ref('')
const workspaceName = ref('')
const notice = ref('')
const accountName = computed(() => backend.profile.user?.name || backend.profile.user?.email || '')

async function testConnection() {
  notice.value = ''
  try { await backend.checkHealth(endpoint.value); notice.value = '后台服务可用。' } catch { /* store exposes message */ }
}
async function syncWorkspacePages() {
  await store.reloadWorkspace()
}
async function submit() {
  notice.value = ''
  try {
    await backend.authenticate(mode.value, endpoint.value, email.value.trim(), password.value, name.value.trim())
    password.value = ''
    await syncWorkspacePages()
    notice.value = '已连接到后台。'
  } catch { /* store exposes message */ }
}
async function addWorkspace() {
  if (!workspaceName.value.trim()) return
  try {
    await backend.createWorkspace(workspaceName.value.trim())
    workspaceName.value = ''
    await syncWorkspacePages()
    notice.value = '后台存储源已创建。'
  } catch { /* store exposes message */ }
}
async function logout() {
  backend.logout()
  await syncWorkspacePages()
}
</script>

<template>
  <div class="backend-dialog-backdrop" @mousedown.self="emit('close')">
    <section class="backend-dialog" role="dialog" aria-modal="true" aria-label="连接自定义后台">
      <header><div><strong>自定义后台</strong><small>与本地目录、SMB、MinIO 等并列的数据源</small></div><button aria-label="关闭" @click="emit('close')">×</button></header>

      <template v-if="!backend.connected">
        <div class="backend-mode-tabs"><button :class="{ selected: mode === 'login' }" @click="mode = 'login'">登录</button><button :class="{ selected: mode === 'register' }" @click="mode = 'register'">注册</button></div>
        <label>后台地址<input v-model="endpoint" inputmode="url" placeholder="http://127.0.0.1:8787" /></label>
        <button class="backend-link-button" :disabled="backend.loading" @click="testConnection">测试连接</button>
        <label v-if="mode === 'register'">显示名称<input v-model="name" autocomplete="name" placeholder="你的名称" /></label>
        <label>邮箱<input v-model="email" type="email" autocomplete="email" placeholder="name@example.com" /></label>
        <label>密码<input v-model="password" type="password" autocomplete="current-password" placeholder="至少 6 位" @keydown.enter="submit" /></label>
        <button class="backend-primary-button" :disabled="backend.loading || !email.trim() || !password" @click="submit">{{ backend.loading ? '处理中…' : mode === 'login' ? '登录并连接' : '注册并连接' }}</button>
      </template>

      <template v-else>
        <div class="backend-account"><span>●</span><div><strong>{{ accountName }}</strong><small>{{ backend.profile.endpoint }}</small></div><button @click="logout">退出登录</button></div>
        <div class="backend-workspace-heading"><span>后台存储源</span><button :disabled="backend.loading" @click="backend.refreshWorkspaces">↻</button></div>
        <div v-if="backend.workspaces.length" class="backend-workspace-list"><div v-for="workspace in backend.workspaces" :key="workspace.id"><strong>{{ workspace.name }}</strong><small>已加入左侧存储源列表</small></div></div>
        <p v-else class="backend-empty">创建后会作为存储源显示在左侧，与本地目录、SMB 同级。</p>
        <div class="backend-create-workspace"><input v-model="workspaceName" placeholder="新工作区名称" @keydown.enter="addWorkspace" /><button :disabled="backend.loading || !workspaceName.trim()" @click="addWorkspace">创建</button></div>
      </template>
      <p v-if="backend.error" class="backend-error">{{ backend.error }}</p><p v-else-if="notice" class="backend-notice">{{ notice }}</p>
    </section>
  </div>
</template>
