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
const providerName = ref('')
const providerEndpoint = ref('')
const providerBucket = ref('')
const providerRegion = ref('')
const providerAccessKey = ref('')
const providerSecretKey = ref('')
const notice = ref('')
const accountName = computed(() => backend.profile.user?.name || backend.profile.user?.email || '')
const s3Providers = computed(() => backend.providers.filter((provider) => provider.kind === 's3'))

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
async function addS3Provider() {
  if (!providerName.value.trim() || !providerEndpoint.value.trim() || !providerBucket.value.trim()) return
  if (!providerAccessKey.value.trim() || !providerSecretKey.value) {
    notice.value = '创建 S3 Provider 需要 Access Key 和 Secret Key'
    return
  }
  try {
    await backend.createProvider({
      name: providerName.value.trim(),
      kind: 's3',
      publicConfig: {
        endpoint: providerEndpoint.value.trim(),
        bucket: providerBucket.value.trim(),
        region: providerRegion.value.trim() || undefined,
      },
      credentials: {
        accessKey: providerAccessKey.value.trim(),
        secretKey: providerSecretKey.value,
      },
    })
    providerName.value = ''
    providerEndpoint.value = ''
    providerBucket.value = ''
    providerRegion.value = ''
    providerAccessKey.value = ''
    providerSecretKey.value = ''
    await syncWorkspacePages()
    notice.value = '后台 S3 Provider 已创建，已加入左侧存储源列表。'
  } catch { /* store exposes message */ }
}
async function removeWorkspace(workspaceId: string, workspaceName: string) {
  if (!window.confirm(`删除后台工作区「${workspaceName}」？其中的全部页面会被永久删除。`)) return
  try {
    await backend.deleteWorkspace(workspaceId)
    await syncWorkspacePages()
    notice.value = '后台工作区已删除。'
  } catch { /* store exposes message */ }
}
async function renameWorkspace(workspaceId: string, currentName: string) {
  const name = window.prompt('后台工作区名称', currentName)
  if (name === null || !name.trim() || name.trim() === currentName) return
  try {
    await backend.renameWorkspace(workspaceId, name.trim())
    notice.value = '后台工作区已重命名。'
  } catch { /* store exposes message */ }
}
async function renameProvider(providerId: string, currentName: string) {
  const name = window.prompt('S3 Provider 名称', currentName)
  if (name === null || !name.trim() || name.trim() === currentName) return
  try {
    await backend.renameProvider(providerId, name.trim())
    await syncWorkspacePages()
    notice.value = 'S3 Provider 已重命名。'
  } catch { /* store exposes message */ }
}
async function removeProvider(providerId: string, providerName: string) {
  if (!window.confirm(`删除后台 S3 Provider「${providerName}」？Bucket 中的对象不会被删除。`)) return
  try {
    await backend.deleteProvider(providerId)
    await syncWorkspacePages()
    notice.value = 'S3 Provider 已删除。'
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
        <div v-if="backend.workspaces.length" class="backend-workspace-list"><div v-for="workspace in backend.workspaces" :key="workspace.id"><span><strong>{{ workspace.name }}</strong><small>已加入左侧存储源列表</small></span><button :disabled="backend.loading" title="重命名后台工作区" @click="renameWorkspace(workspace.id, workspace.name)">✎</button><button :disabled="backend.loading" title="删除后台工作区" @click="removeWorkspace(workspace.id, workspace.name)">×</button></div></div>
        <p v-else class="backend-empty">创建后会作为存储源显示在左侧，与本地目录、SMB 同级。</p>
        <div class="backend-create-workspace"><input v-model="workspaceName" placeholder="新工作区名称" @keydown.enter="addWorkspace" /><button :disabled="backend.loading || !workspaceName.trim()" @click="addWorkspace">创建</button></div>

        <div class="backend-workspace-heading"><span>S3 Provider</span></div>
        <div v-if="s3Providers.length" class="backend-workspace-list">
          <div v-for="provider in s3Providers" :key="provider.id">
            <span>
              <strong>{{ provider.name }}</strong>
              <small>{{ backend.providerAvailability[provider.id] === false ? '连接不可用' : `${String(provider.publicConfig.endpoint ?? '')}/${String(provider.publicConfig.bucket ?? '')}` }}</small>
            </span>
            <button :disabled="backend.loading" title="重命名 Provider" @click="renameProvider(provider.id, provider.name)">✎</button>
            <button :disabled="backend.loading" title="删除 Provider" @click="removeProvider(provider.id, provider.name)">×</button>
          </div>
        </div>
        <p v-else class="backend-empty">在后台注册 S3 兼容存储，凭据由后台托管，本地仅显示连接信息。</p>
        <label>Provider 名称<input v-model="providerName" placeholder="例如：团队 MinIO" /></label>
        <label>Endpoint<input v-model="providerEndpoint" inputmode="url" placeholder="http://127.0.0.1:9000" /></label>
        <label>Bucket<input v-model="providerBucket" placeholder="tie-pages" /></label>
        <label>Region（可选）<input v-model="providerRegion" placeholder="us-east-1" /></label>
        <label>Access Key<input v-model="providerAccessKey" autocomplete="off" /></label>
        <label>Secret Key<input v-model="providerSecretKey" type="password" autocomplete="new-password" /></label>
        <button class="backend-primary-button" :disabled="backend.loading || !providerName.trim() || !providerEndpoint.trim() || !providerBucket.trim()" @click="addS3Provider">创建 S3 Provider</button>
      </template>
      <p v-if="backend.error" class="backend-error">{{ backend.error }}</p><p v-else-if="notice" class="backend-notice">{{ notice }}</p>
    </section>
  </div>
</template>
