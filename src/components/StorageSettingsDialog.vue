<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { openPath } from '@tauri-apps/plugin-opener'
import type { StorageKind, StorageSource } from '@/types'
import { useWorkspaceStore } from '@/stores/workspace'
import { useBackendStore } from '@/stores/backend'
import { isBackendSourceId } from '@/services/backend'
import { LOCAL_S3_PROVIDERS_KEY, loadLocalS3Providers, type LocalS3Provider } from '@/services/s3'

const emit = defineEmits<{ close: []; 'connect-backend': [] }>()
const store = useWorkspaceStore()
const backend = useBackendStore()
const storageMenuOpen = ref(false)
const choosingWorkspace = ref(false)
const importingMarkdown = ref(false)
const isDesktop = '__TAURI_INTERNALS__' in window
const draggingSourceId = ref<string | null>(null)
const dropTargetId = ref<string | null>(null)
const dropPosition = ref<'before' | 'after' | null>(null)
const minioFormOpen = ref(false)
const minioName = ref('')
const minioEndpoint = ref('')
const minioBucket = ref('')
const minioRegion = ref('')
const minioAccessKey = ref('')
const minioSecretKey = ref('')
const minioSaving = ref(false)
const minioError = ref('')
const minioNotice = ref('')
const minioSources = ref<LocalS3Provider[]>([])

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
  if (source.kind === 'backend') return 'backend'
  if (source.available === false) return 'offline'
  return ''
}
function sourcePageCount(sourceId: string) { return sourcePageStats.value.get(sourceId)?.total ?? 0 }
function sourcePageLabel(sourceId: string) {
  const stats = sourcePageStats.value.get(sourceId)
  if (!stats) return '0 页'
  return stats.trashed ? `${stats.active} 页 · ${stats.trashed} 回收` : `${stats.active} 页`
}
function sourceDetail(source: StorageSource) {
  if (source.kind === 's3') return source.available === false ? '缺少本机密钥，请重新保存该连接' : `S3 页面 · ${sourcePageLabel(source.id)}`
  if (source.kind === 'backend') {
    if (backend.syncing) return '正在同步后台页面…'
    if (backend.error) return `同步失败 · ${backend.error}`
    return backend.lastSyncedAt ? `已同步 · ${backend.lastSyncedAt.slice(0, 19).replace('T', ' ')}` : '尚未同步'
  }
  if (source.available === false) return '当前不可访问'
  return `${sourceLabel(source.kind)} · ${sourcePageLabel(source.id)}`
}
function sourceTitle(source: StorageSource) {
  if (source.kind === 's3') return `${source.path}\nS3 页面以 tie/pages/*.md 保存`
  if (source.kind === 'backend') return `${source.path}\n自定义后台存储源`
  return `${source.path}\n${source.available === false ? '当前不可访问，请检查挂载后重新载入' : '可用'}`
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
async function syncBackend() {
  try { await store.syncBackendSources() } catch { /* 后台 store 会保留错误信息 */ }
}
function openMinioForm() {
  minioError.value = ''
  minioFormOpen.value = true
  storageMenuOpen.value = false
  void refreshMinioSources()
}
async function refreshMinioSources() {
  try {
    minioSources.value = loadLocalS3Providers()
  } catch {
    minioSources.value = []
    minioError.value = '本地 S3 配置读取失败，请重新保存该连接。'
  }
}
onMounted(() => { void refreshMinioSources() })
async function saveMinio() {
  minioError.value = ''
  minioSaving.value = true
  try {
    const raw = JSON.parse(localStorage.getItem(LOCAL_S3_PROVIDERS_KEY) ?? '[]') as unknown
    const saved = Array.isArray(raw) ? raw : []
    const id = crypto.randomUUID()
    if (isDesktop) {
      await invoke('save_s3_credentials', {
        providerId: id,
        accessKey: minioAccessKey.value.trim(),
        secretKey: minioSecretKey.value,
      })
      try {
        await invoke('test_s3_connection', { providerId: id, endpoint: minioEndpoint.value.trim(), bucket: minioBucket.value.trim() })
      } catch (error) {
        await invoke('remove_s3_credentials', { providerId: id }).catch(() => undefined)
        throw error
      }
    } else {
      throw new Error('Web 预览无法访问系统凭据库，请使用桌面端保存 S3 凭据。')
    }
    saved.push({
      id,
      name: minioName.value.trim() || minioBucket.value.trim(),
      endpoint: minioEndpoint.value.trim(),
      bucket: minioBucket.value.trim(),
      region: minioRegion.value.trim() || undefined,
      credentialStored: true,
      createdAt: new Date().toISOString(),
    } satisfies LocalS3Provider)
    localStorage.setItem(LOCAL_S3_PROVIDERS_KEY, JSON.stringify(saved))
    window.dispatchEvent(new Event('tie:s3-providers-changed'))
    minioSecretKey.value = ''
    minioAccessKey.value = ''
    minioFormOpen.value = false
    minioNotice.value = 'S3 连接验证成功，配置已保存到当前设备。'
    await refreshMinioSources()
  } catch (reason) { minioError.value = reason instanceof Error ? reason.message : '保存本地 S3 配置失败' }
  finally { minioSaving.value = false }
}
async function disconnectSource(sourceId: string) {
  if (isBackendSourceId(sourceId)) return
  if ((sourcePageStats.value.get(sourceId)?.total ?? 0) > 0) return
  if (!window.confirm('断开此存储源？该目录和其中的文件不会被删除。')) return
  await store.removeStorageSource(sourceId)
}
async function renameSource(sourceId: string) {
  if (isBackendSourceId(sourceId)) return
  const source = localSources.value.find((item) => item.id === sourceId)
  if (!source) return
  const name = window.prompt('存储源显示名称（不会重命名实际目录）', source.name)
  if (name === null || name.trim() === source.name) return
  await store.renameStorageSource(sourceId, name)
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
        <button v-if="backend.connected" :disabled="backend.syncing || store.reloading" @click="syncBackend">{{ backend.syncing || store.reloading ? '同步中…' : '↻ 同步后台' }}</button>
        <button @click="storageMenuOpen = !storageMenuOpen">+ 添加存储源</button>
      </div>

      <div v-if="storageMenuOpen" class="storage-menu storage-settings-menu">
        <button :disabled="choosingWorkspace" @click="chooseWorkspace('local')"><strong>本地目录</strong><small>选择磁盘中的知识库</small></button>
        <button :disabled="choosingWorkspace" @click="chooseWorkspace('smb')"><strong>SMB 挂载目录</strong><small>选择系统已挂载的共享目录</small></button>
        <button @click="emit('connect-backend'); storageMenuOpen = false"><strong>自定义后台{{ backend.connected ? ' · 已连接' : '' }}</strong><small>{{ backend.connected ? '登录后可添加后台存储源' : '登录并添加后台存储源' }}</small></button>
        <button @click="openMinioForm"><strong>S3 兼容对象存储</strong><small>AWS S3、MinIO、R2、Ceph 等 · 本地保存</small></button>
        <button :disabled="importingMarkdown || !defaultSourceId || isBackendSourceId(defaultSourceId)" @click="importMarkdown"><strong>{{ importingMarkdown ? '正在导入…' : '导入 Markdown 文件' }}</strong><small>导入到优先级最高的可用存储源</small></button>
      </div>
      <form v-if="minioFormOpen" class="minio-config-form" @submit.prevent="saveMinio">
        <strong>连接 S3 兼容对象存储</strong><small>兼容 AWS S3、MinIO、R2、Ceph；连接配置保存在本机，密钥保存在系统凭据库。</small>
        <label>显示名称<input v-model="minioName" placeholder="例如：团队附件库" /></label><label>Endpoint<input v-model="minioEndpoint" required placeholder="https://minio.example.com" /></label><label>Bucket<input v-model="minioBucket" required placeholder="knowledge-base" /></label><label>Region（可选）<input v-model="minioRegion" placeholder="us-east-1" /></label><label>Access Key<input v-model="minioAccessKey" required autocomplete="off" /></label><label>Secret Key<input v-model="minioSecretKey" required type="password" autocomplete="new-password" /></label>
        <p v-if="minioError" class="backend-error">{{ minioError }}</p><div><button type="button" @click="minioFormOpen = false">取消</button><button type="submit" :disabled="minioSaving">{{ minioSaving ? '正在验证并保存…' : '验证并保存配置' }}</button></div>
      </form>
      <p v-if="minioNotice" class="minio-config-notice">{{ minioNotice }}</p>
      <div v-if="minioSources.length" class="minio-source-list"><strong>已配置的 S3 对象存储</strong><div v-for="source in minioSources" :key="source.id"><span>●</span><div><strong>{{ source.name }}</strong><small>{{ source.endpoint }} · {{ source.bucket }}{{ source.region ? ` · ${source.region}` : '' }} · {{ source.credentialStored ? '密钥已保存在系统凭据库' : '需要重新保存密钥' }}</small></div></div></div>

      <div v-if="orderedSources.length" class="storage-settings-list">
        <div
          v-for="source in orderedSources"
          :key="source.id"
          class="storage-settings-row"
          :class="{
            unavailable: source.available === false,
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
            <button v-if="isDesktop && (source.kind === 'local' || source.kind === 'smb')" :disabled="source.available === false" title="在文件管理器中打开" @click="openSource(source.path)">↗</button>
            <button v-if="source.kind === 'local' || source.kind === 'smb'" title="重命名显示名称" @click="renameSource(source.id)">✎</button>
            <button
              v-if="source.kind === 'local' || source.kind === 'smb'"
              :disabled="localSources.length <= 1 || sourcePageCount(source.id) > 0 || source.available === false"
              title="断开存储源"
              @click="disconnectSource(source.id)"
            >×</button>
          </div>
        </div>
      </div>
      <p v-else class="storage-settings-empty">还没有连接存储源，点击「添加存储源」开始。</p>

      <p class="storage-settings-note">所有存储源的页面都在左侧同一棵树里；这里只调整优先级和管理连接。</p>
    </section>
  </div>
</template>
