<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useWorkspaceStore } from '@/stores/workspace'
import { useBackendStore } from '@/stores/backend'
import type { Page, PageRevision } from '@/types'
import TiptapEditor from '@/components/TiptapEditor.vue'
import DocumentMeta from '@/components/DocumentMeta.vue'
import { aiTaggingReady, loadAiTaggingConfig, suggestTagsWithAi } from '@/services/ai-tagging'
import { isBackendRemoteSourceId } from '@/services/backend'
import { isS3SourceId } from '@/services/s3'
import { suggestTags, type TagSuggestion } from '@/services/tagging'
import { revealItemInDir } from '@tauri-apps/plugin-opener'

const store = useWorkspaceStore()
const backend = useBackendStore()
const isDesktop = '__TAURI_INTERNALS__' in window
const title = ref('')
const bodyMarkdown = ref('')
const tags = ref<string[]>([])
const tagDraft = ref('')
const sourceMenuOpen = ref(false)
const manualSaveNotice = ref(false)
const copiedLinkNotice = ref(false)
const exportedNotice = ref(false)
const refreshedNotice = ref(false)
const refreshing = ref(false)
const hasUnsavedChanges = ref(false)
const saveError = ref<string | null>(null)
const conflictRemotePage = ref<Page | null>(null)
const conflictLoading = ref(false)
const showingFind = ref(false)
const findQuery = ref('')
const findReplacement = ref('')
const findResult = ref({ count: 0, index: 0 })
const replaceNotice = ref('')
const showingHistory = ref(false)
const historyLoading = ref(false)
const revisions = ref<PageRevision[]>([])
const selectedRevision = ref<Page | null>(null)
const selectedRevisionId = ref<string | null>(null)
const revisionPreviewLoading = ref(false)
const revisionPreviewError = ref<string | null>(null)
const tagSuggestions = ref<TagSuggestion[]>([])
const tagSuggestLoading = ref(false)
const documentRoot = ref<HTMLElement | null>(null)
const sourceEditor = ref<HTMLTextAreaElement | null>(null)
const richEditor = ref<{ undo: () => void; redo: () => void; findText: (query: string, direction?: number) => { count: number; index: number }; focusBlank?: (event: MouseEvent) => boolean } | null>(null)
let manualSaveTimer: number | undefined
let copiedLinkTimer: number | undefined
let exportedTimer: number | undefined
let refreshedTimer: number | undefined
let autoSaveTimer: number | undefined
let changeRevision = 0

const status = computed(() => {
  const savedLabel = activeSource.value?.kind === 'backend' ? '已保存到后台' : '已保存到本地'
  return store.saving
    ? '保存中…'
    : refreshing.value
      ? '刷新中…'
      : saveError.value
        ? '保存失败'
        : hasUnsavedChanges.value
          ? '未保存'
          : refreshedNotice.value
            ? '已从存储刷新'
            : exportedNotice.value
              ? '已导出 Markdown'
              : copiedLinkNotice.value
                ? '已复制页面链接'
                : manualSaveNotice.value
                  ? '已手动保存'
                  : savedLabel
})
const isFavorite = computed(() => Boolean(store.activePage && store.favoritePageIds.includes(store.activePage.id)))
const activeSource = computed(() => store.allSources.find((source) => source.id === store.activePage?.storageSourceId) ?? null)
const supportsRemoteConflict = computed(() => Boolean(
  activeSource.value && (isBackendRemoteSourceId(activeSource.value.id) || isS3SourceId(activeSource.value.id)),
))
const hasRemoteSaveConflict = computed(() => supportsRemoteConflict.value && saveError.value?.includes('其他设备更新'))
const hasSyncConflict = computed(() => Boolean(store.activePage && store.syncConflicts.has(store.activePage.id)))
const hasRemoteConflict = computed(() => hasRemoteSaveConflict.value || hasSyncConflict.value)
const remoteConflictLabel = computed(() => {
  if (activeSource.value?.kind === 'backend') return '后台'
  if (isS3SourceId(activeSource.value?.id ?? '')) return '远程'
  return '远程'
})
const transferTargets = computed(() => (
  store.activePage
    ? store.allSources.filter((source) => store.canTransferPageTo(source.id))
    : []
))
const canSwitchStorageSource = computed(() => transferTargets.value.length > 0)
const conflictLocalMarkdown = computed(() => `# ${title.value.trim() || '无标题'}\n\n${bodyMarkdown.value}`)
type ConflictLine = { text: string; kind: 'same' | 'changed' }
const conflictDiff = computed(() => {
  const remote = conflictRemotePage.value?.markdown
  if (!remote) return { local: [] as ConflictLine[], remote: [] as ConflictLine[] }
  const localLines = conflictLocalMarkdown.value.split('\n')
  const remoteLines = remote.split('\n')
  if (localLines.length * remoteLines.length > 120_000) {
    return { local: localLines.map((text) => ({ text, kind: 'changed' as const })), remote: remoteLines.map((text) => ({ text, kind: 'changed' as const })) }
  }
  const matrix = Array.from({ length: localLines.length + 1 }, () => new Uint16Array(remoteLines.length + 1))
  for (let localIndex = localLines.length - 1; localIndex >= 0; localIndex -= 1) for (let remoteIndex = remoteLines.length - 1; remoteIndex >= 0; remoteIndex -= 1) {
    matrix[localIndex][remoteIndex] = localLines[localIndex] === remoteLines[remoteIndex]
      ? matrix[localIndex + 1][remoteIndex + 1] + 1
      : Math.max(matrix[localIndex + 1][remoteIndex], matrix[localIndex][remoteIndex + 1])
  }
  const local: ConflictLine[] = []
  const remoteResult: ConflictLine[] = []
  let localIndex = 0
  let remoteIndex = 0
  while (localIndex < localLines.length && remoteIndex < remoteLines.length) {
    if (localLines[localIndex] === remoteLines[remoteIndex]) {
      local.push({ text: localLines[localIndex++], kind: 'same' })
      remoteResult.push({ text: remoteLines[remoteIndex++], kind: 'same' })
    } else if (matrix[localIndex + 1][remoteIndex] >= matrix[localIndex][remoteIndex + 1]) local.push({ text: localLines[localIndex++], kind: 'changed' })
    else remoteResult.push({ text: remoteLines[remoteIndex++], kind: 'changed' })
  }
  while (localIndex < localLines.length) local.push({ text: localLines[localIndex++], kind: 'changed' })
  while (remoteIndex < remoteLines.length) remoteResult.push({ text: remoteLines[remoteIndex++], kind: 'changed' })
  return { local, remote: remoteResult }
})
function sourceBadgeLabel(kind: string) {
  if (kind === 'smb') return 'SMB 工作区'
  if (kind === 'backend') return '自定义后台'
  return '本地工作区'
}
const breadcrumbs = computed(() => {
  const current = store.activePage
  if (!current) return []
  const items: Page[] = []
  const seen = new Set<string>()
  let page: Page | undefined = current
  while (page && !seen.has(page.id)) {
    seen.add(page.id)
    items.unshift(page)
    page = page.parentId ? store.pages.find((candidate) => candidate.id === page!.parentId && !candidate.deletedAt) : undefined
  }
  return items
})
const wordCount = computed(() => bodyMarkdown.value
  .replace(/```[\s\S]*?```/g, '')
  .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
  .replace(/[#>*_~`|()[\]]/g, ' ')
  .replace(/\s/g, '')
  .length)

function loadActivePage() {
  const page = store.activePage
  title.value = page?.title ?? ''
  bodyMarkdown.value = page?.markdown.replace(/^# .*\n?/, '') ?? ''
  tags.value = page?.tags ?? []
  tagDraft.value = ''
  tagSuggestions.value = []
  hasUnsavedChanges.value = false
  saveError.value = null
}

watch(() => store.activePageId, loadActivePage, { immediate: true })
watch(() => store.outlineScrollRequest, async () => {
  if (store.outlineScrollTarget === null) return
  await nextTick()
  if (store.sourceMode) {
    const input = sourceEditor.value
    if (!input) return
    const lines = bodyMarkdown.value.split('\n')
    const headingLines = lines.reduce<number[]>((indexes, line, index) => {
      if (/^#{2,6} .+$/.test(line)) indexes.push(index)
      return indexes
    }, [])
    const lineIndex = headingLines[store.outlineScrollTarget]
    if (lineIndex === undefined) return
    const selectionStart = lines.slice(0, lineIndex).reduce((total, line) => total + line.length + 1, 0)
    input.focus()
    input.setSelectionRange(selectionStart, selectionStart)
    input.scrollTop = Math.max(0, lineIndex * 25 - input.clientHeight / 2)
    return
  }
  const headings = documentRoot.value?.querySelectorAll<HTMLElement>('.tiptap-content h2, .tiptap-content h3, .tiptap-content h4, .tiptap-content h5, .tiptap-content h6')
  headings?.[store.outlineScrollTarget]?.scrollIntoView({ behavior: 'smooth', block: 'center' })
})

function queueAutoSave(page: Page, revision: number) {
  if (autoSaveTimer) window.clearTimeout(autoSaveTimer)
  autoSaveTimer = window.setTimeout(async () => {
    try {
      await store.persist(page)
      if (revision === changeRevision) hasUnsavedChanges.value = false
      saveError.value = null
    } catch (reason) {
      saveError.value = saveFailureMessage(reason)
      if (hasRemoteConflict.value) void loadConflictPreview()
    }
  }, 650)
}

function saveFailureMessage(reason: unknown) {
  return reason instanceof Error && reason.message
    ? reason.message
    : '无法写入页面，请检查存储源连接或目录权限。'
}

async function loadConflictPreview() {
  if (conflictLoading.value || !supportsRemoteConflict.value || !store.activePage) return
  conflictLoading.value = true
  try { conflictRemotePage.value = await store.readLatestPage(store.activePage.id) }
  catch (reason) { saveError.value = saveFailureMessage(reason) }
  finally { conflictLoading.value = false }
}

const emit = defineEmits<{ 'toggle-sidebar': []; 'toggle-focus': []; 'toggle-context': [] }>()

function draft() {
  if (!store.activePage) return null
  const cleanTitle = title.value.trim() || '无标题'
  return { ...store.activePage, icon: '', title: cleanTitle, markdown: `# ${cleanTitle}\n\n${bodyMarkdown.value}`, tags: tags.value }
}

function onInput() {
  const page = draft()
  if (!page) return
  hasUnsavedChanges.value = true
  saveError.value = null
  changeRevision += 1
  queueAutoSave(page, changeRevision)
}

async function saveNow() {
  const page = draft()
  if (!page) return false
  if (autoSaveTimer) window.clearTimeout(autoSaveTimer)
  try {
    await store.persist(page)
    hasUnsavedChanges.value = false
    saveError.value = null
    manualSaveNotice.value = true
    if (manualSaveTimer) window.clearTimeout(manualSaveTimer)
    manualSaveTimer = window.setTimeout(() => { manualSaveNotice.value = false }, 2400)
    return true
  } catch (reason) {
    saveError.value = saveFailureMessage(reason)
    if (hasRemoteConflict.value) void loadConflictPreview()
    return false
  }
}

async function reloadRemotePage() {
  if (!supportsRemoteConflict.value) return
  if (!window.confirm(`将重新载入${remoteConflictLabel.value}版本，当前未保存的本地修改会丢失。是否继续？`)) return
  try {
    await store.reloadWorkspace()
    loadActivePage()
    saveError.value = null
    conflictRemotePage.value = null
    store.clearSyncConflict(store.activePage?.id)
  } catch (reason) {
    saveError.value = saveFailureMessage(reason)
  }
}

async function forceOverwriteRemote() {
  const page = draft()
  if (!page || !supportsRemoteConflict.value) return
  if (!window.confirm(`将用本地草稿覆盖${remoteConflictLabel.value}版本，其他设备上的修改会丢失。是否继续？`)) return
  try {
    await store.persist(page, { force: true })
    hasUnsavedChanges.value = false
    saveError.value = null
    conflictRemotePage.value = null
    manualSaveNotice.value = true
    if (manualSaveTimer) window.clearTimeout(manualSaveTimer)
    manualSaveTimer = window.setTimeout(() => { manualSaveNotice.value = false }, 2400)
  } catch (reason) {
    saveError.value = saveFailureMessage(reason)
  }
}

async function copyConflictDraft() {
  try { await navigator.clipboard.writeText(conflictLocalMarkdown.value) }
  catch {
    const input = document.createElement('textarea')
    input.value = conflictLocalMarkdown.value
    input.style.position = 'fixed'
    input.style.opacity = '0'
    document.body.append(input)
    input.select()
    document.execCommand('copy')
    input.remove()
  }
}

async function transferStorage(targetSourceId: string) {
  if (!store.activePage || targetSourceId === store.activePage.storageSourceId) {
    sourceMenuOpen.value = false
    return
  }
  const target = store.allSources.find((source) => source.id === targetSourceId)
  sourceMenuOpen.value = false
  if (!target || !store.canTransferPageTo(targetSourceId)) return
  const historyNotice = store.transferHistoryNotice(store.activePage.storageSourceId, targetSourceId)
  if (!window.confirm(`将“${store.activePage.title}”及其全部子页面迁移到“${target.name}”？${historyNotice}`)) {
    return
  }
  if (!await saveNow()) {
    return
  }
  try {
    await store.transferPage(store.activePage.id, targetSourceId, true)
    saveError.value = null
  } catch {
    saveError.value = '无法迁移页面，请检查目标存储源连接或目录权限。'
  }
}

async function copyPageLink() {
  const page = store.activePage
  if (!page) return
  const text = `[${page.title || '无标题'}](tie://page/${page.id})`
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    const input = document.createElement('textarea')
    input.value = text
    input.style.position = 'fixed'
    input.style.opacity = '0'
    document.body.append(input)
    input.select()
    document.execCommand('copy')
    input.remove()
  }
  copiedLinkNotice.value = true
  if (copiedLinkTimer) window.clearTimeout(copiedLinkTimer)
  copiedLinkTimer = window.setTimeout(() => { copiedLinkNotice.value = false }, 2400)
}

async function revealPageFile() {
  const page = store.activePage
  const source = activeSource.value
  if (!page || !source || !isDesktop) return
  const separator = source.path.includes('\\') ? '\\' : '/'
  await revealItemInDir(`${source.path}${separator}pages${separator}${page.id}.md`)
}

async function exportMarkdown() {
  const page = store.activePage
  if (!page || !await store.exportPageMarkdown(page.id)) return
  exportedNotice.value = true
  if (exportedTimer) window.clearTimeout(exportedTimer)
  exportedTimer = window.setTimeout(() => { exportedNotice.value = false }, 2400)
}

async function refreshCurrentPage() {
  if (!store.activePage || refreshing.value) return
  if (hasUnsavedChanges.value && !window.confirm('当前有未保存修改，从存储刷新将丢弃这些修改。是否继续？')) return
  if (autoSaveTimer) {
    window.clearTimeout(autoSaveTimer)
    autoSaveTimer = undefined
  }
  refreshing.value = true
  saveError.value = null
  try {
    await store.refreshPage(store.activePage.id)
    loadActivePage()
    conflictRemotePage.value = null
    showingHistory.value = false
    refreshedNotice.value = true
    if (refreshedTimer) window.clearTimeout(refreshedTimer)
    refreshedTimer = window.setTimeout(() => { refreshedNotice.value = false }, 2400)
  } catch (reason) {
    saveError.value = saveFailureMessage(reason)
  } finally {
    refreshing.value = false
  }
}

async function openHistory() {
  if (!store.activePage) return
  showingHistory.value = true
  selectedRevision.value = null
  selectedRevisionId.value = null
  revisionPreviewError.value = null
  historyLoading.value = true
  try { revisions.value = await store.listPageRevisions(store.activePage.id) } finally { historyLoading.value = false }
}

async function previewRevision(revision: PageRevision) {
  if (!store.activePage) return
  selectedRevisionId.value = revision.id
  selectedRevision.value = null
  revisionPreviewError.value = null
  revisionPreviewLoading.value = true
  try {
    selectedRevision.value = await store.readPageRevision(store.activePage.id, revision.id)
  } catch {
    revisionPreviewError.value = '无法读取该历史版本，可能已被外部同步工具移除。'
  } finally { revisionPreviewLoading.value = false }
}

async function restoreRevision(revision: PageRevision) {
  if (!store.activePage || !window.confirm(`恢复“${revision.title}”的历史版本？当前内容会先自动保留为新版本。`)) return
  const restored = await store.restorePageRevision(store.activePage.id, revision.id)
  if (!restored) return
  loadActivePage()
  showingHistory.value = false
  selectedRevisionId.value = null
  manualSaveNotice.value = true
  if (manualSaveTimer) window.clearTimeout(manualSaveTimer)
  manualSaveTimer = window.setTimeout(() => { manualSaveNotice.value = false }, 2400)
}

function onBodyChange(markdown: string) {
  bodyMarkdown.value = markdown
  onInput()
}

function onTitleChange(value: string) { title.value = value; onInput() }
function addTags(value: string) {
  const additions = value.split(',').map((tag) => tag.trim()).filter(Boolean)
  if (!additions.length) return
  tags.value = [...new Set([...tags.value, ...additions])]
  tagDraft.value = ''
  tagSuggestions.value = tagSuggestions.value.filter((suggestion) => !additions.includes(suggestion.tag))
  onInput()
}
function removeTag(tag: string) { tags.value = tags.value.filter((item) => item !== tag); onInput() }
function selectTag(tag: string) { store.openTags(tag) }
async function generateTagSuggestions() {
  if (tagSuggestLoading.value) return
  tagSuggestLoading.value = true
  try {
    const input = {
      title: title.value,
      markdown: bodyMarkdown.value,
      existingTags: tags.value,
      workspaceTags: store.tagIndex.map((tag) => tag.name),
    }
    const aiConfig = loadAiTaggingConfig()
    const aiSuggestions = aiTaggingReady(aiConfig)
      ? await suggestTagsWithAi(aiConfig, input, backend.profile).catch((error) => {
        console.warn('AI 标签提取失败', error)
        return []
      })
      : []
    const localSuggestions = suggestTags(input)
    const merged = new Map<string, TagSuggestion>()
    for (const suggestion of [...aiSuggestions, ...localSuggestions]) {
      const existing = merged.get(suggestion.tag.toLocaleLowerCase())
      merged.set(suggestion.tag.toLocaleLowerCase(), existing
        ? { ...existing, score: existing.score + suggestion.score, reasons: [...new Set([...existing.reasons, ...suggestion.reasons])] }
        : suggestion)
    }
    tagSuggestions.value = [...merged.values()].sort((a, b) => b.score - a.score || a.tag.localeCompare(b.tag, 'zh-CN')).slice(0, 8)
  } finally {
    tagSuggestLoading.value = false
  }
}
function acceptTagSuggestions() {
  if (!tagSuggestions.value.length) return
  addTags(tagSuggestions.value.map((suggestion) => suggestion.tag).join(','))
  tagSuggestions.value = []
}

function navigateToPage(pageId: string) { store.openPage(pageId) }

function toggleSourceMode() { store.toggleSourceMode() }
function undo() { richEditor.value?.undo() }
function redo() { richEditor.value?.redo() }

function onEditorSurfaceClick(event: MouseEvent) {
  const target = event.target
  if (!(target instanceof Element)) return
  if (!target.classList.contains('editor-scroll') && !target.classList.contains('document') && !target.classList.contains('source-editor-panel')) return
  if (store.sourceMode) {
    sourceEditor.value?.focus()
    return
  }
  richEditor.value?.focusBlank?.(event)
}

function openFind() {
  showingFind.value = true
  requestAnimationFrame(() => documentRoot.value?.querySelector<HTMLInputElement>('.document-find input')?.focus())
}
function closeFind() {
  showingFind.value = false
  findQuery.value = ''
  findReplacement.value = ''
  findResult.value = { count: 0, index: 0 }
  replaceNotice.value = ''
}
function findInSource(direction: number) {
  const input = sourceEditor.value
  const query = findQuery.value.trim()
  if (!input || !query) return { count: 0, index: 0 }
  const text = input.value.toLocaleLowerCase()
  const needle = query.toLocaleLowerCase()
  const matches: number[] = []
  let offset = text.indexOf(needle)
  while (offset >= 0) {
    matches.push(offset)
    offset = text.indexOf(needle, offset + Math.max(needle.length, 1))
  }
  if (!matches.length) return { count: 0, index: 0 }
  const cursor = direction > 0 ? input.selectionEnd : input.selectionStart
  let index = direction > 0 ? matches.findIndex((position) => position >= cursor) : matches.map((position, matchIndex) => ({ position, matchIndex })).reverse().find((item) => item.position < cursor)?.matchIndex ?? -1
  if (index < 0) index = direction > 0 ? 0 : matches.length - 1
  input.focus()
  input.setSelectionRange(matches[index], matches[index] + query.length)
  return { count: matches.length, index: index + 1 }
}
function findNext(direction = 1) {
  replaceNotice.value = ''
  findResult.value = store.sourceMode ? findInSource(direction) : richEditor.value?.findText(findQuery.value, direction) ?? { count: 0, index: 0 }
}
function replaceAll() {
  const query = findQuery.value.trim()
  if (!query) return
  const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  let count = 0
  bodyMarkdown.value = bodyMarkdown.value.replace(new RegExp(escapedQuery, 'gi'), () => {
    count += 1
    return findReplacement.value
  })
  if (!count) {
    replaceNotice.value = '无匹配项'
    return
  }
  onInput()
  findResult.value = { count: 0, index: 0 }
  replaceNotice.value = `已替换 ${count} 处`
}

function onShortcut(event: KeyboardEvent) {
  if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === 's') {
    event.preventDefault()
    void saveNow()
    return
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === 'f') {
    event.preventDefault()
    openFind()
    return
  }
  if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLocaleLowerCase() === 'f') {
    event.preventDefault()
    store.openSearch()
    return
  }
  if ((event.ctrlKey || event.metaKey) && event.key === '/') {
    event.preventDefault()
    toggleSourceMode()
    return
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === 'r' && !event.shiftKey && !event.altKey) {
    event.preventDefault()
    void refreshCurrentPage()
  }
}

function closeSourceMenu(event: MouseEvent) {
  const target = event.target
  if (!(target instanceof Element) || !target.closest('.document-source-badge')) sourceMenuOpen.value = false
}

function onWorkspaceCommand(event: Event) {
  if (event.type === 'tie:find-in-page') openFind()
  else if (event.type === 'tie:toggle-source-mode') toggleSourceMode()
  else if (event.type === 'tie:open-page-history') void openHistory()
  else if (event.type === 'tie:refresh-page') void refreshCurrentPage()
}

function saveWhenHidden() {
  if (document.visibilityState === 'hidden' && hasUnsavedChanges.value) void saveNow()
}

onMounted(() => {
  window.addEventListener('keydown', onShortcut)
  document.addEventListener('click', closeSourceMenu)
  document.addEventListener('visibilitychange', saveWhenHidden)
  window.addEventListener('tie:find-in-page', onWorkspaceCommand)
  window.addEventListener('tie:toggle-source-mode', onWorkspaceCommand)
  window.addEventListener('tie:open-page-history', onWorkspaceCommand)
  window.addEventListener('tie:refresh-page', onWorkspaceCommand)
})
onBeforeUnmount(() => {
  if (hasUnsavedChanges.value) void saveNow()
  window.removeEventListener('keydown', onShortcut)
  document.removeEventListener('click', closeSourceMenu)
  document.removeEventListener('visibilitychange', saveWhenHidden)
  window.removeEventListener('tie:find-in-page', onWorkspaceCommand)
  window.removeEventListener('tie:toggle-source-mode', onWorkspaceCommand)
  window.removeEventListener('tie:open-page-history', onWorkspaceCommand)
  window.removeEventListener('tie:refresh-page', onWorkspaceCommand)
  if (manualSaveTimer) window.clearTimeout(manualSaveTimer)
  if (copiedLinkTimer) window.clearTimeout(copiedLinkTimer)
  if (exportedTimer) window.clearTimeout(exportedTimer)
  if (refreshedTimer) window.clearTimeout(refreshedTimer)
  if (autoSaveTimer) window.clearTimeout(autoSaveTimer)
})

async function createChild() {
  if (store.activePage) await store.createChildPage(store.activePage.id)
}
async function createLinkedPage(title: string) { return store.createLinkedPage(title) }
</script>

<template>
  <main v-if="store.activePage" class="editor-pane">
    <header class="editor-header">
      <nav class="breadcrumbs" aria-label="页面层级"><span>{{ store.workspace?.name ?? '我的知识库' }}</span><template v-for="(page, index) in breadcrumbs" :key="page.id"><span>›</span><button :class="{ current: index === breadcrumbs.length - 1 }" :title="page.title" @click="store.openPage(page.id)">{{ page.title }}</button></template></nav>
      <div class="save-state"><div v-if="activeSource" class="document-source-badge" :class="activeSource.kind"><span>{{ sourceBadgeLabel(activeSource.kind) }} ·</span><button class="source-select-trigger" :aria-expanded="sourceMenuOpen" aria-haspopup="menu" :title="activeSource.path" :disabled="!canSwitchStorageSource" @click.stop="canSwitchStorageSource && (sourceMenuOpen = !sourceMenuOpen)">{{ activeSource.name }}</button><div v-if="sourceMenuOpen && activeSource && canSwitchStorageSource" class="source-select-menu" role="menu"><button v-for="source in transferTargets" :key="source.id" :class="{ unavailable: source.available === false }" role="menuitem" :disabled="source.available === false" @click="transferStorage(source.id)"><span><i :class="source.kind"></i>{{ sourceBadgeLabel(source.kind) }} · {{ source.name }}</span><small>{{ source.available === false ? '当前不可访问' : source.path }}</small></button></div></div><span class="save-dot" :class="{ saving: store.saving, error: Boolean(saveError) }"></span><span :title="saveError ?? undefined">{{ status }}</span><button v-if="hasRemoteConflict" class="save-retry-button" :disabled="conflictLoading" title="查看本地草稿与远程当前版本" @click="loadConflictPreview">{{ conflictLoading ? '读取中…' : '查看差异' }}</button><button v-else-if="saveError" class="save-retry-button" :disabled="store.saving" title="重新尝试保存当前页面" @click="saveNow">重试</button> <button class="history-button" :disabled="refreshing" title="从存储源刷新当前页面（Ctrl/Cmd + R）" @click="refreshCurrentPage">↻</button><button v-if="isDesktop && !isBackendRemoteSourceId(activeSource?.id ?? '')" class="history-button" title="在文件管理器中定位当前 Markdown 文件" @click="revealPageFile">⌖</button><button class="history-button" title="页面版本历史" @click="openHistory">◷</button><button class="copy-link-button" title="导出 Markdown" @click="exportMarkdown">⇩</button><button class="copy-link-button" title="复制 Markdown 页面链接" @click="copyPageLink">↗</button><button class="favorite-button" :class="{ active: isFavorite }" :title="isFavorite ? '取消收藏页面' : '收藏页面'" @click="store.toggleFavorite(store.activePage.id)">{{ isFavorite ? '★' : '☆' }}</button></div>
    </header>
    <aside v-if="showingHistory" class="history-popover">
      <div class="history-popover-heading"><strong>页面历史</strong><button aria-label="关闭页面历史" @click="showingHistory = false">×</button></div>
      <p v-if="historyLoading" class="muted">正在读取历史版本…</p>
      <p v-else-if="!revisions.length" class="muted">尚无历史版本。页面内容发生保存变化后会自动生成。</p>
      <div v-for="revision in revisions" v-else :key="revision.id" class="history-revision" :class="{ selected: selectedRevisionId === revision.id }"><button @click="previewRevision(revision)"><span><strong>{{ revision.title }}</strong><small>{{ revision.savedAt.slice(0, 19).replace('T', ' ') }}</small></span><em>预览</em></button><button class="history-restore" @click="restoreRevision(revision)">恢复</button></div>
      <section v-if="selectedRevision || revisionPreviewLoading || revisionPreviewError" class="revision-preview"><p v-if="revisionPreviewLoading" class="muted">正在读取版本内容…</p><p v-else-if="revisionPreviewError" class="revision-preview-error">{{ revisionPreviewError }}</p><template v-else-if="selectedRevision"><strong>{{ selectedRevision.title }}</strong><small>{{ selectedRevision.tags.length ? `# ${selectedRevision.tags.join('  # ')}` : '无标签' }}</small><pre>{{ selectedRevision.markdown }}</pre></template></section>
    </aside>
    <div v-if="conflictRemotePage" class="conflict-dialog-backdrop" @mousedown.self="conflictRemotePage = null">
      <section class="conflict-dialog" role="dialog" aria-modal="true" aria-label="页面同步冲突">
        <header><div><strong>{{ hasSyncConflict ? '同步检测到内容冲突' : '页面已在其他设备更新' }}</strong><small>{{ hasSyncConflict ? '远程与本地版本不一致，请选择保留哪一方。' : `先对照内容，再决定是否载入${remoteConflictLabel}版本。` }}</small></div><button aria-label="关闭" @click="conflictRemotePage = null">×</button></header>
        <div class="conflict-version-grid"><section><strong>本地未保存草稿</strong><small>{{ title || '无标题' }}</small><pre><code v-for="(line, index) in conflictDiff.local" :key="`local-${index}`" :class="line.kind">{{ line.text || ' ' }}</code></pre></section><section><strong>{{ remoteConflictLabel }}当前版本</strong><small>{{ conflictRemotePage.updatedAt.slice(0, 19).replace('T', ' ') }}</small><pre><code v-for="(line, index) in conflictDiff.remote" :key="`remote-${index}`" :class="line.kind">{{ line.text || ' ' }}</code></pre></section></div>
        <footer><button @click="copyConflictDraft">复制本地草稿</button><button @click="conflictRemotePage = null">保留草稿</button><button :disabled="store.saving" @click="forceOverwriteRemote">{{ store.saving ? '覆盖中…' : `覆盖${remoteConflictLabel}版本` }}</button><button class="conflict-load-button" @click="reloadRemotePage">载入{{ remoteConflictLabel }}版本</button></footer>
      </section>
    </div>
    <div class="editor-scroll" @click="onEditorSurfaceClick">
      <article ref="documentRoot" class="document" @click="onEditorSurfaceClick">
        <div v-if="showingFind" class="document-find" role="search">
          <input v-model="findQuery" autofocus placeholder="在当前页面查找" aria-label="在当前页面查找" @input="findNext(1)" @keydown.enter.prevent="findNext($event.shiftKey ? -1 : 1)" @keydown.escape.prevent="closeFind" />
          <span>{{ findQuery ? (findResult.count ? `${findResult.index}/${findResult.count}` : '无结果') : '' }}</span>
          <button title="上一个结果（Shift + Enter）" @click="findNext(-1)">↑</button>
          <button title="下一个结果（Enter）" @click="findNext(1)">↓</button>
          <input v-model="findReplacement" class="find-replacement" placeholder="替换为" aria-label="替换为" @keydown.escape.prevent="closeFind" />
          <button class="find-replace-button" :disabled="!findQuery.trim()" title="替换当前页面正文中的全部匹配项" @click="replaceAll">全部替换</button>
          <button title="关闭查找（Esc）" @click="closeFind">×</button>
          <small v-if="replaceNotice">{{ replaceNotice }}</small>
        </div>
        <div v-if="store.sourceMode" class="source-editor-panel">
          <DocumentMeta :title="title" :tags="tags" :tag-draft="tagDraft" :suggestions="tagSuggestions" :known-tags="store.tagIndex.map((tag) => tag.name)" @update:title="onTitleChange" @update:tag-draft="tagDraft = $event" @add-tags="addTags" @remove-tag="removeTag" @select-tag="selectTag" @suggest="generateTagSuggestions" @accept-suggestions="acceptTagSuggestions" />
          <textarea ref="sourceEditor" v-model="bodyMarkdown" class="source-editor" aria-label="Markdown 源码" :spellcheck="store.spellcheckEnabled" @input="onInput"></textarea>
        </div>
        <TiptapEditor v-else ref="richEditor" :model-value="bodyMarkdown" :pages="store.pages" :sources="store.allSources" :page-id="store.activePage.id" :spellcheck="store.spellcheckEnabled" :create-linked-page="createLinkedPage" @update:model-value="onBodyChange" @navigate="navigateToPage" @create-child="createChild">
          <template #meta><DocumentMeta :title="title" :tags="tags" :tag-draft="tagDraft" :suggestions="tagSuggestions" :known-tags="store.tagIndex.map((tag) => tag.name)" @update:title="onTitleChange" @update:tag-draft="tagDraft = $event" @add-tags="addTags" @remove-tag="removeTag" @select-tag="selectTag" @suggest="generateTagSuggestions" @accept-suggestions="acceptTagSuggestions" /></template>
        </TiptapEditor>
      </article>
    </div>
    <footer class="editor-statusbar">
      <button title="收起或展开左侧栏" @click="emit('toggle-sidebar')">▤ 侧栏</button>
      <button title="切换专注模式（Ctrl/Cmd + Shift + Enter）" @click="emit('toggle-focus')">⛶ 专注</button>
      <template v-if="!store.sourceMode"><button title="撤销（Ctrl/Cmd + Z）" @click="undo">↶ 撤销</button><button title="重做（Ctrl/Cmd + Shift + Z）" @click="redo">↷ 重做</button></template>
      <button :class="{ active: store.sourceMode }" title="切换 Markdown 源码模式（Ctrl/Cmd + /）" @click="toggleSourceMode">&lt;/&gt; 源码</button>
      <span class="status-divider"></span>
      <button :class="{ active: store.spellcheckEnabled }" :title="store.spellcheckEnabled ? '关闭拼写检查' : '开启拼写检查'" @click="store.toggleSpellcheck">✓ 拼写检查</button>
      <span class="word-count">字数 {{ wordCount }}</span>
      <button class="context-toggle-button" title="收起或展开右侧栏（Ctrl/Cmd + Shift + \\）" @click="emit('toggle-context')">◎ 关系</button>
    </footer>
  </main>
  <main v-else class="empty-editor">
    <button class="empty-editor-sidebar-toggle" type="button" @click="emit('toggle-sidebar')">▤ 打开侧栏</button>
    <h1>还没有页面</h1>
    <p>从左侧新建第一个页面，开始你的知识库。</p>
  </main>
</template>
