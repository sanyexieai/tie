<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { openPath } from '@tauri-apps/plugin-opener'
import type { StorageKind, StorageSource } from '@/types'
import { useWorkspaceStore } from '@/stores/workspace'
import { useBackendStore } from '@/stores/backend'
import { loadAiTaggingConfig, saveAiTaggingConfig, type AiTaggingConfig, type AiTaggingMode } from '@/services/ai-tagging'
import { isBackendSourceId, isBackendManagedS3SourceId, defaultBackendEndpoint } from '@/services/backend'
import { isS3SourceId, providerForS3Source } from '@/services/s3'
import { storageRegistry } from '@/services/storage/registry'
import type { S3ConnectionInput } from '@/services/storage/types'

const emit = defineEmits<{ close: []; 'connect-backend': [] }>()
const store = useWorkspaceStore()
const backend = useBackendStore()
const storageMenuOpen = ref(false)
const choosingWorkspace = ref(false)
const importingMarkdown = ref(false)
const syncingRemote = ref(false)
const isDesktop = '__TAURI_INTERNALS__' in window
const draggingSourceId = ref<string | null>(null)
const dropTargetId = ref<string | null>(null)
const dropPosition = ref<'before' | 'after' | null>(null)
const s3FormOpen = ref(false)
const s3EditingSourceId = ref<string | null>(null)
const s3Name = ref('')
const s3Endpoint = ref('')
const s3Bucket = ref('')
const s3Region = ref('')
const s3AccessKey = ref('')
const s3SecretKey = ref('')
const s3Saving = ref(false)
const s3Error = ref('')
const s3Notice = ref('')
const aiConfig = ref<AiTaggingConfig>(loadAiTaggingConfig())
const aiNotice = ref('')
const aiModeOpen = ref(false)
const aiFormOpen = ref(false)

const aiModeOptions: { value: AiTaggingMode; label: string }[] = [
  { value: 'tie', label: 'Tie 后台（/api/v1/ai/suggest-tags）' },
  { value: 'openai', label: 'OpenAI 兼容 API' },
]

const aiModeLabel = computed(() => aiModeOptions.find((item) => item.value === aiConfig.value.mode)?.label ?? aiModeOptions[0].label)
const aiStatusSummary = computed(() => {
  if (!aiConfig.value.enabled) return '未启用 · 点击配置'
  return aiConfig.value.mode === 'openai' ? '已启用 · OpenAI 兼容' : '已启用 · Tie 后台'
})

const localSources = computed(() => store.workspace?.sources ?? [])
const orderedSources = computed(() => store.allSources)
const defaultSourceId = computed(() => store.defaultStorageSourceId)

const sourcePageStats = computed(() => new Map(orderedSources.value.map((source) => {
  const pages = store.pages.filter((page) => page.storageSourceId === source.id)
  return [source.id, { total: pages.length, active: pages.filter((page) => !page.deletedAt).length, trashed: pages.filter((page) => page.deletedAt).length }]
})))

function sourceLabel(kind: StorageKind) {
  if (kind === 'smb') return 'SMB 挂载目录'
  if (kind === 's3') return 'S3 兼容对象存储'
  if (kind === 'backend') return '自定义后台'
  return '本地目录'
}

function sourceStatusClass(source: StorageSource) {
  const runtime = store.sourceRuntimeStatus(source.id)
  if (source.kind === 'backend') return 'backend'
  if (runtime.state === 'error' || runtime.state === 'offline' || source.available === false) return 'offline'
  if (runtime.state === 'queued' || runtime.pendingCount > 0) return 'queued'
  if (runtime.state === 'syncing' || runtime.state === 'loading') return 'syncing'
  return ''
}

function sourcePageCount(sourceId: string) { return sourcePageStats.value.get(sourceId)?.total ?? 0 }

function sourcePageLabel(sourceId: string) {
  const stats = sourcePageStats.value.get(sourceId)
  if (!stats) return '0 页'
  return stats.trashed ? `${stats.active} 页 · ${stats.trashed} 回收` : `${stats.active} 页`
}

function formatSyncedAt(value: string | null) {
  return value ? value.slice(0, 19).replace('T', ' ') : null
}

function sourceDetail(source: StorageSource) {
  const runtime = store.sourceRuntimeStatus(source.id)
  if (runtime.state === 'syncing' || runtime.state === 'loading') return '正在同步…'
  if (runtime.pendingCount > 0) return `离线队列 ${runtime.pendingCount} 项 · ${sourcePageLabel(source.id)}`
  if (runtime.lastError) return `同步失败 · ${runtime.lastError}`
  if (source.kind === 's3' && isBackendManagedS3SourceId(source.id)) {
    if (!backend.connected) return '请先连接自定义后台'
    if (backend.syncing) return '正在同步后台 S3…'
    if (runtime.lastError) return `同步失败 · ${runtime.lastError}`
    return runtime.lastSyncedAt
      ? `后台托管 · 已同步 · ${formatSyncedAt(runtime.lastSyncedAt)}`
      : '后台托管 S3 · 尚未同步'
  }
  if (source.kind === 's3' && source.available === false) return '缺少本机密钥，请重新保存该连接'
  if (source.kind === 'backend') {
    if (backend.syncing) return '正在同步后台页面…'
    if (backend.error) return `同步失败 · ${backend.error}`
    return runtime.lastSyncedAt || backend.lastSyncedAt
      ? `已同步 · ${formatSyncedAt(runtime.lastSyncedAt ?? backend.lastSyncedAt)}`
      : '尚未同步'
  }
  if (source.available === false) return '当前不可访问'
  const synced = formatSyncedAt(runtime.lastSyncedAt)
  const pageInfo = `${sourceLabel(source.kind)} · ${sourcePageLabel(source.id)}`
  return synced && source.kind === 's3' ? `已同步 · ${synced} · ${sourcePageLabel(source.id)}` : pageInfo
}

function sourceTitle(source: StorageSource) {
  if (source.kind === 's3' && isBackendManagedS3SourceId(source.id)) return `${source.path}\n后台托管 S3，凭据保存在服务端`
  if (source.kind === 's3') return `${source.path}\nS3 页面以 tie/pages/*.md 保存`
  if (source.kind === 'backend') return `${source.path}\n自定义后台存储源`
  return `${source.path}\n${source.available === false ? '当前不可访问，请检查挂载后重新载入' : '可用'}`
}

function canRename(source: StorageSource) {
  return (source.kind === 'local' || source.kind === 'smb' || source.kind === 's3') && !isBackendManagedS3SourceId(source.id)
}

function canDisconnect(source: StorageSource) {
  if (isBackendSourceId(source.id) || isBackendManagedS3SourceId(source.id)) return false
  if (source.kind === 'local' || source.kind === 'smb') {
    return localSources.value.length > 1 && sourcePageCount(source.id) === 0 && source.available !== false
  }
  if (source.kind === 's3' && !isBackendManagedS3SourceId(source.id)) return sourcePageCount(source.id) === 0
  return false
}

function canSync(source: StorageSource) {
  if (isBackendManagedS3SourceId(source.id)) return backend.connected
  return source.kind === 's3' || source.kind === 'backend'
}

function resetS3Form() {
  s3EditingSourceId.value = null
  s3Name.value = ''
  s3Endpoint.value = ''
  s3Bucket.value = ''
  s3Region.value = ''
  s3AccessKey.value = ''
  s3SecretKey.value = ''
  s3Error.value = ''
}

function openS3Form(sourceId?: string) {
  s3Error.value = ''
  s3Notice.value = ''
  s3FormOpen.value = true
  storageMenuOpen.value = false
  if (sourceId && isS3SourceId(sourceId)) {
    const provider = providerForS3Source(sourceId)
    if (!provider) return
    s3EditingSourceId.value = sourceId
    s3Name.value = provider.name
    s3Endpoint.value = provider.endpoint
    s3Bucket.value = provider.bucket
    s3Region.value = provider.region ?? ''
    return
  }
  resetS3Form()
}

async function chooseWorkspace(kind: 'local' | 'smb') {
  choosingWorkspace.value = true
  try { await store.addStorageSource(kind); storageMenuOpen.value = false } finally { choosingWorkspace.value = false }
}

async function importMarkdown() {
  importingMarkdown.value = true
  try { await store.importMarkdownFiles(); storageMenuOpen.value = false } finally { importingMarkdown.value = false }
}

async function reloadWorkspace() {
  if (!window.confirm('从磁盘重新载入全部存储源？尚未保存的编辑内容可能丢失。')) return
  await store.reloadWorkspace()
}

async function syncRemoteSources() {
  syncingRemote.value = true
  try { await store.syncRemoteSources() } catch { /* store / backend 会保留错误 */ }
  finally { syncingRemote.value = false }
}

async function flushOfflineQueue() {
  syncingRemote.value = true
  try { await store.flushOfflineQueue() } finally { syncingRemote.value = false }
}

function saveAiSettings() {
  saveAiTaggingConfig(aiConfig.value)
  aiNotice.value = 'AI 标签设置已保存'
  window.setTimeout(() => { aiNotice.value = '' }, 2400)
  aiFormOpen.value = false
  aiModeOpen.value = false
}

function toggleAiForm() {
  aiFormOpen.value = !aiFormOpen.value
  if (!aiFormOpen.value) aiModeOpen.value = false
}

function setAiMode(mode: AiTaggingMode) {
  aiConfig.value.mode = mode
  aiModeOpen.value = false
}

function closeAiModeMenu(event: MouseEvent) {
  const target = event.target
  if (!(target instanceof Element) || !target.closest('.ai-mode-select')) aiModeOpen.value = false
}

onMounted(() => document.addEventListener('click', closeAiModeMenu))
onBeforeUnmount(() => document.removeEventListener('click', closeAiModeMenu))

async function syncSource(sourceId: string) {
  if (isBackendSourceId(sourceId)) {
    await syncRemoteSources()
    return
  }
  syncingRemote.value = true
  try { await store.syncSource(sourceId) } catch { /* source status 会记录错误 */ }
  finally { syncingRemote.value = false }
}

async function saveS3Connection() {
  s3Error.value = ''
  s3Saving.value = true
  try {
    const input: S3ConnectionInput = {
      name: s3Name.value.trim() || s3Bucket.value.trim(),
      endpoint: s3Endpoint.value.trim(),
      bucket: s3Bucket.value.trim(),
      region: s3Region.value.trim() || undefined,
      accessKey: s3AccessKey.value.trim(),
      secretKey: s3SecretKey.value,
    }
    if (s3EditingSourceId.value) {
      const provider = providerForS3Source(s3EditingSourceId.value)
      if (!provider) throw new Error('S3 连接不存在')
      input.id = provider.id
      if (!input.accessKey || !input.secretKey) {
        await storageRegistry.updateS3Connection(s3EditingSourceId.value, {
          name: input.name,
          endpoint: input.endpoint,
          bucket: input.bucket,
          region: input.region,
        })
      } else {
        await storageRegistry.updateS3Connection(s3EditingSourceId.value, input)
      }
      s3Notice.value = 'S3 连接已更新。'
    } else {
      if (!input.accessKey || !input.secretKey) throw new Error('新建 S3 连接需要 Access Key 和 Secret Key')
      await storageRegistry.saveS3Connection(input)
      s3Notice.value = 'S3 连接验证成功，配置已保存到当前设备。'
    }
    s3FormOpen.value = false
    resetS3Form()
    await store.reloadWorkspace()
  } catch (reason) {
    s3Error.value = reason instanceof Error ? reason.message : '保存 S3 配置失败'
  } finally {
    s3Saving.value = false
  }
}

async function disconnectSource(sourceId: string) {
  if (isBackendSourceId(sourceId)) return
  if ((sourcePageStats.value.get(sourceId)?.total ?? 0) > 0) return
  const label = isS3SourceId(sourceId) && !isBackendManagedS3SourceId(sourceId)
    ? '移除此 S3 连接？Bucket 中的文件不会被删除。'
    : '断开此存储源？该目录和其中的文件不会被删除。'
  if (!window.confirm(label)) return
  await store.removeStorageSource(sourceId)
}

async function renameSource(sourceId: string) {
  if (isBackendSourceId(sourceId)) return
  const source = orderedSources.value.find((item) => item.id === sourceId)
  if (!source) return
  const name = window.prompt('存储源显示名称', source.name)
  if (name === null || name.trim() === source.name) return
  await store.renameStorageSource(sourceId, name.trim())
}

async function openSource(path: string) {
  if (isDesktop) await openPath(path)
}

function startDrag(event: DragEvent, sourceId: string) {
  draggingSourceId.value = sourceId
  event.dataTransfer?.setData('text/plain', sourceId)
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
}

function updateDropPosition(event: DragEvent, targetId: string) {
  if (!draggingSourceId.value || draggingSourceId.value === targetId) return
  const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect()
  const relativeY = (event.clientY - bounds.top) / bounds.height
  dropTargetId.value = targetId
  dropPosition.value = relativeY < 0.5 ? 'before' : 'after'
}

function clearDropState() {
  dropTargetId.value = null
  dropPosition.value = null
}

function finishDrag() {
  draggingSourceId.value = null
  clearDropState()
}

function dropOnSource(event: DragEvent, targetId: string) {
  event.preventDefault()
  const sourceId = event.dataTransfer?.getData('text/plain') || draggingSourceId.value
  const position = dropPosition.value
  finishDrag()
  if (!sourceId || !position || sourceId === targetId) return
  store.reorderStorageSource(sourceId, targetId, position)
}

function openConflictPage(pageId: string) {
  store.openPage(pageId)
  emit('close')
}
</script>

<template>
  <div class="backend-dialog-backdrop" @mousedown.self="emit('close')">
    <section class="backend-dialog storage-settings-dialog" role="dialog" aria-modal="true" aria-label="存储设置">
      <header>
        <div>
          <strong>存储设置</strong>
          <small>拖拽调整优先级，越靠前越优先；新建顶层页默认保存到第一个可用存储源</small>
        </div>
        <button aria-label="关闭" @click="emit('close')">×</button>
      </header>

      <div class="storage-settings-toolbar">
        <button :disabled="store.reloading" @click="reloadWorkspace">{{ store.reloading ? '载入中…' : '↻ 重新载入' }}</button>
        <button :disabled="syncingRemote || store.reloading" @click="syncRemoteSources">{{ syncingRemote || store.reloading ? '同步中…' : '↻ 同步远程源' }}</button>
        <button v-if="store.pendingSyncCount > 0" :disabled="syncingRemote" @click="flushOfflineQueue">{{ syncingRemote ? '重试中…' : `↻ 重试离线队列 (${store.pendingSyncCount})` }}</button>
        <button v-if="store.syncConflictsCount > 0" class="storage-conflict-notice" type="button" disabled>{{ store.syncConflictsCount }} 个同步冲突 · 见下方列表</button>
        <button @click="storageMenuOpen = !storageMenuOpen">+ 添加存储源</button>
      </div>

      <div v-if="store.syncConflictPages.length" class="storage-conflict-list">
        <strong>同步冲突</strong>
        <small>本地较新的版本会在同步时自动推送；其余冲突需打开页面手动处理。</small>
        <button
          v-for="item in store.syncConflictPages"
          :key="item.pageId"
          type="button"
          class="storage-conflict-item"
          @click="openConflictPage(item.pageId)"
        >
          <span>{{ item.page.icon || '▱' }} {{ item.page.title || '无标题' }}</span>
          <small>{{ item.source?.name ?? item.conflict.sourceId }} · 本地 {{ item.conflict.localUpdatedAt.slice(0, 16).replace('T', ' ') }} · 远程 {{ item.conflict.remoteUpdatedAt.slice(0, 16).replace('T', ' ') }}</small>
        </button>
      </div>

      <div v-if="storageMenuOpen" class="storage-menu storage-settings-menu">
        <button :disabled="choosingWorkspace" @click="chooseWorkspace('local')"><strong>本地目录</strong><small>选择磁盘中的知识库</small></button>
        <button :disabled="choosingWorkspace" @click="chooseWorkspace('smb')"><strong>SMB 挂载目录</strong><small>选择系统已挂载的共享目录</small></button>
        <button @click="emit('connect-backend'); storageMenuOpen = false"><strong>自定义后台{{ backend.connected ? ' · 已连接' : '' }}</strong><small>{{ backend.connected ? '登录后可添加后台存储源' : '登录并添加后台存储源' }}</small></button>
        <button @click="openS3Form()"><strong>S3 兼容对象存储</strong><small>AWS S3、MinIO、R2、Ceph 等 · 本地保存</small></button>
        <button :disabled="importingMarkdown || !defaultSourceId || isBackendSourceId(defaultSourceId)" @click="importMarkdown"><strong>{{ importingMarkdown ? '正在导入…' : '导入 Markdown 文件' }}</strong><small>导入到优先级最高的可用存储源</small></button>
      </div>

      <form v-if="s3FormOpen" class="minio-config-form" @submit.prevent="saveS3Connection">
        <strong>{{ s3EditingSourceId ? '编辑 S3 连接' : '连接 S3 兼容对象存储' }}</strong>
        <small>兼容 AWS S3、MinIO、R2、Ceph；连接配置保存在本机，密钥保存在系统凭据库。</small>
        <label>显示名称<input v-model="s3Name" placeholder="例如：团队附件库" /></label>
        <label>Endpoint<input v-model="s3Endpoint" required placeholder="https://minio.example.com" /></label>
        <label>Bucket<input v-model="s3Bucket" required placeholder="knowledge-base" /></label>
        <label>Region（可选）<input v-model="s3Region" placeholder="us-east-1" /></label>
        <label>Access Key<input v-model="s3AccessKey" :required="!s3EditingSourceId" autocomplete="off" :placeholder="s3EditingSourceId ? '留空则保留现有密钥' : ''" /></label>
        <label>Secret Key<input v-model="s3SecretKey" :required="!s3EditingSourceId" type="password" autocomplete="new-password" :placeholder="s3EditingSourceId ? '留空则保留现有密钥' : ''" /></label>
        <p v-if="s3Error" class="backend-error">{{ s3Error }}</p>
        <div>
          <button type="button" @click="s3FormOpen = false; resetS3Form()">取消</button>
          <button type="submit" :disabled="s3Saving">{{ s3Saving ? '正在验证并保存…' : s3EditingSourceId ? '保存更改' : '验证并保存配置' }}</button>
        </div>
      </form>
      <p v-if="s3Notice" class="minio-config-notice">{{ s3Notice }}</p>

      <button
        type="button"
        class="ai-tagging-toggle"
        :aria-expanded="aiFormOpen"
        @click="toggleAiForm"
      >
        <span>
          <strong>AI 标签提取</strong>
          <small>{{ aiStatusSummary }}</small>
        </span>
        <em>{{ aiFormOpen ? '收起' : '配置' }}</em>
      </button>

      <form v-if="aiFormOpen" class="minio-config-form ai-tagging-form" @submit.prevent="saveAiSettings">
        <small>可选。启用后会先请求外部服务，再与本地启发式结果合并。留空 endpoint 则仅使用本地提取。</small>
        <label class="minio-config-checkbox"><input v-model="aiConfig.enabled" type="checkbox" /><span>启用 AI 标签提取</span></label>
        <label>
          <span>模式</span>
          <div class="ai-mode-select" :class="{ open: aiModeOpen }">
            <button
              type="button"
              class="ai-mode-select-trigger"
              :aria-expanded="aiModeOpen"
              aria-haspopup="listbox"
              @click.stop="aiModeOpen = !aiModeOpen"
            >
              {{ aiModeLabel }}
            </button>
            <div v-if="aiModeOpen" class="ai-mode-select-menu" role="listbox" aria-label="AI 标签模式">
              <button
                v-for="option in aiModeOptions"
                :key="option.value"
                type="button"
                role="option"
                :class="{ selected: aiConfig.mode === option.value }"
                :aria-selected="aiConfig.mode === option.value"
                @click="setAiMode(option.value)"
              >
                {{ option.label }}
              </button>
            </div>
          </div>
        </label>
        <label>服务地址<input v-model="aiConfig.endpoint" :placeholder="aiConfig.mode === 'openai' ? 'https://api.openai.com/v1' : defaultBackendEndpoint" /></label>
        <label v-if="aiConfig.mode === 'openai'">模型<input v-model="aiConfig.model" placeholder="gpt-4o-mini" /></label>
        <label>API Key（可选）<input v-model="aiConfig.apiKey" type="password" autocomplete="off" :placeholder="aiConfig.mode === 'tie' ? '留空则尝试使用后台登录 token' : 'OpenAI 模式必填'" /></label>
        <small v-if="aiConfig.mode === 'tie'">后台服务可通过环境变量 OPENAI_API_KEY 启用真实 LLM；未配置时使用启发式提取。</small>
        <div>
          <button type="button" @click="aiFormOpen = false; aiModeOpen = false">取消</button>
          <button type="submit">保存 AI 设置</button>
        </div>
        <p v-if="aiNotice" class="minio-config-notice">{{ aiNotice }}</p>
      </form>
      <p v-if="!aiFormOpen && aiNotice" class="minio-config-notice">{{ aiNotice }}</p>

      <div v-if="orderedSources.length" class="storage-settings-list">
        <div
          v-for="source in orderedSources"
          :key="source.id"
          class="storage-settings-row"
          :class="{
            unavailable: source.available === false || sourceStatusClass(source) === 'offline',
            'backend-source-entry': source.kind === 'backend',
            dragging: draggingSourceId === source.id,
            'drop-before': dropTargetId === source.id && dropPosition === 'before',
            'drop-after': dropTargetId === source.id && dropPosition === 'after',
          }"
          draggable="true"
          @dragstart="startDrag($event, source.id)"
          @dragend="finishDrag"
          @dragenter.prevent="updateDropPosition($event, source.id)"
          @dragover.prevent="updateDropPosition($event, source.id)"
          @dragleave="clearDropState"
          @drop.prevent="dropOnSource($event, source.id)"
        >
          <span class="storage-drag-handle" aria-hidden="true">⋮⋮</span>
          <div class="storage-settings-main" :title="sourceTitle(source)">
            <div class="storage-settings-title">
              <span class="storage-status" :class="sourceStatusClass(source)"></span>
              <strong>{{ source.name }}</strong>
              <span v-if="source.id === defaultSourceId" class="storage-default-badge">默认</span>
            </div>
            <small>{{ sourceDetail(source) }}</small>
          </div>
          <div class="storage-settings-actions" @mousedown.stop @click.stop>
            <button v-if="canSync(source)" :disabled="syncingRemote || store.reloading" title="同步此存储源" @click="syncSource(source.id)">↻</button>
            <button v-if="isDesktop && (source.kind === 'local' || source.kind === 'smb')" :disabled="source.available === false" title="在文件管理器中打开" @click="openSource(source.path)">↗</button>
            <button v-if="source.kind === 's3'" title="编辑连接" @click="openS3Form(source.id)">✎</button>
            <button v-else-if="canRename(source)" title="重命名显示名称" @click="renameSource(source.id)">✎</button>
            <button v-if="canDisconnect(source)" title="断开存储源" @click="disconnectSource(source.id)">×</button>
          </div>
        </div>
      </div>
      <p v-else class="storage-settings-empty">还没有连接存储源，点击「添加存储源」开始。</p>

      <p class="storage-settings-note">所有存储源的页面都在左侧同一棵树里；这里只调整优先级和管理连接。</p>
    </section>
  </div>
</template>
