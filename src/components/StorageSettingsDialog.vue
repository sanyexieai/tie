<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { openPath } from '@tauri-apps/plugin-opener'
import { getVersion } from '@tauri-apps/api/app'
import TieSelect from '@/components/TieSelect.vue'
import type { StorageKind, StorageSource } from '@/types'
import { DEFAULT_PAGE_ICON } from '@/constants/page'
import { useWorkspaceStore } from '@/stores/workspace'
import { useBackendStore } from '@/stores/backend'
import {
  AI_CLI_CLIENT_OPTIONS,
  fetchAiCliStatus,
  loadAiTaggingConfig,
  pickAiCliBinary,
  saveAiTaggingConfig,
  type AiCliClientId,
  type AiCliStatus,
  type AiTaggingConfig,
  type AiTaggingMode,
} from '@/services/ai-tagging'
import {
  AGENT_CLIENT_OPTIONS,
  configureAgentMcp,
  fetchAgentMcpStatus,
  loadCodexMcpPreference,
  saveCodexMcpPreference,
  type AgentClientId,
  type AgentMcpStatus,
} from '@/services/codex-mcp'
import { pageBoundToSource } from '@/services/page-sources'
import { isBackendSourceId, isBackendManagedS3SourceId, defaultBackendEndpoint } from '@/services/backend'
import { isS3SourceId, providerForS3Source } from '@/services/s3'
import { storageRegistry } from '@/services/storage/registry'
import type { S3ConnectionInput } from '@/services/storage/types'
import { loadThemeMode, resolveTheme, setThemeMode, type ThemeMode } from '@/services/theme'
import {
  appUpdateState,
  appUpdaterUnavailableReason,
  canUseAppUpdater,
  checkForAppUpdate,
  downloadAndInstallAppUpdate,
} from '@/services/app-updater'
import { isTauriDesktop, isMobileClient, supportsLocalFileStorage, tieRuntimeKind, tieRuntimeLabel } from '@/services/platform'

const emit = defineEmits<{ close: []; 'connect-backend': [] }>()
const store = useWorkspaceStore()
const backend = useBackendStore()
const themeMode = ref<ThemeMode>(loadThemeMode())
const themeOptions: { value: ThemeMode; label: string }[] = [
  { value: 'system', label: '跟随系统' },
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
]
const themeSummary = computed(() => {
  const option = themeOptions.find((item) => item.value === themeMode.value)
  if (themeMode.value === 'system') {
    return `跟随系统 · 当前${resolveTheme('system') === 'dark' ? '深色' : '浅色'}`
  }
  return option?.label ?? '跟随系统'
})

function onThemeModeChange(mode: ThemeMode) {
  themeMode.value = mode
  setThemeMode(mode)
}
const storageMenuOpen = ref(false)
const choosingWorkspace = ref(false)
const importingMarkdown = ref(false)
const openingFromFiles = ref(false)
const syncingRemote = ref(false)
const isDesktop = isTauriDesktop()
const storageListEl = ref<HTMLElement | null>(null)
const draggingSourceId = ref<string | null>(null)
const dropTargetId = ref<string | null>(null)
const dropPosition = ref<'before' | 'after' | null>(null)
let activeSourcePointerId: number | null = null
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
const aiCliStatus = ref<AiCliStatus | null>(null)
const aiCliScanning = ref(false)
const aiCliClientOptions = AI_CLI_CLIENT_OPTIONS
const codexFormOpen = ref(false)
const agentMcpStatus = ref<AgentMcpStatus | null>(null)
const initialPref = loadCodexMcpPreference()
const codexSourceId = ref<string | null>(initialPref.sourceId)
const selectedClients = ref<AgentClientId[]>(initialPref.clients ?? ['codex', 'cursor', 'claude'])
const codexBusy = ref(false)
const codexError = ref('')
const codexNotice = ref('')
const agentClientOptions = AGENT_CLIENT_OPTIONS
const appVersion = ref('—')
const checkingAppUpdate = ref(false)

const appUpdateSummary = computed(() => {
  const unavailableReason = appUpdaterUnavailableReason()
  if (unavailableReason) return unavailableReason
  if (appUpdateState.phase === 'available') {
    return `发现新版本 ${appUpdateState.availableVersion}`
  }
  if (appUpdateState.phase === 'uptodate') return '已是最新版本'
  if (appUpdateState.phase === 'downloading' || appUpdateState.phase === 'installing') {
    return appUpdateState.progress == null
      ? '正在下载更新…'
      : `正在下载更新… ${appUpdateState.progress}%`
  }
  if (appUpdateState.phase === 'error') return appUpdateState.error ?? '检查更新失败'
  return `当前版本 ${appVersion.value} · ${tieRuntimeLabel()}`
})

const aiModeOptions: { value: AiTaggingMode; label: string }[] = [
  { value: 'cli', label: '本地 CLI（Claude / Codex / Cursor）' },
  { value: 'tie', label: 'Tie 后台（/api/v1/ai/suggest-tags）' },
  { value: 'openai', label: 'OpenAI 兼容 API' },
]

const aiModeLabel = computed(() => aiModeOptions.find((item) => item.value === aiConfig.value.mode)?.label ?? aiModeOptions[0].label)
const selectedAiCliLabel = computed(() => (
  AI_CLI_CLIENT_OPTIONS.find((item) => item.id === aiConfig.value.cliClient)?.label ?? 'Claude Code'
))
const aiStatusSummary = computed(() => {
  if (!aiConfig.value.enabled) return '未启用 · 点击配置'
  if (aiConfig.value.mode === 'cli') return `已启用 · ${selectedAiCliLabel.value}`
  if (aiConfig.value.mode === 'openai') return '已启用 · OpenAI 兼容'
  return '已启用 · Tie 后台'
})

function aiCliClientStatus(id: AiCliClientId) {
  return aiCliStatus.value?.clients.find((item) => item.id === id) ?? null
}

function aiCliConnected(id: AiCliClientId) {
  return aiCliClientStatus(id)?.connected ?? false
}

function aiCliBadge(id: AiCliClientId) {
  if (aiCliScanning.value) return '检测中…'
  const status = aiCliClientStatus(id)
  if (!aiCliStatus.value || !status) return '待检测'
  const prefix = status.custom ? '自定义 · ' : ''
  if (status.connected) return `${prefix}${status.version ? `已连通 · ${status.version}` : '已连通'}`
  if (status.available) return `${prefix}已找到 · 未连通`
  return status.custom ? '自定义路径无效' : `未找到 ${AI_CLI_CLIENT_OPTIONS.find((item) => item.id === id)?.bin ?? id}`
}

const selectedAiCliPath = computed({
  get: () => aiConfig.value.cliPaths[aiConfig.value.cliClient] ?? '',
  set: (value: string) => {
    aiConfig.value.cliPaths = {
      ...aiConfig.value.cliPaths,
      [aiConfig.value.cliClient]: value,
    }
  },
})

async function refreshAiCliStatus() {
  if (!isDesktop) {
    aiCliStatus.value = null
    return
  }
  aiCliScanning.value = true
  try {
    aiCliStatus.value = await fetchAiCliStatus(aiConfig.value.cliPaths)
    const currentCustom = Boolean(aiConfig.value.cliPaths[aiConfig.value.cliClient]?.trim())
    if (!currentCustom && !aiCliConnected(aiConfig.value.cliClient)) {
      const preferred = aiCliStatus.value?.clients.find((item) => item.connected)
        ?? aiCliStatus.value?.clients.find((item) => item.available)
      if (preferred && (preferred.id === 'claude' || preferred.id === 'codex' || preferred.id === 'cursor')) {
        aiConfig.value.cliClient = preferred.id
      }
    }
  } catch {
    aiCliStatus.value = null
  } finally {
    aiCliScanning.value = false
  }
}

async function browseAiCliPath() {
  const selected = await pickAiCliBinary(`选择 ${selectedAiCliLabel.value} 可执行文件`)
  if (!selected) return
  selectedAiCliPath.value = selected
  await refreshAiCliStatus()
}

function clearAiCliPath() {
  selectedAiCliPath.value = ''
  void refreshAiCliStatus()
}

function onAiCliPathChange() {
  void refreshAiCliStatus()
}

const localSources = computed(() => store.workspace?.sources ?? [])
const orderedSources = computed(() => store.allSources)
const defaultSourceId = computed(() => store.defaultStorageSourceId)
const fileMcpSources = computed(() => orderedSources.value.filter((source) => (
  (source.kind === 'local' || source.kind === 'smb')
  && source.available !== false
  && Boolean(source.path)
)))
const defaultMcpSourceId = computed(() => {
  if (defaultSourceId.value && fileMcpSources.value.some((source) => source.id === defaultSourceId.value)) {
    return defaultSourceId.value
  }
  return fileMcpSources.value[0]?.id ?? null
})
const selectedMcpSource = computed(() => fileMcpSources.value.find((source) => source.id === codexSourceId.value) ?? null)
const codexSourceOptions = computed(() => {
  if (!fileMcpSources.value.length) {
    return [{ value: null as string | null, label: '暂无可用本地/SMB 源', disabled: true }]
  }
  return fileMcpSources.value.map((source) => ({
    value: source.id as string | null,
    label: source.id === defaultMcpSourceId.value ? `默认 · ${source.name}` : source.name,
  }))
})
const codexStatusSummary = computed(() => {
  if (!isDesktop) return '仅桌面端可用'
  if (agentMcpStatus.value && !agentMcpStatus.value.nodeAvailable) return '需要本机 Node.js'
  const configured = agentMcpStatus.value?.clients.filter((item) => item.configured) ?? []
  if (configured.length) {
    const labels = configured.map((item) => item.label).join(' · ')
    const path = configured.find((item) => item.workspacePath)?.workspacePath
    const matched = path ? fileMcpSources.value.find((source) => source.path === path) : null
    return matched ? `已接入 ${labels} · ${matched.name}` : `已接入 ${labels}`
  }
  return '未接入 · 点击配置'
})

const anySelectedConfigured = computed(() => {
  const selected = new Set(selectedClients.value)
  return (agentMcpStatus.value?.clients ?? []).some((item) => selected.has(item.id as AgentClientId) && item.configured)
})

function persistAgentPreference() {
  saveCodexMcpPreference({ sourceId: codexSourceId.value, clients: selectedClients.value })
}

function ensureCodexSourceSelection() {
  if (codexSourceId.value && fileMcpSources.value.some((source) => source.id === codexSourceId.value)) return
  codexSourceId.value = defaultMcpSourceId.value
  persistAgentPreference()
}

async function refreshCodexStatus() {
  if (!isDesktop) return
  try {
    agentMcpStatus.value = await fetchAgentMcpStatus()
  } catch {
    agentMcpStatus.value = null
  }
}

function toggleCodexForm() {
  codexFormOpen.value = !codexFormOpen.value
  if (codexFormOpen.value) {
    ensureCodexSourceSelection()
    void refreshCodexStatus()
  }
}

function onCodexSourceChange() {
  persistAgentPreference()
  codexError.value = ''
  codexNotice.value = ''
}

function toggleAgentClient(id: AgentClientId) {
  const set = new Set(selectedClients.value)
  if (set.has(id)) {
    if (set.size === 1) return
    set.delete(id)
  } else {
    set.add(id)
  }
  selectedClients.value = AGENT_CLIENT_OPTIONS.map((item) => item.id).filter((item) => set.has(item))
  persistAgentPreference()
  codexError.value = ''
  codexNotice.value = ''
}

function clientConfigured(id: AgentClientId) {
  return agentMcpStatus.value?.clients.some((item) => item.id === id && item.configured) ?? false
}

function openSkillsWorkspace() {
  emit('close')
  void store.openSkillManager()
}

async function applyCodexMcp() {
  ensureCodexSourceSelection()
  const source = selectedMcpSource.value
  if (!source?.path) {
    codexError.value = '请选择可用的本地或 SMB 存储源'
    return
  }
  if (!selectedClients.value.length) {
    codexError.value = '请至少选择一个客户端'
    return
  }
  codexBusy.value = true
  codexError.value = ''
  codexNotice.value = ''
  try {
    persistAgentPreference()
    agentMcpStatus.value = await configureAgentMcp(source.path, selectedClients.value)
    await store.refreshSkills()
    const labels = selectedClients.value
      .map((id) => AGENT_CLIENT_OPTIONS.find((item) => item.id === id)?.label ?? id)
      .join('、')
    codexNotice.value = `已接入 ${labels}（工作区：${source.name}）`
    window.setTimeout(() => { codexNotice.value = '' }, 3200)
  } catch (error) {
    codexError.value = error instanceof Error ? error.message : String(error)
  } finally {
    codexBusy.value = false
  }
}

const sourcePageStats = computed(() => new Map(orderedSources.value.map((source) => {
  const pages = store.pages.filter((page) => pageBoundToSource(page, source.id))
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
  return `${source.path}\n${source.available === false ? '当前不可访问，请检查挂载后同步并载入' : '可用'}`
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

async function openFromFiles() {
  openingFromFiles.value = true
  try { await store.openFromFiles(); storageMenuOpen.value = false } finally { openingFromFiles.value = false }
}

async function syncAndReload() {
  if (!window.confirm('同步全部存储源并重新载入？尚未保存的编辑内容可能丢失。')) return
  syncingRemote.value = true
  try {
    await store.syncRemoteSources()
  } catch {
    /* store / backend 会保留错误 */
  } finally {
    syncingRemote.value = false
  }
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
  if (!aiFormOpen.value) {
    aiModeOpen.value = false
    return
  }
  if (aiConfig.value.mode === 'cli') void refreshAiCliStatus()
}

function setAiMode(mode: AiTaggingMode) {
  aiConfig.value.mode = mode
  aiModeOpen.value = false
  if (mode === 'cli') void refreshAiCliStatus()
}

function selectAiCliClient(id: AiCliClientId) {
  aiConfig.value.cliClient = id
  void refreshAiCliStatus()
}

function closeAiModeMenu(event: MouseEvent) {
  const target = event.target
  if (!(target instanceof Element) || !target.closest('.ai-mode-select')) aiModeOpen.value = false
}

onMounted(() => {
  document.addEventListener('click', closeAiModeMenu)
  ensureCodexSourceSelection()
  void refreshCodexStatus()
  void refreshAppVersion()
})
onBeforeUnmount(() => {
  document.removeEventListener('click', closeAiModeMenu)
  finishSourceDrag()
})

async function syncSource(sourceId: string) {
  if (isBackendSourceId(sourceId)) {
    await syncAndReload()
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

function clearDropState() {
  dropTargetId.value = null
  dropPosition.value = null
}

function finishSourceDrag() {
  draggingSourceId.value = null
  activeSourcePointerId = null
  clearDropState()
  document.body.classList.remove('storage-source-reordering')
  window.removeEventListener('pointermove', onSourcePointerMove)
  window.removeEventListener('pointerup', onSourcePointerUp)
  window.removeEventListener('pointercancel', onSourcePointerUp)
}

function updateDropFromPoint(clientY: number) {
  const sourceId = draggingSourceId.value
  const list = storageListEl.value
  if (!sourceId || !list) {
    clearDropState()
    return
  }

  const rows = [...list.querySelectorAll<HTMLElement>('[data-source-id]')]
  let best: { id: string; position: 'before' | 'after'; distance: number } | null = null
  for (const row of rows) {
    const id = row.dataset.sourceId
    if (!id || id === sourceId) continue
    const bounds = row.getBoundingClientRect()
    const mid = bounds.top + bounds.height / 2
    const position: 'before' | 'after' = clientY < mid ? 'before' : 'after'
    const distance = Math.abs(clientY - mid)
    if (!best || distance < best.distance) best = { id, position, distance }
  }

  if (!best) {
    clearDropState()
    return
  }
  dropTargetId.value = best.id
  dropPosition.value = best.position
}

function onSourcePointerMove(event: PointerEvent) {
  if (activeSourcePointerId !== null && event.pointerId !== activeSourcePointerId) return
  if (!draggingSourceId.value) return
  event.preventDefault()
  updateDropFromPoint(event.clientY)
}

function onSourcePointerUp(event: PointerEvent) {
  if (activeSourcePointerId !== null && event.pointerId !== activeSourcePointerId) return
  const sourceId = draggingSourceId.value
  const targetId = dropTargetId.value
  const position = dropPosition.value
  finishSourceDrag()
  if (!sourceId || !targetId || !position || sourceId === targetId) return
  store.reorderStorageSource(sourceId, targetId, position)
}

function startSourceDrag(event: PointerEvent, sourceId: string) {
  if (event.button !== 0) return
  event.preventDefault()
  event.stopPropagation()
  finishSourceDrag()
  draggingSourceId.value = sourceId
  activeSourcePointerId = event.pointerId
  document.body.classList.add('storage-source-reordering')
  const handle = event.currentTarget
  if (handle instanceof HTMLElement) {
    try { handle.setPointerCapture(event.pointerId) } catch { /* WebView 偶发不支持 */ }
  }
  window.addEventListener('pointermove', onSourcePointerMove, { passive: false })
  window.addEventListener('pointerup', onSourcePointerUp)
  window.addEventListener('pointercancel', onSourcePointerUp)
  updateDropFromPoint(event.clientY)
}

function canMoveSource(sourceId: string, direction: -1 | 1) {
  const order = store.storageSourceOrder
  const index = order.indexOf(sourceId)
  if (index === -1) return false
  const target = index + direction
  return target >= 0 && target < order.length
}

function moveSource(sourceId: string, direction: -1 | 1) {
  store.moveStorageSource(sourceId, direction)
}

function openConflictPage(pageId: string) {
  store.openPage(pageId)
  emit('close')
}

async function refreshAppVersion() {
  if (!isDesktop) {
    appVersion.value = tieRuntimeLabel('browser')
    return
  }
  try {
    appVersion.value = await getVersion()
  } catch {
    appVersion.value = tieRuntimeLabel(tieRuntimeKind())
  }
}

async function checkAppUpdate() {
  if (!canUseAppUpdater()) return
  checkingAppUpdate.value = true
  try {
    await checkForAppUpdate()
  } finally {
    checkingAppUpdate.value = false
  }
}

async function installAppUpdate() {
  await downloadAndInstallAppUpdate()
}
</script>

<template>
  <div class="backend-dialog-backdrop" @mousedown.self="emit('close')">
    <section class="backend-dialog storage-settings-dialog" role="dialog" aria-modal="true" aria-label="设置">
      <header>
        <div>
          <strong>设置</strong>
          <small>外观主题、存储源优先级与连接管理</small>
        </div>
        <button aria-label="关闭" @click="emit('close')">×</button>
      </header>

      <div class="theme-mode-row">
        <span>
          <strong>外观主题</strong>
          <small>{{ themeSummary }}</small>
        </span>
        <div class="theme-mode-switch" role="group" aria-label="外观主题">
          <button
            v-for="option in themeOptions"
            :key="option.value"
            type="button"
            :class="{ active: themeMode === option.value }"
            :aria-pressed="themeMode === option.value"
            @click="onThemeModeChange(option.value)"
          >{{ option.label }}</button>
        </div>
      </div>

      <div v-if="isMobileClient" class="theme-mode-row mobile-client-banner">
        <span>
          <strong>Android 精简版</strong>
          <small>仅支持 S3 与自定义后台同步；本地目录、SMB、Agent Skills 请使用桌面端。</small>
        </span>
      </div>

      <div class="theme-mode-row app-update-row">
        <span>
          <strong>应用更新</strong>
          <small>{{ appUpdateSummary }}</small>
        </span>
        <div v-if="canUseAppUpdater()" class="app-update-actions-inline">
          <button
            type="button"
            :disabled="checkingAppUpdate || appUpdateState.phase === 'downloading' || appUpdateState.phase === 'installing'"
            @click="checkAppUpdate"
          >
            {{ checkingAppUpdate ? '检查中…' : '检查更新' }}
          </button>
          <button
            v-if="appUpdateState.phase === 'available'"
            type="button"
            class="primary"
            @click="installAppUpdate"
          >
            立即更新
          </button>
        </div>
      </div>

      <div class="storage-settings-toolbar">
        <button
          :disabled="syncingRemote || store.reloading"
          :title="store.pendingSyncCount > 0 ? `含 ${store.pendingSyncCount} 条待推送的离线变更` : '冲掉离线队列、同步远程并重新载入本地/SMB'"
          @click="syncAndReload"
        >
          {{ syncingRemote || store.reloading
            ? '同步中…'
            : (store.pendingSyncCount > 0
              ? `↻ 同步并载入 (${store.pendingSyncCount})`
              : '↻ 同步并载入') }}
        </button>
        <button
          type="button"
          :class="{ active: aiFormOpen }"
          :aria-expanded="aiFormOpen"
          :title="aiStatusSummary"
          @click="toggleAiForm"
        >AI 标签提取</button>
        <button
          v-if="supportsLocalFileStorage"
          type="button"
          :class="{ active: codexFormOpen }"
          :aria-expanded="codexFormOpen"
          :title="codexStatusSummary"
          @click="toggleCodexForm"
        >Agent 知识库</button>
        <button v-if="store.syncConflictsCount > 0" class="storage-conflict-notice" type="button" disabled>{{ store.syncConflictsCount }} 个同步冲突 · 见下方列表</button>
        <button :class="{ active: storageMenuOpen }" @click="storageMenuOpen = !storageMenuOpen">+ 添加存储源</button>
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
          <span>{{ DEFAULT_PAGE_ICON }} {{ item.page.title || '无标题' }}</span>
          <small>{{ item.source?.name ?? item.conflict.sourceId }} · 本地 {{ item.conflict.localUpdatedAt.slice(0, 16).replace('T', ' ') }} · 远程 {{ item.conflict.remoteUpdatedAt.slice(0, 16).replace('T', ' ') }}</small>
        </button>
      </div>

      <div v-if="storageMenuOpen" class="storage-menu storage-settings-menu">
        <button v-if="supportsLocalFileStorage" :disabled="choosingWorkspace" @click="chooseWorkspace('local')"><strong>本地目录</strong><small>选择磁盘中的知识库</small></button>
        <button v-if="supportsLocalFileStorage" :disabled="choosingWorkspace" @click="chooseWorkspace('smb')"><strong>SMB 挂载目录</strong><small>选择系统已挂载的共享目录</small></button>
        <button @click="emit('connect-backend'); storageMenuOpen = false"><strong>自定义后台{{ backend.connected ? ' · 已连接' : '' }}</strong><small>{{ backend.connected ? '登录后可添加后台存储源' : '登录并添加后台存储源' }}</small></button>
        <button @click="openS3Form()"><strong>S3 兼容对象存储</strong><small>AWS S3、MinIO、R2、Ceph 等 · {{ isMobileClient ? '密钥保存在应用私有目录' : '本地保存' }}</small></button>
        <button v-if="supportsLocalFileStorage" :disabled="openingFromFiles" @click="openFromFiles"><strong>{{ openingFromFiles ? '正在打开…' : '从文件打开' }}</strong><small>打开 Markdown；不在已有源内时自动创建本地工作区</small></button>
        <button v-if="supportsLocalFileStorage" :disabled="importingMarkdown || !defaultSourceId || isBackendSourceId(defaultSourceId)" @click="importMarkdown"><strong>{{ importingMarkdown ? '正在导入…' : '导入 Markdown 文件' }}</strong><small>导入到优先级最高的可用存储源</small></button>
      </div>

      <form v-if="s3FormOpen" class="minio-config-form" @submit.prevent="saveS3Connection">
        <strong>{{ s3EditingSourceId ? '编辑 S3 连接' : '连接 S3 兼容对象存储' }}</strong>
        <small>兼容 AWS S3、MinIO、R2、Ceph；{{ isMobileClient ? '连接配置与密钥保存在应用私有目录。' : '连接配置保存在本机，密钥保存在系统凭据库。' }}</small>
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

      <form v-if="aiFormOpen" class="minio-config-form ai-tagging-form" @submit.prevent="saveAiSettings">
        <strong>AI 标签提取</strong>
        <small>{{ aiStatusSummary }} · 启用后与本地启发式结果合并。本地 CLI 较慢，但可复用本机已登录的 Agent 订阅。</small>
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

        <template v-if="aiConfig.mode === 'cli'">
          <div class="ai-cli-scan-row">
            <small>{{ aiCliScanning ? '正在搜索本机 CLI 并检测连通性…' : (aiCliStatus ? '已按自定义路径 / 自动搜索结果检测连通性' : '打开后将自动搜索并检测') }}</small>
            <button type="button" :disabled="!isDesktop || aiCliScanning" @click="refreshAiCliStatus">
              {{ aiCliScanning ? '检测中…' : '重新检测' }}
            </button>
          </div>
          <div class="codex-mcp-clients" role="radiogroup" aria-label="本地 CLI">
            <label
              v-for="client in aiCliClientOptions"
              :key="client.id"
              class="minio-config-checkbox"
            >
              <input
                type="radio"
                name="ai-cli-client"
                :checked="aiConfig.cliClient === client.id"
                :disabled="!isDesktop || aiCliScanning"
                @change="selectAiCliClient(client.id)"
              />
              <span>
                {{ client.label }}
                <em :class="{ warn: aiCliStatus && !aiCliConnected(client.id) }">{{ aiCliBadge(client.id) }}</em>
                <small>
                  {{ aiCliClientStatus(client.id)?.detail || `${client.bin} · 无头调用` }}
                  <template v-if="aiCliClientStatus(client.id)?.path"> · {{ aiCliClientStatus(client.id)?.path }}</template>
                </small>
              </span>
            </label>
          </div>
          <label>
            <span>{{ selectedAiCliLabel }} 路径（可选）</span>
            <div class="ai-cli-path-row">
              <input
                v-model="selectedAiCliPath"
                :placeholder="`留空则自动搜索 ${aiCliClientOptions.find((item) => item.id === aiConfig.cliClient)?.bin}`"
                :disabled="!isDesktop || aiCliScanning"
                @change="onAiCliPathChange"
              />
              <button type="button" :disabled="!isDesktop || aiCliScanning" @click="browseAiCliPath">浏览</button>
              <button type="button" :disabled="!isDesktop || aiCliScanning || !selectedAiCliPath" @click="clearAiCliPath">清除</button>
            </div>
          </label>
          <label>模型（可选）<input v-model="aiConfig.model" placeholder="留空则用 CLI 默认模型" /></label>
          <small v-if="!isDesktop" class="backend-error">本地 CLI 仅桌面端可用。</small>
          <small v-else-if="aiCliStatus && !aiCliConnected(aiConfig.cliClient)" class="backend-error">
            {{ aiCliClientStatus(aiConfig.cliClient)?.detail || `当前 ${selectedAiCliLabel} 未连通，请安装/登录或填写自定义路径后重新检测。` }}
          </small>
        </template>

        <template v-else>
          <label>服务地址<input v-model="aiConfig.endpoint" :placeholder="aiConfig.mode === 'openai' ? 'https://api.openai.com/v1' : defaultBackendEndpoint" /></label>
          <label v-if="aiConfig.mode === 'openai'">模型<input v-model="aiConfig.model" placeholder="gpt-4o-mini" /></label>
          <label>API Key（可选）<input v-model="aiConfig.apiKey" type="password" autocomplete="off" :placeholder="aiConfig.mode === 'tie' ? '留空则尝试使用后台登录 token' : 'OpenAI 模式必填'" /></label>
          <small v-if="aiConfig.mode === 'tie'">后台服务可通过环境变量 OPENAI_API_KEY 启用真实 LLM；未配置时使用启发式提取。</small>
        </template>

        <div>
          <button type="button" @click="aiFormOpen = false; aiModeOpen = false">取消</button>
          <button type="submit">保存 AI 设置</button>
        </div>
        <p v-if="aiNotice" class="minio-config-notice">{{ aiNotice }}</p>
      </form>
      <p v-if="!aiFormOpen && aiNotice" class="minio-config-notice">{{ aiNotice }}</p>

      <form v-if="supportsLocalFileStorage && codexFormOpen" class="minio-config-form codex-mcp-form" @submit.prevent="applyCodexMcp">
        <strong>Agent 知识库</strong>
        <small>{{ codexStatusSummary }} · 把本地/SMB 工作区接入 Codex / Cursor / Claude Code 的 MCP。Skill 在「Agent Skills」管理；接入时会同步到对应客户端目录。</small>
        <label>
          <span>工作区（存储源）</span>
          <TieSelect
            v-model="codexSourceId"
            :options="codexSourceOptions"
            :disabled="!fileMcpSources.length || codexBusy"
            @change="onCodexSourceChange"
          />
        </label>
        <small v-if="selectedMcpSource" class="codex-mcp-path">{{ selectedMcpSource.path }}</small>
        <div class="codex-mcp-clients" role="group" aria-label="接入客户端">
          <label
            v-for="client in agentClientOptions"
            :key="client.id"
            class="minio-config-checkbox"
          >
            <input
              type="checkbox"
              :checked="selectedClients.includes(client.id)"
              :disabled="codexBusy"
              @change="toggleAgentClient(client.id)"
            />
            <span>
              {{ client.label }}
              <em v-if="clientConfigured(client.id)">已接入</em>
              <small>{{ client.hint }}</small>
            </span>
          </label>
        </div>
        <small v-if="agentMcpStatus && !agentMcpStatus.nodeAvailable" class="backend-error">未检测到 Node.js，请先安装并确保可在终端运行 node。</small>
        <p v-if="codexError" class="backend-error">{{ codexError }}</p>
        <div>
          <button type="button" :disabled="codexBusy" @click="codexFormOpen = false">取消</button>
          <button type="button" :disabled="!selectedMcpSource" @click="openSkillsWorkspace">管理 Skills</button>
          <button type="submit" :disabled="codexBusy || !selectedMcpSource || !selectedClients.length || (agentMcpStatus !== null && !agentMcpStatus.nodeAvailable)">
            {{ codexBusy ? '正在接入…' : (anySelectedConfigured ? '更新接入' : '接入所选客户端') }}
          </button>
        </div>
        <p v-if="codexNotice" class="minio-config-notice">{{ codexNotice }}</p>
      </form>

      <div v-if="orderedSources.length || supportsLocalFileStorage" ref="storageListEl" class="storage-settings-list">
        <div
          v-if="supportsLocalFileStorage"
          class="storage-settings-row skills-workspace-row"
          role="button"
          tabindex="0"
          @click="openSkillsWorkspace"
          @keydown.enter.prevent="openSkillsWorkspace"
        >
          <span class="storage-drag-handle skills-workspace-mark" aria-hidden="true">◇</span>
          <div class="storage-settings-main">
            <div class="storage-settings-title">
              <span class="storage-status skills"></span>
              <strong>Agent Skills</strong>
              <span class="storage-default-badge">特殊工作区</span>
            </div>
            <small>{{ store.skillConnections.length ? `${store.skillConnections.length} 个已接入 · 点击打开` : '扫描接入 Agent Skills · 点击打开' }}</small>
          </div>
        </div>
        <div
          v-for="source in orderedSources"
          :key="source.id"
          class="storage-settings-row"
          :data-source-id="source.id"
          :class="{
            unavailable: source.available === false || sourceStatusClass(source) === 'offline',
            'backend-source-entry': source.kind === 'backend',
            dragging: draggingSourceId === source.id,
            'drop-before': dropTargetId === source.id && dropPosition === 'before',
            'drop-after': dropTargetId === source.id && dropPosition === 'after',
          }"
        >
          <button
            type="button"
            class="storage-drag-handle"
            title="拖动调整优先级"
            aria-label="拖动调整优先级"
            @pointerdown="startSourceDrag($event, source.id)"
          >⋮⋮</button>
          <div class="storage-settings-main" :title="sourceTitle(source)">
            <div class="storage-settings-title">
              <span class="storage-status" :class="sourceStatusClass(source)"></span>
              <strong>{{ source.name }}</strong>
              <span v-if="source.id === defaultSourceId" class="storage-default-badge">默认</span>
            </div>
            <small>{{ sourceDetail(source) }}</small>
          </div>
          <div class="storage-settings-actions" @mousedown.stop @click.stop>
            <button type="button" title="上移" :disabled="!canMoveSource(source.id, -1)" @click="moveSource(source.id, -1)">↑</button>
            <button type="button" title="下移" :disabled="!canMoveSource(source.id, 1)" @click="moveSource(source.id, 1)">↓</button>
            <button v-if="canSync(source)" :disabled="syncingRemote || store.reloading" title="同步此存储源" @click="syncSource(source.id)">↻</button>
            <button v-if="isDesktop && (source.kind === 'local' || source.kind === 'smb')" :disabled="source.available === false" title="在文件管理器中打开" @click="openSource(source.path)">↗</button>
            <button v-if="source.kind === 's3'" title="编辑连接" @click="openS3Form(source.id)">✎</button>
            <button v-else-if="canRename(source)" title="重命名显示名称" @click="renameSource(source.id)">✎</button>
            <button v-if="canDisconnect(source)" title="断开存储源" @click="disconnectSource(source.id)">×</button>
          </div>
        </div>
      </div>
      <p v-else class="storage-settings-empty">还没有连接存储源，点击「添加存储源」开始。</p>

      <p class="storage-settings-note">{{ isMobileClient ? 'Android 精简版通过 S3 或后台加载页面；连接后点「同步并载入」。' : '所有存储源的页面都在左侧同一棵树里；Agent Skills 是并列的特殊工作区。这里只调整优先级和管理连接。' }}</p>
    </section>
  </div>
</template>
