<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useWorkspaceStore } from '@/stores/workspace'
import LocalGraphPanel from '@/components/LocalGraphPanel.vue'
import {
  buildFileUrl,
  canRebindRegisteredFile,
  collectFileRefsFromMarkdown,
  collectPathRefsFromMarkdown,
  fileLinkLabel,
  fileLinkTitle,
  listRegisteredFiles,
  openRegisteredFile,
  probeRelativePath,
  resolveLinkForm,
  resourceAvailability,
  resolveRegisteredFile,
  type WorkspaceFileResource,
} from '@/services/files'
import { buildPathUrl, classifyLocalLink, fileRootForSource, sourceById, type LinkContext } from '@/services/link-runtime'
import { isCrossSourceLink, rebindLinkedResource, sourceChipLabel } from '@/services/link-actions'
import { openLocalLink } from '@/services/local-links'
import { auditActorLabel, CHANGE_AGENTS } from '@/services/change-origin'
import { listPageAuditEvents, type AuditEvent } from '@/services/audit'
import { cancelPheromoneDraft, commitPheromoneDraft, focusPheromone, loadPheromones, PHEROMONE_KIND_LABEL, PHEROMONE_STATUS_LABEL, pheromoneActorLabel, pheromoneState, pheromonesFor, setPheromonePanelOpen, startPheromoneDraft, type Pheromone, type PheromoneKind } from '@/services/pheromone'
import { CHANGE_FIELD_LABEL, CHANGE_TYPE_LABEL, resolvePageOpinion, reviewOriginDetails, reviewOriginLabel, reviewsForPage, type OpinionStatus } from '@/services/review-service'
import { isBackendSourceId } from '@/services/backend'
import { protectedPageAuthorization, protectedPagesRevision, protectedPageView } from '@/services/protected-pages'
import { isEncryptedMarkdown } from '@/services/encrypted-markdown'
import { fileIdFromFilesRelative } from '@/services/storage/blobs-path'
import type { SyncedResources } from '@/services/backend-sync'

const store = useWorkspaceStore()
const activePageView = computed(() => store.activePage ? protectedPageView(store.activePage) : null)
const CONTEXT_TAB_KEY = 'tie.context-tab'
const contextTabs = ['outline', 'properties', 'links', 'graph', 'audit'] as const
type ContextTab = (typeof contextTabs)[number]

function loadContextTab(): ContextTab {
  try {
    const saved = localStorage.getItem(CONTEXT_TAB_KEY)
    if (saved && (contextTabs as readonly string[]).includes(saved)) return saved as ContextTab
  } catch { /* 读不到时用大纲 */ }
  return 'outline'
}

const tab = ref<ContextTab>(loadContextTab())
const emit = defineEmits<{ close: [] }>()
const pheromones = computed(() => store.activePage ? pheromonesFor(store.activePage.id, store.activePage.storageSourceId) : [])
const auditEvents = ref<AuditEvent[]>([])
const reviewEntries = computed(() => store.activePage ? reviewsForPage(store.activePage.id, store.activePage.storageSourceId) : [])
const reviewVersions = computed(() => reviewEntries.value.filter((item) => item.kind === 'version'))
const finalVersion = computed(() => reviewVersions.value.find((item) => item.status === 'final') ?? null)
const changes = computed(() => reviewEntries.value.filter((item) => item.kind === 'change').sort((a, b) => b.at.localeCompare(a.at)))
const visibleAuditEvents = computed(() => auditEvents.value.filter((event) => event.type !== 'opinion' && !changes.value.some((change) => change.id === event.id || (change.at === event.at && change.type === event.type))))
const showWithdrawn = ref(false)
const visiblePheromones = computed(() => pheromones.value.filter((item) => showWithdrawn.value || item.status !== 'withdrawn'))
const withdrawnCount = computed(() => pheromones.value.filter((item) => item.status === 'withdrawn').length)
const reviewError = ref('')
const reviewBusy = ref(false)
const resolutionNotes = ref<Record<string, string>>({})
watch([
  () => store.activePage?.storageSourceId,
  () => store.activePage?.id,
  () => {
    void protectedPagesRevision.value
    const permission = store.activePage && protectedPageAuthorization(store.activePage)
    return permission ? `${permission.epoch}:${permission.generation}` : null
  },
  () => store.activePage && isEncryptedMarkdown(store.activePage.markdown) ? store.activePage.markdown : null,
], (scope, before) => {
  if (scope[3] || before[3]) resolutionNotes.value = {}
}, { flush: 'sync' })
function reviewExcerpt(markdown: string | undefined) {
  const text = (markdown ?? '').replace(/\s+/g, ' ').trim()
  return text.length > 80 ? `${text.slice(0, 80)}…` : text || '（空）'
}
const pheromoneDraft = computed(() => {
  const draft = pheromoneState.draft
  return draft && draft.pageId === store.activePage?.id ? draft : null
})
const headings = computed(() => (activePageView.value?.markdown.match(/^#{2,6} .+$/gm) ?? []).map((line, index) => ({ index, level: line.indexOf(' '), text: line.replace(/^#+ /, '') })))
const outgoing = computed(() => store.activePage ? store.outgoingLinks(store.activePage.id) : [])
const incoming = computed(() => store.activePage ? store.backlinks(store.activePage.id) : [])
const mentions = computed(() => store.activePage ? store.unlinkedMentions(store.activePage.id) : [])
const childPages = computed(() => {
  const parentId = store.activePage?.id
  if (!parentId) return []
  return store.pages
    .filter((page) => page.parentId === parentId && !page.deletedAt)
    .sort((a, b) => a.sortKey - b.sortKey || a.title.localeCompare(b.title, 'zh-CN'))
})
const linkingMentionId = ref<string | null>(null)
const fileResources = ref<WorkspaceFileResource[]>([])
const openingFileId = ref<string | null>(null)
const storageLabel = computed(() => {
  const source = store.allSources.find((item) => item.id === store.activePage?.storageSourceId)
  if (!source) return '未知工作区'
  if (source.kind === 'backend') return `后台 · ${source.name}`
  if (source.kind === 's3') return `S3 · ${source.name}`
  return source.kind === 'smb' ? `SMB · ${source.name}` : `本地 · ${source.name}`
})

const linkContext = computed<LinkContext>(() => ({
  pageSourceId: store.activePage?.storageSourceId ?? null,
  sources: store.allSources,
}))

const filesWorkspaceRoot = computed(() => {
  return fileRootForSource(sourceById(store.allSources, store.activePage?.storageSourceId))
})

const outgoingFiles = computed(() => {
  const page = activePageView.value
  if (!page) return []
  const files = collectFileRefsFromMarkdown(page.markdown).map((ref) => {
    const sourceId = ref.sourceId || page.storageSourceId
    const href = buildFileUrl(ref.fileId, sourceId)
    const link = classifyLocalLink(href)
    const resource = fileResources.value.find((item) => item.id === ref.fileId)
    const source = sourceById(store.allSources, sourceId)
    const availability = link ? resourceAvailability(link, linkContext.value) : 'unknown'
    return {
      type: 'file' as const,
      id: ref.fileId,
      sourceId,
      href,
      title: resource?.title ?? ref.fileId,
      kind: resource?.kind ?? null,
      mode: resource?.mode ?? 'link',
      exists: resource?.exists ?? false,
      availability,
      canRebind: canRebindRegisteredFile(resource),
      bindingState: resource?.bindingState,
      bindingNames: Object.values(resource?.deviceBindings ?? {}).map((binding) => binding.deviceName || binding.deviceId),
      sourceLabel: sourceChipLabel(source),
      crossSource: isCrossSourceLink(sourceId, page.storageSourceId),
    }
  })
  const paths = collectPathRefsFromMarkdown(page.markdown).map((ref) => {
    const sourceId = ref.sourceId || page.storageSourceId
    const href = buildPathUrl(ref.relativePath, sourceId)
    const link = classifyLocalLink(href)
    const source = sourceById(store.allSources, sourceId)
    const availability = link ? resourceAvailability(link, linkContext.value) : 'unknown'
    const name = ref.relativePath.split('/').filter(Boolean).pop() || ref.relativePath
    return {
      type: 'path' as const,
      id: ref.relativePath,
      sourceId,
      href,
      title: name,
      kind: null as string | null,
      mode: 'relative',
      exists: availability === 'ready',
      availability,
      canRebind: false,
      bindingState: undefined,
      bindingNames: [] as string[],
      sourceLabel: sourceChipLabel(source),
      crossSource: isCrossSourceLink(sourceId, page.storageSourceId),
    }
  })
  return [...files, ...paths]
})

let fileResourcesRequest = 0
async function refreshFileResources() {
  const request = ++fileResourcesRequest
  const page = activePageView.value
  if (!store.backgroundStarted || tab.value !== 'links' || !page) {
    fileResources.value = []
    return
  }
  const fileRefs = collectFileRefsFromMarkdown(page.markdown)
  const pathRefs = collectPathRefsFromMarkdown(page.markdown)
  const sourceIds = new Set(
    [...fileRefs.map((ref) => ref.sourceId || page.storageSourceId), ...pathRefs.map((ref) => ref.sourceId || page.storageSourceId)],
  )
  const sources = [...sourceIds]
    .map((sourceId) => sourceById(store.allSources, sourceId))
    .filter((source): source is NonNullable<typeof source> => Boolean(source))
  if (!sources.length) {
    fileResources.value = []
    return
  }
  try {
    const lists = await Promise.all(sources.map((source) => listRegisteredFiles(source)))
    if (request !== fileResourcesRequest || tab.value !== 'links' || store.activePage?.id !== page.id) return
    fileResources.value = lists.flat()
    await Promise.all(pathRefs.map(async (ref) => {
      const source = sourceById(store.allSources, ref.sourceId || page.storageSourceId)
      if (!source) return
      try {
        await probeRelativePath(source, ref.relativePath)
      } catch {
        // ignore
      }
    }))
  } catch {
    if (request === fileResourcesRequest) fileResources.value = []
  }
}

watch(
  [() => store.backgroundStarted, tab, () => store.activePage?.id, () => activePageView.value?.markdown, filesWorkspaceRoot],
  () => { void refreshFileResources() },
  { immediate: true },
)

async function openOutgoingFile(file: { type: 'file' | 'path'; id: string; sourceId: string; href: string; kind?: string | null }) {
  const source = sourceById(store.allSources, file.sourceId)
  if (!source) {
    window.alert('当前链接所属存储源不可用，无法打开文件资源。')
    return
  }
  openingFileId.value = file.id
  try {
    if (file.type === 'path') {
      await openLocalLink(file.href, linkContext.value)
      return
    }
    await openRegisteredFile(source, file.id)
  } catch (error) {
    window.alert(error instanceof Error ? error.message : '无法打开文件资源')
  } finally {
    openingFileId.value = null
  }
}

const rebindingId = ref<string | null>(null)

async function rebindOutgoingFile(file: { id: string; sourceId: string; kind?: string | null }) {
  const source = sourceById(store.allSources, file.sourceId)
  if (!source) {
    window.alert('当前链接所属存储源不可用。')
    return
  }
  rebindingId.value = file.id
  try {
    const rebound = await rebindLinkedResource(source, file.id, file.kind === 'directory' ? 'directory' : 'file')
    if (rebound) await refreshFileResources()
  } catch (error) {
    window.alert(error instanceof Error ? error.message : '无法重新绑定')
  } finally {
    rebindingId.value = null
  }
}

async function linkMention(targetPageId: string) {
  const source = store.activePage
  if (!source) return
  linkingMentionId.value = targetPageId
  try {
    await store.linkUnlinkedMention(source.id, targetPageId)
  } catch (reason) {
    window.alert(reason instanceof Error ? reason.message : '关联页面失败')
  } finally {
    linkingMentionId.value = null
  }
}

async function unlinkPage(pageId: string) {
  const source = store.activePage
  if (!source) return
  try { await store.unlinkPageReference(source.id, pageId) }
  catch (reason) { window.alert(reason instanceof Error ? reason.message : '移除页面链接失败') }
}

function quoteStillPresent(quote: string) {
  const markdown = activePageView.value?.markdown ?? ''
  if (markdown.includes(quote)) return true
  return markdown.replace(/\s+/g, ' ').includes(quote)
}

let reviewLoad = 0
async function loadAuditEvents() {
  const request = ++reviewLoad
  const page = store.activePage
  if (!store.backgroundStarted || !page) {
    auditEvents.value = []
    return
  }
  try {
    const [, events] = await Promise.all([loadPheromones(page), tab.value === 'audit' ? listPageAuditEvents(page.storageSourceId, page.id) : Promise.resolve([])])
    if (request !== reviewLoad) return
    auditEvents.value = events
    reviewError.value = ''
  } catch (error) {
    if (request === reviewLoad) reviewError.value = error instanceof Error ? error.message : '变更记录读取失败'
  }
}

async function leaveOpinion() {
  const page = store.activePage
  if (!pheromoneDraft.value || !page || reviewBusy.value) return
  reviewBusy.value = true
  reviewError.value = ''
  try {
    await commitPheromoneDraft(page)
    if (!isBackendSourceId(page.storageSourceId)) await store.syncBackendNow()
    await loadAuditEvents()
  } catch (error) {
    reviewError.value = error instanceof Error ? error.message : '意见保存失败'
  } finally { reviewBusy.value = false }
}

function replyOpinion(item: Pheromone, kind: PheromoneKind) {
  if (store.activePage) startPheromoneDraft(store.activePage.id, item.quote, kind, item.id)
}
function canAdopt(item: Pheromone) {
  return Boolean(item.baseUpdatedAt && store.activePage?.updatedAt !== item.baseUpdatedAt)
}
async function resolveOpinion(item: Pheromone, status: Exclude<OpinionStatus, 'open'>) {
  const page = store.activePage
  const entry = reviewEntries.value.find((entry) => entry.id === item.id)
  if (!page || !entry || reviewBusy.value) return
  reviewBusy.value = true
  reviewError.value = ''
  try {
    await resolvePageOpinion(page, entry, status, resolutionNotes.value[item.id] ?? '')
    if (!isBackendSourceId(page.storageSourceId)) await store.syncBackendNow()
    await loadAuditEvents()
  } catch (error) {
    reviewError.value = error instanceof Error ? error.message : '意见状态保存失败'
  } finally { reviewBusy.value = false }
}
function onReviewsChanged(event: Event) {
  const detail = (event as CustomEvent<{ sourceId: string; pageId: string }>).detail
  if (detail?.sourceId === store.activePage?.storageSourceId && detail.pageId === store.activePage?.id && !reviewBusy.value) void loadAuditEvents()
}

async function onResourcesSynced(event: Event) {
  const changes = (event as CustomEvent<SyncedResources>).detail
  const page = activePageView.value
  if (!changes?.fileIds.length || tab.value !== 'links' || !page) return
  const source = sourceById(store.allSources, changes.sourceId)
  if (!source) return
  const ids = collectFileRefsFromMarkdown(page.markdown)
    .filter((ref) => (ref.sourceId || page.storageSourceId) === changes.sourceId && changes.fileIds.includes(ref.fileId)).map((ref) => ref.fileId)
  const paths = collectPathRefsFromMarkdown(page.markdown)
    .filter((ref) => (ref.sourceId || page.storageSourceId) === changes.sourceId && changes.fileIds.includes(fileIdFromFilesRelative(ref.relativePath) ?? ''))
  if (!ids.length && !paths.length) return
  const request = ++fileResourcesRequest
  const loaded = await Promise.all([...new Set(ids)].map((id) => resolveRegisteredFile(source, id).catch(() => null)))
  await Promise.all(paths.map((ref) => probeRelativePath(source, ref.relativePath).catch(() => null)))
  if (request !== fileResourcesRequest || activePageView.value?.id !== page.id || tab.value !== 'links') return
  fileResources.value = [...fileResources.value.filter((item) => !ids.includes(item.id)), ...loaded.filter((item): item is WorkspaceFileResource => Boolean(item))]
}

watch(tab, (value) => {
  try { localStorage.setItem(CONTEXT_TAB_KEY, value) } catch { /* 写不进去时只保留本次 */ }
  setPheromonePanelOpen(value === 'audit')
}, { immediate: true })
watch(
  [() => store.backgroundStarted, tab, () => store.activePage?.id, () => store.activePage?.storageSourceId, () => store.activePage?.updatedAt, () => store.backendSyncMode],
  () => { void loadAuditEvents() },
  { immediate: true },
)
watch(() => pheromoneState.openRequest, () => { tab.value = 'audit' })
onMounted(() => {
  window.addEventListener('tie:reviews-changed', onReviewsChanged)
  window.addEventListener('tie:resources-synced', onResourcesSynced)
  if (pheromoneState.draft || pheromoneState.openRequest > 0) tab.value = 'audit'
})
onBeforeUnmount(() => {
  fileResourcesRequest += 1
  reviewLoad += 1
  window.removeEventListener('tie:reviews-changed', onReviewsChanged)
  window.removeEventListener('tie:resources-synced', onResourcesSynced)
  setPheromonePanelOpen(false)
})
</script>

<template>
  <aside class="context-panel">
    <div class="context-tabs">
      <button :class="{ active: tab === 'outline' }" @click="tab = 'outline'">大纲</button>
      <button :class="{ active: tab === 'properties' }" @click="tab = 'properties'">属性</button>
      <button :class="{ active: tab === 'links' }" @click="tab = 'links'">链接</button>
      <button :class="{ active: tab === 'graph' }" @click="tab = 'graph'">图谱</button>
      <button :class="{ active: tab === 'audit' }" @click="tab = 'audit'">变更</button>
      <button class="context-collapse-button" type="button" title="收起右侧栏" aria-label="收起右侧栏" @click="emit('close')">‹</button>
    </div>
    <div v-if="tab === 'outline'" class="context-content outline-list">
      <p v-if="!headings.length" class="muted">添加标题后将在这里生成大纲。</p>
      <button v-for="heading in headings" :key="`${heading.index}-${heading.text}`" :style="{ paddingLeft: `${(heading.level - 1) * 10}px` }" @click="store.scrollToOutlineHeading(heading.index)">{{ heading.text }}</button>
    </div>
    <div v-else-if="tab === 'properties'" class="context-content property-list">
      <div><span>更新</span><strong>{{ store.activePage?.updatedAt.slice(0, 19).replace('T', ' ') }}</strong></div>
      <div><span>标签</span><strong>{{ store.activePage?.tags.length ? store.activePage.tags.map((tag) => `#${tag}`).join(' ') : '无' }}</strong></div>
      <div><span>存储</span><strong>{{ storageLabel }}</strong></div>
      <div><span>出链</span><strong>{{ outgoing.length }}</strong></div>
      <div><span>文件</span><strong>{{ outgoingFiles.length }}</strong></div>
      <div><span>回链</span><strong>{{ incoming.length }}</strong></div>
    </div>
    <div v-else-if="tab === 'links'" class="context-content link-panel">
      <section>
        <h3>子页面</h3>
        <p v-if="!childPages.length" class="muted">无子页面。侧栏或「新建子页面」会按 parent_id 挂接，不写入正文。</p>
        <button v-for="page in childPages" :key="`child-${page.id}`" @click="store.openPage(page.id)"><span>↳</span>{{ page.title }}</button>
      </section>
      <section>
        <h3>出链</h3>
        <p v-if="!outgoing.length" class="muted">还没有出链。输入 [[ 可创建页面链接。</p>
        <div v-for="page in outgoing" :key="`out-${page.id}`" class="mention-row">
          <button @click="store.openPage(page.id)"><span>↗</span>{{ page.title }}</button>
          <button class="unlink-action" title="移除正文中的链接" @click="unlinkPage(page.id)">×</button>
        </div>
      </section>
      <section>
        <h3>文件资源</h3>
        <p v-if="!outgoingFiles.length" class="muted">正文中的 tie://file/… 与 tie://path/… 会显示在这里（实心=库内，空心=本机；找不到会单独标出）。</p>
        <div v-for="file in outgoingFiles" :key="`file-${file.type}-${file.sourceId}-${file.id}`" class="mention-row file-link-row">
          <button
            class="file-resource-open"
            :class="{ directory: file.kind === 'directory', missing: file.availability === 'missing' || file.availability === 'offline' }"
            :disabled="openingFileId === file.id"
            :title="file.availability === 'missing' ? '路径不可用' : (file.kind === 'directory' ? '打开目录' : file.id)"
            @click="openOutgoingFile(file)"
          >{{ file.title }}</button>
          <em
            class="file-mode-badge"
            :class="[resolveLinkForm(file.mode) || undefined, file.availability]"
            :title="fileLinkTitle(file.mode, file.kind, file.availability)"
          >{{ fileLinkLabel(file.mode, file.kind, file.availability) }}</em>
          <small v-if="file.crossSource && file.sourceLabel" class="file-source-badge" :title="file.sourceLabel">{{ file.sourceLabel }}</small>
          <small v-if="file.bindingNames.length" class="resource-device-label">已绑定设备：{{ file.bindingNames.join('、') }}</small>
          <button
            v-if="file.canRebind"
            class="mention-link-action"
            type="button"
            :disabled="rebindingId === file.id"
            title="选择本机路径；保留其他设备的绑定和原链接 id"
            @click="rebindOutgoingFile(file)"
          >{{ rebindingId === file.id ? '绑定中…' : (file.bindingState === 'other-device' || file.bindingState === 'unbound' ? '绑定到本机' : '重新绑定') }}</button>
        </div>
      </section>
      <section>
        <h3>回链</h3>
        <p v-if="!incoming.length" class="muted">还没有其他页面指向这里。</p>
        <button v-for="page in incoming" :key="`in-${page.id}`" @click="store.openPage(page.id)"><span>↙</span>{{ page.title }}</button>
      </section>
      <section>
        <h3>未链接提及</h3>
        <p v-if="!mentions.length" class="muted">没有检测到未链接的标题提及。</p>
        <div v-for="page in mentions" :key="`mention-${page.id}`" class="mention-row">
          <button title="正文中出现了该页面标题，但尚未建立页面链接" @click="store.openPage(page.id)"><span>⌁</span>{{ page.title }}</button>
          <button class="mention-link-action" :disabled="linkingMentionId === page.id" :title="`将当前页首次提及“${page.title}”的文字转换为页面链接`" @click="linkMention(page.id)">{{ linkingMentionId === page.id ? '关联中…' : '关联' }}</button>
        </div>
        <p class="mention-hint">正文中出现标题但未建立链接；可在编辑器中输入 [[ 进行关联。</p>
      </section>
    </div>
    <div v-else-if="tab === 'graph'" class="context-content graph-panel graph-panel-obsidian">
      <LocalGraphPanel v-if="store.activePage" />
      <p v-else class="muted">打开页面后显示局部图谱。</p>
    </div>
    <div v-else class="context-content audit-panel">
      <p v-if="reviewError" class="review-error" role="alert">{{ reviewError }} <button type="button" @click="loadAuditEvents">重试</button></p>
      <section v-if="changes.length" aria-label="保存变更">
        <h3>保存变更</h3>
        <article v-for="item in changes" :key="item.id" class="audit-event" :data-change-id="item.id">
          <header>
            <strong>{{ CHANGE_TYPE_LABEL[item.type || ''] || item.type || '保存修改' }}</strong>
            <time>{{ item.at.slice(0, 16).replace('T', ' ') }}</time>
          </header>
          <p :title="reviewOriginDetails(item.origin)">{{ reviewOriginLabel(item.origin, item.actor) }}</p>
          <p v-if="item.changedFields?.length">{{ item.changedFields.map((field) => CHANGE_FIELD_LABEL[field] || field).join('、') }}</p>
        </article>
      </section>
      <section v-if="reviewVersions.length">
        <h3>最终版本</h3>
        <p class="muted">{{ finalVersion ? `正文已采用选定版本（${finalVersion.actor}）。另一份留在下面。` : '两边都改过时会保留双方版本，正文不会自动覆盖，请先比较后处理。' }}</p>
        <article v-for="item in reviewVersions" :key="item.id" class="audit-event">
          <header>
            <strong>{{ item.status === 'final' ? '最终版本' : (item.status === 'dropped' ? '未采用' : '待选') }}</strong>
            <span>{{ item.actor || '另一端' }}</span>
            <time>{{ item.at.slice(0, 16).replace('T', ' ') }}</time>
          </header>
          <p>{{ reviewExcerpt(item.markdown) }}</p>
        </article>
      </section>
      <form v-if="pheromoneDraft" class="pheromone-draft" @submit.prevent="leaveOpinion">
        <header><em :class="pheromoneDraft.kind">{{ PHEROMONE_KIND_LABEL[pheromoneDraft.kind] }}</em><span>{{ pheromoneDraft.replyTo ? '回复这条意见' : '针对这段原文' }}</span></header>
        <blockquote>{{ pheromoneDraft.quote }}</blockquote>
        <div class="pheromone-origin">
          <span :title="pheromoneState.clientLabel">{{ pheromoneState.clientLabel }}</span>
          <select v-model="pheromoneDraft.agent" aria-label="来源 Agent">
            <option value="">本客户端</option>
            <option v-for="name in CHANGE_AGENTS" :key="name" :value="name">{{ name }}</option>
          </select>
        </div>
        <textarea v-model="pheromoneDraft.body" rows="3" autofocus :placeholder="pheromoneDraft.kind === 'correction' ? '写下修正' : (pheromoneDraft.kind === 'objection' ? '写下异议' : '写下支持的理由')"></textarea>
        <div>
          <button type="submit" :disabled="reviewBusy || !pheromoneDraft.body.trim()">{{ reviewBusy ? '保存中…' : '留下' }}</button>
          <button type="button" @click="cancelPheromoneDraft">取消</button>
        </div>
      </form>
      <p v-if="!pheromones.length && !pheromoneDraft" class="muted">这一页还没有信息素。</p>
      <label v-if="withdrawnCount" class="review-withdrawn-toggle"><input v-model="showWithdrawn" type="checkbox"> 显示已撤回（{{ withdrawnCount }}）</label>
      <article
        v-for="item in visiblePheromones"
        :key="item.id"
        class="pheromone-card"
        :class="[item.kind, { active: pheromoneState.activeId === item.id, orphan: !quoteStillPresent(item.quote) }]"
        :data-pheromone-card="item.id"
        :data-pheromone-kind="item.kind"
        @click="focusPheromone(item.id)"
      >
        <header>
          <em>{{ PHEROMONE_KIND_LABEL[item.kind] }}</em>
          <strong :title="reviewOriginDetails(item.origin)">{{ pheromoneActorLabel(item) }}</strong>
          <time>{{ item.createdAt.slice(0, 16).replace('T', ' ') }}</time>
        </header>
        <small>{{ PHEROMONE_STATUS_LABEL[item.status || 'open'] }}{{ item.replyTo ? ' · 回复意见' : '' }}{{ item.durable ? '' : ' · 尚未导入共享记录' }}</small>
        <p class="pheromone-quote">{{ item.quote }}</p>
        <p class="pheromone-body">{{ item.body }}</p>
        <small v-if="!quoteStillPresent(item.quote)">原文已不在页面中</small>
        <template v-if="item.status !== 'withdrawn' && item.durable">
          <div class="review-actions" @click.stop>
            <button type="button" :disabled="reviewBusy" @click="replyOpinion(item, 'support')">回复支持</button>
            <button type="button" :disabled="reviewBusy" @click="replyOpinion(item, 'correction')">回复修正</button>
            <button type="button" :disabled="reviewBusy" @click="replyOpinion(item, 'objection')">回复异议</button>
          </div>
          <input v-if="item.status === 'open'" v-model="resolutionNotes[item.id]" class="review-resolution-note" aria-label="处理说明" placeholder="处理说明（可选）" @click.stop>
          <div class="review-actions" @click.stop>
            <button v-if="item.status === 'open'" type="button" :disabled="reviewBusy" @click="resolveOpinion(item, 'resolved')">已处理</button>
            <button v-if="item.status === 'open'" type="button" :disabled="reviewBusy || !canAdopt(item)" title="修改并保存正文后，将此意见关联到已保存的版本" @click="resolveOpinion(item, 'adopted')">采用已保存修改</button>
            <button type="button" :disabled="reviewBusy" @click="resolveOpinion(item, 'withdrawn')">撤回</button>
          </div>
        </template>
        <small v-if="item.resolutionOrigin" :title="reviewOriginDetails(item.resolutionOrigin)">处理：{{ reviewOriginLabel(item.resolutionOrigin) }}</small>
        <small v-if="item.resolutionNote">{{ item.resolutionNote }}</small>
        <small v-if="item.appliedUpdatedAt">采用版本：{{ item.appliedUpdatedAt.slice(0, 19).replace('T', ' ') }}</small>
      </article>
      <article v-for="(event, index) in visibleAuditEvents" :key="`${event.at}-${index}`" class="audit-event">
        <header>
          <strong :title="reviewOriginDetails(event.origin)">{{ event.origin ? reviewOriginLabel(event.origin, event.actor) : auditActorLabel(event.actor) }}</strong>
          <time>{{ event.at.slice(0, 16).replace('T', ' ') }}</time>
        </header>
        <p>{{ event.title || event.note || event.type }}</p>
      </article>
    </div>
  </aside>
</template>

<style scoped>
.review-actions { display: flex; flex-wrap: wrap; gap: 5px; }
.review-actions button, .review-error button { border: 1px solid var(--border); border-radius: 5px; padding: 3px 5px; color: var(--text-muted); background: var(--bg-elevated); font-size: 11px; cursor: pointer; }
.review-actions button:disabled { opacity: .45; cursor: default; }
.review-resolution-note { min-width: 0; width: 100%; box-sizing: border-box; border: 1px solid var(--border); border-radius: 5px; padding: 5px; color: var(--text); background: var(--bg-main); font-size: 12px; }
.review-withdrawn-toggle { display: flex; align-items: center; gap: 4px; color: var(--text-muted); font-size: 11px; }
.review-error { color: var(--text-muted); font-size: 12px; }
.resource-device-label { flex-basis: 100%; color: var(--text-faint); font-size: 10px; overflow-wrap: anywhere; }
</style>
