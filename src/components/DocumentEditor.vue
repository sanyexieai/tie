<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useWorkspaceStore } from '@/stores/workspace'
import { useBackendStore } from '@/stores/backend'
import type { Page, PageRevision, StorageSource } from '@/types'
import TiptapEditor from '@/components/TiptapEditor.vue'
import DocumentMeta from '@/components/DocumentMeta.vue'
import { aiTaggingReady, loadAiTaggingConfig, suggestTagsWithAi } from '@/services/ai-tagging'
import { backendService, isBackendRemoteSourceId } from '@/services/backend'
import { pageContentEqual, pageSourceIds, sourceShortLabel } from '@/services/page-sources'
import { isCloudStorageSourceId } from '@/services/storage-identity'
import { isS3SourceId } from '@/services/s3'
import { suggestTags, type TagSuggestion } from '@/services/tagging'
import { revealItemInDir } from '@tauri-apps/plugin-opener'
import { workspaceService } from '@/services/workspace'
import { isMobileClient, usesMobileUi } from '@/services/platform'
import type { DocumentSession } from '@/services/document-session'
import { LockKeyhole } from '@lucide/vue'
import PageProtectionControl from '@/components/PageProtectionControl.vue'

const props = defineProps<{ mobileLayout?: boolean; session?: DocumentSession }>()
const emit = defineEmits<{ 'toggle-sidebar': []; 'toggle-focus': []; 'toggle-context': []; 'mobile-back': []; 'dirty-change': [dirty: boolean] }>()
const store = useWorkspaceStore()
const activePage = computed(() => props.session?.page ?? store.activePage)
const locked = computed(() => Boolean(props.session?.locked))
const backend = useBackendStore()
const isDesktop = '__TAURI_INTERNALS__' in window
const title = ref('')
const bodyMarkdown = ref('')
const headingInFile = ref(false)
const tags = ref<string[]>([])
const tagDraft = ref('')
const copiedLinkNotice = ref(false)
const exportedNotice = ref(false)
const refreshedNotice = ref(false)
const refreshing = ref(false)
const protectionBusy = ref(false)
const protectionControl = ref<InstanceType<typeof PageProtectionControl> | null>(null)
const protectionPage = computed(() => store.activePage && !rawActiveSource.value?.temporary ? store.activePage : null)
const hasUnsavedChanges = ref(false)
const blockSourceDirty = ref(false)
const hasPendingChanges = computed(() => hasUnsavedChanges.value || blockSourceDirty.value)
const saveError = ref<string | null>(null)
const conflictRemotePage = ref<Page | null>(null)
const showingProtectionConflict = ref(false)
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
const richEditor = ref<{ undo: () => void; redo: () => void; findText: (query: string, direction?: number, focusResult?: boolean) => { count: number; index: number }; focusBlank?: (event: MouseEvent) => boolean; flushSource?: (options?: { close?: boolean }) => boolean; discardSource?: () => void } | null>(null)
let copiedLinkTimer: number | undefined
let exportedTimer: number | undefined
let refreshedTimer: number | undefined
let autoSaveTimer: number | undefined
let changeRevision = 0
let autoSaveFlushing = false
let autoSavePending = false
let autoSaveFlushDone: Promise<void> = Promise.resolve()
let resolveAutoSaveFlushDone: (() => void) | null = null
let loadedPage: Page | null = null
let disposed = false

const pageSync = computed(() => store.pageBackendSync(activePage.value?.id))
const syncedToBackend = computed(() => pageSync.value === 'synced')
const awaitingBackendSync = computed(() => pageSync.value === 'pending' || pageSync.value === 'conflict')
const status = computed(() => {
  if (locked.value) return '已锁定'
  if (props.session?.busy) return '保存中'
  if (props.session?.error) return '失败'
  if (store.saving) return '保存中'
  if (refreshing.value) return '刷新中'
  if (saveError.value) return '失败'
  if (hasPendingChanges.value) return '未保存'
  if (refreshedNotice.value) return '已刷新'
  if (exportedNotice.value) return '已导出'
  if (copiedLinkNotice.value) return '已复制'
  if (pageSync.value === 'conflict') return '冲突'
  if (awaitingBackendSync.value) return '未同步'
  if (syncedToBackend.value) return '已同步'
  return activeSource.value?.kind === 's3' ? '云端' : '本地'
})
const statusTitle = computed(() => {
  if (saveError.value || props.session?.error) return saveError.value || props.session!.error
  if (hasProtectionConflict.value) return '本地与服务器的页面保护状态不同，请先解锁并对齐保护状态'
  if (activePage.value && store.syncConflicts.has(activePage.value.id)) return '本地和后台都改过，较新的一份在正文里'
  switch (status.value) {
    case '已同步': return '已保存，并同步到后台'
    case '冲突': return '本地和后台都改过，较新的一份在正文里'
    case '本地': return '只保存在本地'
    case '云端': return '已保存到云端'
    case '未同步': return '已保存在本地，还没同步到后台'
    case '保存中': return '正在保存'
    case '未保存': return '有未保存的修改'
    case '失败': return '保存失败'
    default: return status.value
  }
})
const isFavorite = computed(() => Boolean(activePage.value && store.favoritePageIds.includes(activePage.value.id)))
const rawActiveSource = computed(() => store.allSources.find((source) => source.id === activePage.value?.storageSourceId) ?? null)
const boundSourceIds = computed(() => {
  if (!activePage.value) return []
  const known = new Set(store.allSources.map((source) => source.id))
  return pageSourceIds(activePage.value).filter((id) => known.has(id))
})
function cloudWorkspaceId(source: StorageSource) {
  if (source.id.startsWith('backend:')) return source.id.slice('backend:'.length)
  if (source.id.startsWith('backend-s3:')) {
    return backend.providers.find((provider) => `backend-s3:${provider.id}` === source.id)?.workspaceId ?? null
  }
  return null
}
function localPairForCloudSource(source: StorageSource) {
  const workspaceId = cloudWorkspaceId(source)
  if (!workspaceId) return null
  const localSources = store.allSources.filter((item) => item.kind === 'local' || item.kind === 'smb')
  return localSources.find((item) => backendService.workspaceMapping(item.id) === workspaceId)
    ?? localSources.find((item) => item.name === source.name)
    ?? null
}
const localCloudPairs = computed(() => {
  const pairs = new Map<string, StorageSource>()
  for (const source of store.allSources.filter((item) => isCloudStorageSourceId(item.id))) {
    const local = localPairForCloudSource(source)
    if (local) pairs.set(source.id, local)
  }
  return pairs
})
const pairedLocalSource = computed(() => {
  const localSources = store.allSources.filter((source) => source.kind === 'local' || source.kind === 'smb')
  const bound = localSources.find((source) => boundSourceIds.value.includes(source.id))
  if (bound) return bound
  const active = rawActiveSource.value
  if (!active) return null
  if (active.kind === 'local' || active.kind === 'smb') {
    return [...localCloudPairs.value.values()].some((item) => item.id === active.id) ? active : null
  }
  if (!isCloudStorageSourceId(active.id)) return null
  return localCloudPairs.value.get(active.id) ?? null
})
const activeSource = computed(() => pairedLocalSource.value ?? rawActiveSource.value)
const workspaceBadgeTitle = computed(() => {
  const source = activeSource.value
  if (!source) return ''
  const mode = source.temporary ? '临时工作区，修改保存到原文件' : backend.connected ? '本地 + 服务器，保存后云同步' : '本地工作区'
  return `${source.name}\n${source.path}\n${mode}`
})
const hasRemoteSaveConflict = computed(() => {
  const message = saveError.value || props.session?.error || ''
  return message.includes('其他设备更新') || message.includes('其他程序修改')
})
const hasSyncConflict = computed(() => Boolean(activePage.value && store.syncConflicts.has(activePage.value.id)))
const protectionConflict = computed(() => {
  const conflict = activePage.value ? store.syncConflicts.get(activePage.value.id) : undefined
  return conflict?.kind === 'protection' ? conflict : undefined
})
const hasProtectionConflict = computed(() => Boolean(protectionConflict.value))
const canEncryptLocalConflict = computed(() => protectionConflict.value?.localEncrypted === false && protectionConflict.value.remoteEncrypted === true)
const hasRemoteConflict = computed(() => hasRemoteSaveConflict.value || hasSyncConflict.value)
const hasContentConflict = computed(() => hasRemoteSaveConflict.value || (hasSyncConflict.value && !hasProtectionConflict.value))
const isLocalDiskSource = computed(() => {
  const kind = activeSource.value?.kind
  return kind === 'local' || kind === 'smb'
})
const remoteConflictLabel = computed(() => {
  if (activeSource.value?.kind === 'backend') return '后台'
  if (isS3SourceId(activeSource.value?.id ?? '')) return '远程'
  return '磁盘上的'
})

/** 云端冲突自动弹出对比；本地/SMB 只显示「查看差异」，避免误当成远端同步框。 */
function maybeAutoOpenConflictPreview() {
  if (!hasRemoteConflict.value) return
  if (isLocalDiskSource.value) return
  void loadConflictPreview()
}
const conflictLocalMarkdown = computed(() => composeStoredMarkdown(title.value.trim() || '无标题', bodyMarkdown.value))
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
const breadcrumbs = computed(() => {
  const current = activePage.value
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
const childPages = computed(() => {
  const parentId = activePage.value?.id
  if (!parentId) return []
  return store.pages
    .filter((page) => page.parentId === parentId && !page.deletedAt)
    .sort((a, b) => a.sortKey - b.sortKey || a.title.localeCompare(b.title, 'zh-CN'))
})
const wordCount = computed(() => bodyMarkdown.value
  .replace(/```[\s\S]*?```/g, '')
  .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
  .replace(/[#>*_~`|()[\]]/g, ' ')
  .replace(/\s/g, '')
  .length)

function composeStoredMarkdown(cleanTitle: string, body: string) {
  return headingInFile.value ? `# ${cleanTitle}\n\n${body}` : body
}

function loadActivePage() {
  const page = activePage.value
  loadedPage = page ? { ...page, tags: [...page.tags] } : null
  const markdown = page?.markdown ?? ''
  headingInFile.value = markdown.startsWith('# ')
  title.value = page?.title ?? ''
  bodyMarkdown.value = headingInFile.value ? markdown.replace(/^# .*(?:\r?\n){0,2}/, '') : markdown
  tags.value = page?.tags ?? []
  tagDraft.value = ''
  tagSuggestions.value = []
  hasUnsavedChanges.value = false
  blockSourceDirty.value = false
  saveError.value = null
}

watch(() => activePage.value?.id, loadActivePage, { immediate: true })
watch(hasPendingChanges, (dirty) => emit('dirty-change', dirty), { flush: 'sync' })
watch(locked, (value) => {
  if (!value) { loadActivePage(); return }
  cancelAutoSave()
  loadActivePage()
  closeFind()
  showingHistory.value = false
  selectedRevision.value = null
  conflictRemotePage.value = null
  showingProtectionConflict.value = false
})

watch(
  () => {
    const page = activePage.value
    return page ? `${page.id}\0${page.updatedAt}` : ''
  },
  async (signature, previous) => {
    if (!signature || !previous || signature === previous) return
    const page = activePage.value
    if (!page) return
    const cleanTitle = title.value.trim() || '无标题'
    const editorMarkdown = composeStoredMarkdown(cleanTitle, bodyMarkdown.value)
    const contentMatches = page.title === cleanTitle
      && page.markdown === editorMarkdown
      && page.tags.length === tags.value.length
      && page.tags.every((tag, index) => tag === tags.value[index])

    if (!hasPendingChanges.value) {
      // 仅在外部内容真正变化时重载，避免保存后的元数据回写把光标打飞。
      if (!contentMatches) loadActivePage()
      return
    }
    if (!contentMatches && (store.syncConflicts.has(page.id) || saveError.value?.includes('其他设备') || saveError.value?.includes('其他程序'))) {
      maybeAutoOpenConflictPreview()
    }
  },
)
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

function queueAutoSave() {
  if (hasContentConflict.value || blockSourceDirty.value) return
  if (autoSaveTimer) window.clearTimeout(autoSaveTimer)
  autoSaveTimer = window.setTimeout(() => {
    void flushAutoSave()
  }, 650)
}

async function flushAutoSave() {
  if (blockSourceDirty.value) return
  if (autoSaveFlushing) {
    autoSavePending = true
    return
  }
  autoSaveFlushing = true
  autoSaveFlushDone = new Promise<void>((resolve) => {
    resolveAutoSaveFlushDone = resolve
  })
  try {
    do {
      autoSavePending = false
      if (hasContentConflict.value || blockSourceDirty.value) break
      const revision = changeRevision
      // 紧挨写入前再取草稿，避免手动保存之后仍用旧快照回写。
      const page = draft()
      if (!page) break
      try {
        await persistDocument(page)
        if (!disposed && loadedPage?.id === page.id) {
          if (revision === changeRevision) hasUnsavedChanges.value = false
          saveError.value = null
        }
      } catch (reason) {
        saveError.value = saveFailureMessage(reason)
        if (hasRemoteConflict.value) maybeAutoOpenConflictPreview()
        break
      }
      if (changeRevision !== revision) autoSavePending = true
    } while (autoSavePending)
  } finally {
    autoSaveFlushing = false
    resolveAutoSaveFlushDone?.()
    resolveAutoSaveFlushDone = null
  }
}

function saveFailureMessage(reason: unknown) {
  return reason instanceof Error && reason.message
    ? reason.message
    : '无法写入页面，请检查存储源连接或目录权限。'
}

function conflictConfirm(message: string) {
  if (usesMobileUi.value) return true
  return window.confirm(message)
}

function cancelAutoSave() {
  changeRevision += 1
  autoSavePending = false
  if (autoSaveTimer) {
    window.clearTimeout(autoSaveTimer)
    autoSaveTimer = undefined
  }
}

async function loadConflictPreview() {
  if (conflictLoading.value || !activePage.value) return
  if (hasProtectionConflict.value) { showingProtectionConflict.value = true; return }
  if (!hasRemoteConflict.value && !saveError.value?.includes('其他设备') && !saveError.value?.includes('其他程序')) return
  conflictLoading.value = true
  try { conflictRemotePage.value = props.session ? await props.session.latest() : await store.readLatestPage(activePage.value.id) }
  catch (reason) { saveError.value = saveFailureMessage(reason) }
  finally { conflictLoading.value = false }
}

async function encryptLocalConflict() {
  showingProtectionConflict.value = false
  await protectionControl.value?.open()
}


function draft() {
  if (!loadedPage || locked.value) return null
  const cleanTitle = title.value.trim() || '无标题'
  return { ...loadedPage, icon: '', title: cleanTitle, markdown: composeStoredMarkdown(cleanTitle, bodyMarkdown.value), tags: [...tags.value] }
}

async function persistDocument(page: Page) {
  if (props.session) await props.session.save(page)
  else await store.persist(page)
  if (!disposed && loadedPage?.id === page.id) loadedPage = activePage.value ? { ...activePage.value } : null
}

function onInput() {
  const page = draft()
  if (!page) return
  const current = activePage.value
  // TipTap / 源码区可能在无实质改动时也冒泡 update；无差异则不进自动保存、不刷 updatedAt。
  if (current && pageContentEqual(page, current)) {
    if (hasUnsavedChanges.value) {
      hasUnsavedChanges.value = false
      autoSavePending = false
      if (autoSaveTimer) {
        window.clearTimeout(autoSaveTimer)
        autoSaveTimer = undefined
      }
    }
    saveError.value = null
    return
  }
  hasUnsavedChanges.value = true
  saveError.value = null
  changeRevision += 1
  queueAutoSave()
}

async function saveNow() {
  if (locked.value) return true
  if (!(richEditor.value?.flushSource?.({ close: false }) ?? true)) return false
  if (autoSaveTimer) window.clearTimeout(autoSaveTimer)
  if (!hasUnsavedChanges.value) return !saveError.value && !props.session?.error
  await flushAutoSave()
  if (autoSaveFlushing) await autoSaveFlushDone
  return !hasPendingChanges.value && !saveError.value && !props.session?.error
}

async function lockDocument() { if (props.session && await saveNow()) props.session.lock() }

async function reloadRemotePage() {
  const pageId = activePage.value?.id
  if (!pageId) return
  if (!conflictConfirm(`将重新载入${remoteConflictLabel.value}版本，当前未保存的本地修改会丢失。是否继续？`)) return
  richEditor.value?.discardSource?.()
  cancelAutoSave()
  const revision = changeRevision
  const isCurrent = () => !disposed && loadedPage?.id === pageId && revision === changeRevision
  try {
    props.session ? await props.session.refresh(isCurrent, true) : await store.resolveConflictLoadRemote(pageId)
    if (!isCurrent()) return
    loadActivePage()
    saveError.value = null
    conflictRemotePage.value = null
  } catch (reason) {
    saveError.value = saveFailureMessage(reason)
  }
}

async function forceOverwriteRemote() {
  if (!(richEditor.value?.flushSource?.({ close: false }) ?? true)) return
  const page = draft()
  if (!page) return
  if (!conflictConfirm(`将用本地草稿覆盖${remoteConflictLabel.value}版本，其他设备上的修改会丢失。是否继续？`)) return
  cancelAutoSave()
  try {
    props.session ? await props.session.save(page, true) : await store.resolveConflictOverwriteLocal(page)
    hasUnsavedChanges.value = false
    saveError.value = null
    conflictRemotePage.value = null
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

async function copyPageLink() {
  const page = activePage.value
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
  const page = activePage.value
  const source = activeSource.value
  if (!page || !source || !isDesktop) return
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    const path = await invoke<string>('page_file_path', {
      pageId: page.id,
      storageSourceId: source.id,
    })
    await revealItemInDir(path)
  } catch (error) {
    window.alert(error instanceof Error ? error.message : '无法定位页面文件')
  }
}

function tieExportFilename(title: string) {
  const safe = title.trim().replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').replace(/^[\s.]+|[\s.]+$/g, '').slice(0, 80) || '无标题'
  return `${safe}.tie`
}

function tieExportText(title: string, pageId: string, sourceId: string) {
  const name = (title.trim() || '无标题').replace(/[\r\n]/g, ' ')
  return `# Tie solution — open with Tie / \`tie open\`
tie_version: 1
kind: solution
name: ${name}
root: .
source_id: ${sourceId}
root_page: ${pageId}
`
}

async function exportTie() {
  const page = activePage.value
  if (!page) return
  const filename = tieExportFilename(page.title || '无标题')
  try {
    if (isDesktop) {
      const { invoke } = await import('@tauri-apps/api/core')
      const { save } = await import('@tauri-apps/plugin-dialog')
      const out = await save({
        title: '导出 .tie',
        defaultPath: filename,
        filters: [{ name: 'Tie', extensions: ['tie'] }],
      })
      if (!out) return
      await invoke('export_tie_file', {
        pageId: page.id,
        storageSourceId: page.storageSourceId,
        title: page.title || '无标题',
        outPath: out,
      })
    } else {
      const blob = new Blob([tieExportText(page.title || '无标题', page.id, page.storageSourceId)], { type: 'text/plain' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = filename
      document.body.append(anchor)
      anchor.click()
      anchor.remove()
      URL.revokeObjectURL(url)
    }
  } catch (error) {
    window.alert(error instanceof Error ? error.message : '无法导出 .tie')
    return
  }
  exportedNotice.value = true
  if (exportedTimer) window.clearTimeout(exportedTimer)
  exportedTimer = window.setTimeout(() => { exportedNotice.value = false }, 2400)
}

async function exportPageClosure() {
  if (!await saveNow()) return
  const page = activePage.value
  if (!page || !isDesktop) return
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    const { save } = await import('@tauri-apps/plugin-dialog')
    const out = await save({
      title: '导出页面及引用',
      defaultPath: `tie-export-${page.id}`,
    })
    if (!out) return
    await invoke('export_page_closure', {
      pageIdOrTitle: page.id,
      sourceId: page.storageSourceId,
      outDir: out,
      depth: 2,
      withChildren: true,
    })
    exportedNotice.value = true
    if (exportedTimer) window.clearTimeout(exportedTimer)
    exportedTimer = window.setTimeout(() => { exportedNotice.value = false }, 2400)
  } catch (reason) {
    saveError.value = reason instanceof Error ? reason.message : String(reason)
  }
}

async function refreshCurrentPage() {
  if (locked.value || !activePage.value || refreshing.value) return
  if (hasPendingChanges.value && !window.confirm('当前有未保存修改，从存储刷新将丢弃这些修改。是否继续？')) return
  richEditor.value?.discardSource?.()
  if (autoSaveTimer) {
    window.clearTimeout(autoSaveTimer)
    autoSaveTimer = undefined
  }
  refreshing.value = true
  saveError.value = null
  const pageId = activePage.value.id
  const revision = changeRevision
  const isCurrent = () => !disposed && loadedPage?.id === pageId && revision === changeRevision
  try {
    props.session ? await props.session.refresh(isCurrent) : await store.refreshPage(pageId)
    if (!isCurrent()) return
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
  if (locked.value || !activePage.value) return
  showingHistory.value = true
  selectedRevision.value = null
  selectedRevisionId.value = null
  revisionPreviewError.value = null
  historyLoading.value = true
  try { revisions.value = await store.listPageRevisions(activePage.value.id) } finally { historyLoading.value = false }
}

async function previewRevision(revision: PageRevision) {
  if (!activePage.value) return
  selectedRevisionId.value = revision.id
  selectedRevision.value = null
  revisionPreviewError.value = null
  revisionPreviewLoading.value = true
  try {
    selectedRevision.value = props.session ? await props.session.readRevision(revision.id) : await store.readPageRevision(activePage.value.id, revision.id)
  } catch {
    revisionPreviewError.value = '无法读取该历史版本，可能已被外部同步工具移除。'
  } finally { revisionPreviewLoading.value = false }
}

async function restoreRevision(revision: PageRevision) {
  if (!activePage.value || !window.confirm(`恢复“${revision.title}”的历史版本？当前内容会先自动保留为新版本。`)) return
  if (hasPendingChanges.value && !await saveNow()) return
  const restored = props.session ? (await props.session.restoreRevision(revision.id), true) : await store.restorePageRevision(activePage.value.id, revision.id)
  if (!restored) return
  loadActivePage()
  showingHistory.value = false
  selectedRevisionId.value = null
}

function onBodyChange(markdown: string) {
  bodyMarkdown.value = markdown
  onInput()
}

function onBlockSourceDirty(dirty: boolean) {
  blockSourceDirty.value = dirty
  if (dirty) cancelAutoSave()
  else if (hasUnsavedChanges.value) queueAutoSave()
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
    const aiSuggestions = !props.session && aiTaggingReady(aiConfig)
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

function toggleSourceMode() {
  if (!(richEditor.value?.flushSource?.({ close: true }) ?? true)) return
  store.toggleSourceMode()
}
function toggleLiveMarkdown() {
  if (!(richEditor.value?.flushSource?.({ close: true }) ?? true)) return
  store.toggleLiveMarkdown()
}
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
  if (!(richEditor.value?.flushSource?.({ close: true }) ?? true)) return
  showingFind.value = true
  void nextTick(() => documentRoot.value?.querySelector<HTMLInputElement>('.document-find input')?.focus())
}
function closeFind() {
  showingFind.value = false
  findQuery.value = ''
  findReplacement.value = ''
  findResult.value = { count: 0, index: 0 }
  replaceNotice.value = ''
}
function findInSource(direction: number, focusResult = true) {
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
  if (focusResult) input.focus()
  input.setSelectionRange(matches[index], matches[index] + query.length)
  return { count: matches.length, index: index + 1 }
}
function findNext(direction = 1, focusResult = true) {
  replaceNotice.value = ''
  findResult.value = store.sourceMode ? findInSource(direction, focusResult) : richEditor.value?.findText(findQuery.value, direction, focusResult) ?? { count: 0, index: 0 }
}
function replaceAll() {
  if (!(richEditor.value?.flushSource?.({ close: true }) ?? true)) return
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
  if (locked.value || protectionBusy.value) return
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

function onWorkspaceCommand(event: Event) {
  if (event.type === 'tie:convert-page-protection') {
    const detail = (event as CustomEvent<{ pageId: string; sourceId: string }>).detail
    const target = protectionPage.value
    if (target && detail?.pageId === target.id && detail.sourceId === target.storageSourceId) void protectionControl.value?.open()
    return
  }
  if (locked.value || protectionBusy.value) return
  if (event.type === 'tie:find-in-page') openFind()
  else if (event.type === 'tie:toggle-source-mode') toggleSourceMode()
  else if (event.type === 'tie:open-page-history') void openHistory()
  else if (event.type === 'tie:refresh-page') void refreshCurrentPage()
}

function onMobileBack(event: Event) {
  const detail = (event as CustomEvent<{ handled?: boolean }>).detail
  if (!detail || detail.handled) return
  if (conflictRemotePage.value) {
    conflictRemotePage.value = null
    detail.handled = true
    return
  }
  if (showingHistory.value) {
    showingHistory.value = false
    detail.handled = true
    return
  }
  if (showingFind.value) {
    showingFind.value = false
    detail.handled = true
  }
}

function saveWhenHidden() {
  if (document.visibilityState === 'hidden' && hasPendingChanges.value) void saveNow()
}

let unregisterEditorSave: (() => void) | undefined
onMounted(() => {
  unregisterEditorSave = store.registerEditorSaveHandler(saveNow, () => hasPendingChanges.value)
  window.addEventListener('keydown', onShortcut)
  document.addEventListener('visibilitychange', saveWhenHidden)
  window.addEventListener('tie:find-in-page', onWorkspaceCommand)
  window.addEventListener('tie:toggle-source-mode', onWorkspaceCommand)
  window.addEventListener('tie:open-page-history', onWorkspaceCommand)
  window.addEventListener('tie:refresh-page', onWorkspaceCommand)
  window.addEventListener('tie:convert-page-protection', onWorkspaceCommand)
  window.addEventListener('tie:mobile-back', onMobileBack)
})
onBeforeUnmount(() => {
  unregisterEditorSave?.()
  if (hasPendingChanges.value) void saveNow().finally(() => { bodyMarkdown.value = ''; selectedRevision.value = null; conflictRemotePage.value = null })
  disposed = true
  window.removeEventListener('keydown', onShortcut)
  document.removeEventListener('visibilitychange', saveWhenHidden)
  window.removeEventListener('tie:find-in-page', onWorkspaceCommand)
  window.removeEventListener('tie:toggle-source-mode', onWorkspaceCommand)
  window.removeEventListener('tie:open-page-history', onWorkspaceCommand)
  window.removeEventListener('tie:refresh-page', onWorkspaceCommand)
  window.removeEventListener('tie:convert-page-protection', onWorkspaceCommand)
  window.removeEventListener('tie:mobile-back', onMobileBack)
  if (copiedLinkTimer) window.clearTimeout(copiedLinkTimer)
  if (exportedTimer) window.clearTimeout(exportedTimer)
  if (refreshedTimer) window.clearTimeout(refreshedTimer)
  if (autoSaveTimer) window.clearTimeout(autoSaveTimer)
})

async function expandToChild(title: string) {
  const parent = activePage.value
  if (!parent) throw new Error('没有打开的页面')
  const cleanTitle = title.trim().replace(/\s+/g, ' ').slice(0, 120)
  if (!cleanTitle) throw new Error('请先选中要展开的文字')
  if (props.session) return props.session.createPage(cleanTitle, parent.id)
  const created = await workspaceService.createPage(parent.id, parent.storageSourceId)
  const saved = await workspaceService.savePage({
    ...created,
    title: cleanTitle,
    markdown: `# ${cleanTitle}\n\n`,
    updatedAt: new Date().toISOString(),
  })
  const index = store.pages.findIndex((page) => page.id === saved.id)
  if (index === -1) store.pages.push(saved)
  else store.pages[index] = saved
  store.expandPage(parent.id)
  store.showingTrash = false
  return saved
}
async function createChild() {
  if (!activePage.value) return
  if (props.session) { const child = await props.session.createPage('无标题', activePage.value.id); store.openPage(child.id) }
  else await store.createChildPage(activePage.value.id)
}
async function createLinkedPage(title: string) { return props.session ? props.session.createPage(title, null) : store.createLinkedPage(title) }
defineExpose({ saveNow })
</script>

<template>
  <main v-if="activePage" class="editor-pane" :class="{ 'mobile-editor-pane': props.mobileLayout }">
    <header class="editor-header">
      <button
        v-if="props.mobileLayout || isMobileClient"
        type="button"
        class="mobile-editor-back"
        aria-label="返回列表"
        @click="emit('mobile-back')"
      >←</button>
      <nav v-if="!props.mobileLayout" class="breadcrumbs" aria-label="页面层级"><span>{{ store.workspace?.name ?? '我的知识库' }}</span><template v-for="(page, index) in breadcrumbs" :key="page.id"><span>›</span><button :class="{ current: index === breadcrumbs.length - 1 }" :title="page.title" @click="store.openPage(page.id)">{{ page.title }}</button></template></nav>
      <h1 v-else class="mobile-editor-title">{{ activePage.title }}</h1>
      <div class="save-state" :inert="locked || protectionBusy"><button v-if="session && !locked" type="button" class="history-button" aria-label="锁定页面" title="锁定页面" @click="lockDocument"><LockKeyhole :size="14" /></button><div v-if="activeSource" class="document-source-badge" :class="activeSource.kind"><span class="source-select-trigger is-label" :title="workspaceBadgeTitle">{{ sourceShortLabel(activeSource.name) }}</span></div><span class="save-dot" :class="{ saving: store.saving, pending: status === '未同步', synced: status === '已同步', conflict: status === '冲突', local: status === '本地' || status === '云端', error: Boolean(saveError) }" :title="statusTitle"></span><span v-if="status !== '已同步' && status !== '未同步' && status !== '冲突'" :title="statusTitle">{{ status }}</span><button v-if="hasRemoteConflict" class="save-retry-button" :disabled="conflictLoading"  :title="hasProtectionConflict ? '处理页面保护状态' : '查看本地草稿与远程当前版本'" @click="loadConflictPreview">{{ conflictLoading ? '读取中…' : hasProtectionConflict ? '处理保护状态' : '查看差异' }}</button><button v-else-if="saveError" class="save-retry-button" :disabled="store.saving" :title="saveError || '重新尝试保存当前页面'" @click="saveNow">重试</button> <button class="history-button" :disabled="refreshing" title="从工作区刷新当前页面（Ctrl/Cmd + R）" @click="refreshCurrentPage">↻</button><button v-if="isDesktop && !isBackendRemoteSourceId(activeSource?.id ?? '')" class="history-button" title="在文件管理器中定位当前 Markdown 文件" @click="revealPageFile">⌖</button><button class="history-button" title="页面版本历史" @click="openHistory">◷</button><button v-if="!isDesktop" class="copy-link-button" title="导入 .tiez" @click="store.importTiezBrowser()">导入</button><button v-if="!isDesktop" class="copy-link-button" title="导出当前工作区为 .tiez" @click="store.exportTiezBrowser()">.tiez</button><button class="copy-link-button" title="导出 .tie，以当前页面为根" @click="exportTie">⇩</button><button v-if="isDesktop" class="copy-link-button" title="导出此页及引用（闭包）" @click="exportPageClosure">⇪</button><button class="copy-link-button" title="复制 Markdown 页面链接" @click="copyPageLink">↗</button><button class="favorite-button" :class="{ active: isFavorite }" :title="isFavorite ? '取消收藏页面' : '收藏页面'" @click="store.toggleFavorite(activePage.id)">{{ isFavorite ? '★' : '☆' }}</button></div>
      <PageProtectionControl v-if="protectionPage" ref="protectionControl" :page="protectionPage" :prepare="saveNow" :locked="locked" @busy="protectionBusy = $event" />
    </header>
    <aside v-if="showingHistory" class="history-popover">
      <div class="history-popover-heading"><strong>页面历史</strong><button aria-label="关闭页面历史" @click="showingHistory = false">×</button></div>
      <p v-if="historyLoading" class="muted">正在读取历史版本…</p>
      <p v-else-if="!revisions.length" class="muted">尚无历史版本。页面内容发生保存变化后会自动生成。</p>
      <div v-for="revision in revisions" v-else :key="revision.id" class="history-revision" :class="{ selected: selectedRevisionId === revision.id }"><button @click="previewRevision(revision)"><span><strong>{{ revision.title }}</strong><small>{{ revision.savedAt.slice(0, 19).replace('T', ' ') }}</small></span><em>预览</em></button><button class="history-restore" @click="restoreRevision(revision)">恢复</button></div>
      <section v-if="selectedRevision || revisionPreviewLoading || revisionPreviewError" class="revision-preview"><p v-if="revisionPreviewLoading" class="muted">正在读取版本内容…</p><p v-else-if="revisionPreviewError" class="revision-preview-error">{{ revisionPreviewError }}</p><template v-else-if="selectedRevision"><strong>{{ selectedRevision.title }}</strong><small>{{ selectedRevision.tags.length ? `# ${selectedRevision.tags.join('  # ')}` : '无标签' }}</small><pre>{{ selectedRevision.markdown }}</pre></template></section>
    </aside>
    <div v-if="showingProtectionConflict && protectionConflict" class="conflict-dialog-backdrop" @mousedown.self="showingProtectionConflict = false">
      <section class="conflict-dialog" role="dialog" aria-modal="true" aria-label="页面保护状态不同">
        <header><div><strong>页面保护状态不同</strong><small>两边的正文、历史、讨论和附件均已保留，需要先对齐保护状态再同步。</small></div><button aria-label="关闭" @click="showingProtectionConflict = false">×</button></header>
        <p>本机：{{ protectionConflict.localEncrypted ? '加密页面' : '普通页面' }} · 服务器：{{ protectionConflict.remoteEncrypted ? '加密页面' : '普通页面' }}</p>
        <p v-if="canEncryptLocalConflict">输入服务器页面已有的密码，将本机页面一起加密；不会直接覆盖任一方的正文。</p>
        <p v-else>请先解锁加密页面，再从页面的「⋯」菜单选择转换方式，对齐本机与服务器的保护状态。</p>
        <footer><button @click="showingProtectionConflict = false">稍后处理</button><button v-if="canEncryptLocalConflict" class="conflict-load-button" @click="encryptLocalConflict">解锁并加密本机</button></footer>
      </section>
    </div>
    <div v-if="conflictRemotePage" class="conflict-dialog-backdrop" @mousedown.self="conflictRemotePage = null">
      <section class="conflict-dialog" role="dialog" aria-modal="true" aria-label="页面同步冲突">
        <header><div><strong>{{ hasSyncConflict ? '检测到内容冲突' : (activeSource?.kind === 'local' || activeSource?.kind === 'smb' ? '页面文件已在磁盘上被修改' : '页面已在其他设备更新') }}</strong><small>{{ hasSyncConflict ? '两边内容不一致，请选择保留哪一方。' : `先对照内容，再决定是否载入${remoteConflictLabel}版本。` }}</small></div><button aria-label="关闭" @click="conflictRemotePage = null">×</button></header>
        <div class="conflict-version-grid"><section><strong>本地未保存草稿</strong><small>{{ title || '无标题' }}</small><pre><code v-for="(line, index) in conflictDiff.local" :key="`local-${index}`" :class="line.kind">{{ line.text || ' ' }}</code></pre></section><section><strong>{{ remoteConflictLabel }}当前版本</strong><small>{{ conflictRemotePage.updatedAt.slice(0, 19).replace('T', ' ') }}</small><pre><code v-for="(line, index) in conflictDiff.remote" :key="`remote-${index}`" :class="line.kind">{{ line.text || ' ' }}</code></pre></section></div>
        <footer><button @click="copyConflictDraft">复制本地草稿</button><button @click="conflictRemotePage = null">保留草稿</button><button :disabled="store.saving" @click="forceOverwriteRemote">{{ store.saving ? '覆盖中…' : `覆盖${remoteConflictLabel}版本` }}</button><button class="conflict-load-button" @click="reloadRemotePage">载入{{ remoteConflictLabel }}版本</button></footer>
      </section>
    </div>
    <div class="editor-scroll" :inert="protectionBusy" @click="onEditorSurfaceClick">
      <article ref="documentRoot" class="document" @click="onEditorSurfaceClick">
        <slot v-if="locked" name="unlock"></slot>
        <template v-else>
        <div v-if="showingFind" class="document-find" role="search">
          <input v-model="findQuery" autofocus placeholder="在当前页面查找" aria-label="在当前页面查找" @input="findNext(1, false)" @keydown.enter.prevent="findNext($event.shiftKey ? -1 : 1)" @keydown.escape.prevent="closeFind" />
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
        <TiptapEditor v-else ref="richEditor" :model-value="bodyMarkdown" :pages="store.pages" :sources="store.allSources" :page-id="activePage.id" :spellcheck="store.spellcheckEnabled" :background-started="store.backgroundStarted" :create-linked-page="createLinkedPage" :expand-to-child="expandToChild" enable-pheromone enable-block-source :live-markdown="store.liveMarkdownEnabled" :private-document="Boolean(session)" :protected-page-actions="Boolean(session)" @update:model-value="onBodyChange" @source-dirty="onBlockSourceDirty" @navigate="navigateToPage" @create-child="createChild">
          <template #meta><DocumentMeta :title="title" :tags="tags" :tag-draft="tagDraft" :suggestions="tagSuggestions" :known-tags="store.tagIndex.map((tag) => tag.name)" @update:title="onTitleChange" @update:tag-draft="tagDraft = $event" @add-tags="addTags" @remove-tag="removeTag" @select-tag="selectTag" @suggest="generateTagSuggestions" @accept-suggestions="acceptTagSuggestions" /></template>
        </TiptapEditor>
        <section v-if="childPages.length" class="document-child-pages" aria-label="子页面">
          <h2 class="document-child-pages-title">子页面</h2>
          <div class="document-child-pages-list">
            <button
              v-for="page in childPages"
              :key="page.id"
              type="button"
              class="document-child-page-card"
              @click.stop="store.openPage(page.id)"
            >{{ page.title || '无标题' }}</button>
          </div>
        </section>
        </template>
      </article>
    </div>
    <footer class="editor-statusbar">
      <button v-if="!props.mobileLayout && !isMobileClient" title="收起或展开左侧栏" @click="emit('toggle-sidebar')">▤ 侧栏</button>
      <button class="statusbar-mobile-hide" title="切换专注模式（Ctrl/Cmd + Shift + Enter）" @click="emit('toggle-focus')">⛶ 专注</button>
      <template v-if="!store.sourceMode"><button :disabled="locked" class="statusbar-mobile-hide" title="撤销（Ctrl/Cmd + Z）" @click="undo">↶ 撤销</button><button :disabled="locked" class="statusbar-mobile-hide" title="重做（Ctrl/Cmd + Shift + Z）" @click="redo">↷ 重做</button></template>
      <button :disabled="locked" :class="{ active: store.sourceMode }" title="切换 Markdown 源码模式（Ctrl/Cmd + /）" @click="toggleSourceMode">&lt;/&gt; 源码</button>
      <button v-if="!store.sourceMode" :disabled="locked" :class="{ active: store.liveMarkdownEnabled }" :aria-pressed="store.liveMarkdownEnabled" title="光标进入普通段落或标题时显示 Markdown；复杂块可右键编辑源码" @click="toggleLiveMarkdown">即时源码</button>
      <span class="status-divider"></span>
      <button :class="{ active: store.spellcheckEnabled }" :title="store.spellcheckEnabled ? '关闭拼写检查' : '开启拼写检查'" @click="store.toggleSpellcheck">✓ 拼写检查</button>
      <span class="word-count">字数 {{ wordCount }}</span>
      <button class="context-toggle-button" title="收起或展开右侧栏（Ctrl/Cmd + Shift + \\）" @click="emit('toggle-context')">◎ 关系</button>
    </footer>
  </main>
  <main v-else class="empty-editor">
    <button class="empty-editor-sidebar-toggle" type="button" @click="emit('toggle-sidebar')">▤ 打开侧栏</button>
    <h1>还没有页面</h1>
    <p>{{ isDesktop ? '从左侧新建页面，或打开 .tie / .tiez / Markdown。' : '从左侧新建页面，或导入 .tiez 压缩包到浏览器工作区。' }}</p>
    <div class="empty-editor-actions">
      <button type="button" @click="store.createPage(null)">＋ 新建页面</button>
      <button v-if="isDesktop" type="button" @click="store.openFromFiles()">📂 从文件打开</button>
      <button v-if="!isDesktop" type="button" @click="store.importTiezBrowser()">导入 .tiez</button>
      <button v-if="!isDesktop && store.pages.length" type="button" @click="store.exportTiezBrowser()">导出 .tiez</button>
    </div>
  </main>
</template>
