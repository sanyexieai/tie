<script setup lang="ts">
import { computed, ref } from 'vue'
import { openPath } from '@tauri-apps/plugin-opener'
import type { StorageKind, StorageSource } from '@/types'
import { useWorkspaceStore } from '@/stores/workspace'
import { useBackendStore } from '@/stores/backend'
import { isBackendSourceId } from '@/services/backend'

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

const localSources = computed(() => store.workspace?.sources ?? [])
const orderedSources = computed(() => store.allSources)
const defaultSourceId = computed(() => store.defaultStorageSourceId)

const sourcePageStats = computed(() => new Map(orderedSources.value.map((source) => {
  const pages = store.pages.filter((page) => page.storageSourceId === source.id)
  return [source.id, { total: pages.length, active: pages.filter((page) => !page.deletedAt).length, trashed: pages.filter((page) => page.deletedAt).length }]
})))

function sourceLabel(kind: StorageKind) {
  if (kind === 'smb') return 'SMB 挂载目录'
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
  if (source.available === false) return '当前不可访问'
  return `${sourceLabel(source.kind)} · ${sourcePageLabel(source.id)}`
}
function sourceTitle(source: StorageSource) {
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
        <button @click="storageMenuOpen = !storageMenuOpen">+ 添加存储源</button>
      </div>

      <div v-if="storageMenuOpen" class="storage-menu storage-settings-menu">
        <button :disabled="choosingWorkspace" @click="chooseWorkspace('local')"><strong>本地目录</strong><small>选择磁盘中的知识库</small></button>
        <button :disabled="choosingWorkspace" @click="chooseWorkspace('smb')"><strong>SMB 挂载目录</strong><small>选择系统已挂载的共享目录</small></button>
        <button @click="emit('connect-backend'); storageMenuOpen = false"><strong>自定义后台{{ backend.connected ? ' · 已连接' : '' }}</strong><small>{{ backend.connected ? '登录后可添加后台存储源' : '登录并添加后台存储源' }}</small></button>
        <button :disabled="importingMarkdown || !defaultSourceId || isBackendSourceId(defaultSourceId)" @click="importMarkdown"><strong>{{ importingMarkdown ? '正在导入…' : '导入 Markdown 文件' }}</strong><small>导入到优先级最高的可用存储源</small></button>
      </div>

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
            <button v-if="isDesktop && source.kind !== 'backend'" :disabled="source.available === false" title="在文件管理器中打开" @click="openSource(source.path)">↗</button>
            <button v-if="source.kind !== 'backend'" title="重命名显示名称" @click="renameSource(source.id)">✎</button>
            <button
              v-if="source.kind !== 'backend'"
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
