<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { openPath } from '@tauri-apps/plugin-opener'
import { getVersion } from '@tauri-apps/api/app'
import TieSelect from '@/components/TieSelect.vue'
import type { StorageSource } from '@/types'
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
  locateTieCli,
  loadCodexMcpPreference,
  saveCodexMcpPreference,
  type AgentClientId,
  type AgentMcpStatus,
} from '@/services/codex-mcp'
import { buildMcpHandoffPrompt } from '@/services/mcp-handoff'
import { pageBoundToSource } from '@/services/page-sources'
import { isBackendSourceId, isBackendManagedS3SourceId, defaultBackendEndpoint } from '@/services/backend'
import { isS3SourceId, providerForS3Source } from '@/services/s3'
import { enableGitSync, ensureGitRuntime, gitErrorMessage, gitNeedsInstall, gitRuntimeStatus } from '@/services/storage/git-sync'
import { storageRegistry } from '@/services/storage/registry'
import type { S3ConnectionInput } from '@/services/storage/types'
import { loadThemeMode, resolveTheme, setThemeMode, type ThemeMode } from '@/services/theme'
import {
  appUpdateState,
  appUpdateModeHint,
  appUpdaterUnavailableReason,
  canUseAppUpdater,
  checkForAppUpdate,
  downloadAndInstallAppUpdate,
  downloadAppUpdateToLocal,
  hasCustomUpdateEndpoints,
  loadUpdateEndpoints,
  openDownloadedAppUpdate,
  resetUpdateEndpoints,
  saveUpdateEndpoints,
} from '@/services/app-updater'
import { parseUpdateEndpointInput } from '@/services/app-update-config'
import { isTauriDesktop, isMobileClient, isMobileSupportedStorageSource, supportsAgentSkills, supportsLocalFileStorage, supportsSmbStorage, tieRuntimeKind, tieRuntimeLabel, usesMobileUi } from '@/services/platform'

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
const openingTie = ref(false)
const importingTiez = ref(false)
const packingTiez = ref(false)
const bundleNotice = ref('')
const syncingRemote = ref(false)
const gitSourceId = ref('')
const gitRemoteUrl = ref('')
const gitNotice = ref('')
const gitBusy = ref(false)
const syncingDefaultBackend = ref(false)
const defaultBackendSyncNotice = ref('')
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
const mcpHandoffCopied = ref(false)
const tieCliPath = ref<string | null>(null)
let mcpHandoffTimer = 0

const remoteMcpUrl = computed(() => (
  backend.connected && backend.mcp?.running && backend.mcp.url ? backend.mcp.url : ''
))
const mcpStatusText = computed(() => {
  if (backend.connected) {
    if (remoteMcpUrl.value) return `后台 MCP HTTP · 运行中 · ${remoteMcpUrl.value}`
    if (backend.mcp?.enabled) return `后台 MCP HTTP · 未启动${backend.mcp.error ? ` · ${backend.mcp.error}` : ''}`
    return '后台 MCP HTTP · 未开启。启动后台时设置 TIE_MCP_HTTP=1'
  }
  return tieCliPath.value ? `本地 MCP · tie mcp · ${tieCliPath.value}` : '本地 MCP · 未找到 tie CLI'
})
const agentClientOptions = AGENT_CLIENT_OPTIONS
const appVersion = ref('—')
const checkingAppUpdate = ref(false)
const updateConfigVisible = ref(false)
const updateEndpointDraft = ref(loadUpdateEndpoints().join('\n'))
const updateConfigNotice = ref('')
const updateTitleTapCount = ref(0)
let updateTitleTapTimer: ReturnType<typeof setTimeout> | null = null

const appUpdateSummary = computed(() => {
  const unavailableReason = appUpdaterUnavailableReason()
  if (unavailableReason) return unavailableReason
  if (appUpdateState.phase === 'available') {
    const mode = appUpdateState.installMode === 'auto' ? '可自动更新' : '可下载手动安装'
    return `发现新版本 ${appUpdateState.availableVersion} · ${mode}`
  }
  if (appUpdateState.phase === 'uptodate') return '已是最新版本'
  if (appUpdateState.phase === 'downloaded') {
    return appUpdateState.downloadedPath
      ? `安装包已下载：${appUpdateState.downloadedPath}`
      : '安装包已下载，可手动安装'
  }
  if (appUpdateState.phase === 'downloading' || appUpdateState.phase === 'installing') {
    return appUpdateState.progress == null
      ? '正在下载更新…'
      : `正在下载更新… ${appUpdateState.progress}%`
  }
  if (appUpdateState.phase === 'error') return appUpdateState.error ?? '检查更新失败'
  const customHint = hasCustomUpdateEndpoints() ? ' · 自定义更新源' : ''
  return `当前版本 ${appVersion.value} · ${tieRuntimeLabel()} · ${appUpdateModeHint()}${customHint}`
})

const showManualDownloadActions = computed(() => (
  appUpdateState.phase === 'available'
  || appUpdateState.phase === 'error'
  || appUpdateState.phase === 'downloaded'
))

const primaryUpdateLabel = computed(() => {
  if (appUpdateState.phase === 'downloaded') return '打开安装包'
  if (appUpdateState.installMode === 'auto') return '立即更新'
  return isMobileClient.value ? '下载并安装' : '下载到本地'
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
const settingsOrderedSources = computed(() => {
  const visible = usesMobileUi.value
    ? orderedSources.value.filter((source) => isMobileSupportedStorageSource(source))
    : orderedSources.value
  return visible.filter((source) => source.kind === 'local' || source.kind === 'smb' || (source.kind === 's3' && !isBackendManagedS3SourceId(source.id)))
})
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
    return [{ value: null as string | null, label: '暂无工作区', disabled: true }]
  }
  return fileMcpSources.value.map((source) => ({
    value: source.id as string | null,
    label: source.id === defaultMcpSourceId.value ? `默认 · ${source.name}` : source.name,
  }))
})
const codexStatusSummary = computed(() => {
  if (!isDesktop) return '仅桌面端可用'
  if (remoteMcpUrl.value) return `后台 MCP HTTP · ${remoteMcpUrl.value}`
  const stale = agentMcpStatus.value?.clients.find((item) => item.error)
  if (stale?.error) return stale.error
  if (tieCliPath.value) return '本地 MCP · tie mcp'
  return '未找到 tie CLI'
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

async function refreshLocalMcp() {
  tieCliPath.value = await locateTieCli()
  if (backend.connected) await backend.refreshMcp()
}

function toggleCodexForm() {
  codexFormOpen.value = !codexFormOpen.value
  if (codexFormOpen.value) {
    ensureCodexSourceSelection()
    void refreshCodexStatus()
    void refreshLocalMcp()
  }
}

function onCodexSourceChange() {
  persistAgentPreference()
  codexError.value = ''
  codexNotice.value = ''
}

function mcpHandoffText() {
  const source = selectedMcpSource.value
  if (!source?.path) return ''
  const selected = new Set(selectedClients.value)
  const known = agentMcpStatus.value?.clients ?? []
  const clients = AGENT_CLIENT_OPTIONS.filter((item) => selected.has(item.id)).map((item) => ({
    id: item.id,
    label: item.label,
    configPath: known.find((status) => status.id === item.id)?.configPath,
  }))
  return buildMcpHandoffPrompt({
    mode: remoteMcpUrl.value ? 'http' : 'local',
    workspaceName: source.name,
    workspacePath: source.path,
    mcpUrl: remoteMcpUrl.value,
    cliPath: tieCliPath.value,
    clients,
  })
}

async function copyMcpHandoff() {
  const text = mcpHandoffText()
  if (!text) return
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.left = '-9999px'
    document.body.appendChild(area)
    area.select()
    document.execCommand('copy')
    area.remove()
  }
  mcpHandoffCopied.value = true
  window.clearTimeout(mcpHandoffTimer)
  mcpHandoffTimer = window.setTimeout(() => { mcpHandoffCopied.value = false }, 2000)
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
    codexError.value = '请选择一个可用的工作区'
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
    agentMcpStatus.value = await configureAgentMcp(source.path, selectedClients.value, remoteMcpUrl.value || null)
    await store.refreshSkills()
    const labels = selectedClients.value
      .map((id) => AGENT_CLIENT_OPTIONS.find((item) => item.id === id)?.label ?? id)
      .join('、')
    codexNotice.value = remoteMcpUrl.value
      ? `已为 ${labels} 写入后台地址 ${remoteMcpUrl.value}。请新开一个对话。`
      : `已为 ${labels} 写入本机 tie MCP（tie mcp）。请新开一个对话。`
    window.setTimeout(() => { codexNotice.value = '' }, 8000)
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
    if (!backend.connected) return '请先连接云服务'
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
  const pageInfo = `${source.kind === 'smb' ? 'SMB 工作区' : source.kind === 's3' ? '旧版 S3' : '工作区'} · ${sourcePageLabel(source.id)}`
  return synced && source.kind === 's3' ? `已同步 · ${synced} · ${sourcePageLabel(source.id)}` : pageInfo
}

function sourceTitle(source: StorageSource) {
  if (source.kind === 's3' && isBackendManagedS3SourceId(source.id)) return `${source.path}\n后台托管 S3，凭据保存在服务端`
  if (source.kind === 's3') return `${source.path}\nS3 页面以 tie/pages/*.md 保存`
  if (source.kind === 'backend') return `${source.path}\n后台默认云工作区`
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

/** 仅用于存量直连 S3 的编辑；不再提供新建入口。 */
function openS3Form(sourceId?: string) {
  s3Error.value = ''
  s3Notice.value = ''
  storageMenuOpen.value = false
  if (!sourceId || !isS3SourceId(sourceId) || isBackendManagedS3SourceId(sourceId)) {
    s3Notice.value = '直连 S3 已废弃。请使用「云服务」后台，并在服务端选择磁盘或 S3 存储。'
    return
  }
  const provider = providerForS3Source(sourceId)
  if (!provider) return
  s3FormOpen.value = true
  s3EditingSourceId.value = sourceId
  s3Name.value = provider.name
  s3Endpoint.value = provider.endpoint
  s3Bucket.value = provider.bucket
  s3Region.value = provider.region ?? ''
  s3Notice.value = '此为旧版直连 S3。新部署请改为后台托管存储。'
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

async function openTieSolution() {
  openingTie.value = true
  bundleNotice.value = ''
  try {
    if (await store.openTieEntry()) {
      storageMenuOpen.value = false
      bundleNotice.value = '已打开 .tie 解决方案'
    }
  } catch (error) {
    bundleNotice.value = error instanceof Error ? error.message : String(error)
  } finally {
    openingTie.value = false
  }
}

async function importTiezBundle() {
  importingTiez.value = true
  bundleNotice.value = ''
  try {
    if (await store.importTiez()) {
      storageMenuOpen.value = false
      bundleNotice.value = '已导入 .tiez 压缩包'
    }
  } catch (error) {
    bundleNotice.value = error instanceof Error ? error.message : String(error)
  } finally {
    importingTiez.value = false
  }
}

async function exportTiezBundle() {
  packingTiez.value = true
  bundleNotice.value = ''
  try {
    if (await store.packCurrentSourceTiez()) {
      bundleNotice.value = '已导出 .tiez 压缩包'
    }
  } catch (error) {
    bundleNotice.value = error instanceof Error ? error.message : String(error)
  } finally {
    packingTiez.value = false
  }
}

async function importBrowserTiez() {
  importingTiez.value = true
  bundleNotice.value = ''
  try {
    if (await store.importTiezBrowser()) {
      storageMenuOpen.value = false
      bundleNotice.value = '已导入 .tiez'
    }
  } catch (error) {
    bundleNotice.value = error instanceof Error ? error.message : String(error)
  } finally {
    importingTiez.value = false
  }
}

async function exportBrowserTiez() {
  packingTiez.value = true
  bundleNotice.value = ''
  try {
    await store.exportTiezBrowser()
    bundleNotice.value = '已开始下载 .tiez'
  } catch (error) {
    bundleNotice.value = error instanceof Error ? error.message : String(error)
  } finally {
    packingTiez.value = false
  }
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

async function syncToDefaultBackend() {
  if (!backend.connected) {
    emit('connect-backend')
    return
  }
  syncingDefaultBackend.value = true
  defaultBackendSyncNotice.value = ''
  try {
    const count = await store.syncLocalToDefaultBackend()
    defaultBackendSyncNotice.value = `已同步 ${count} 个本地页面和文件资源到默认服务端`
    window.setTimeout(() => { defaultBackendSyncNotice.value = '' }, 2600)
  } catch (error) {
    defaultBackendSyncNotice.value = error instanceof Error ? error.message : '同步到默认服务端失败'
  } finally {
    syncingDefaultBackend.value = false
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
  void refreshLocalMcp()
  void refreshAppVersion()
})
onBeforeUnmount(() => {
  document.removeEventListener('click', closeAiModeMenu)
  finishSourceDrag()
  if (updateTitleTapTimer) clearTimeout(updateTitleTapTimer)
  window.clearTimeout(mcpHandoffTimer)
})

async function openGitSync(sourceId: string) {
  gitSourceId.value = gitSourceId.value === sourceId ? '' : sourceId
  gitRemoteUrl.value = ''
  gitNotice.value = ''
  if (!gitSourceId.value) return
  try {
    const status = await gitRuntimeStatus()
    if (!status.available) {
      gitNotice.value = status.message || '未找到同步组件'
    }
  } catch (error) {
    gitNotice.value = gitErrorMessage(error)
  }
}

async function downloadGitRuntime() {
  gitBusy.value = true
  gitNotice.value = '正在下载同步组件…'
  try {
    const status = await ensureGitRuntime()
    gitNotice.value = status.available
      ? `同步组件已就绪${status.version ? `（${status.version}）` : ''}`
      : (status.message || '下载失败')
  } catch (error) {
    gitNotice.value = gitErrorMessage(error)
  } finally {
    gitBusy.value = false
  }
}

async function saveGitSync() {
  if (!gitSourceId.value) return
  gitBusy.value = true
  gitNotice.value = ''
  try {
    let status = await gitRuntimeStatus()
    if (!status.available && status.canDownload) {
      status = await ensureGitRuntime()
    }
    if (!status.available) {
      gitNotice.value = status.message || '未找到同步组件'
      return
    }
    const result = await enableGitSync(gitSourceId.value, gitRemoteUrl.value.trim())
    await store.syncSource(gitSourceId.value)
    await store.reloadWorkspace()
    gitNotice.value = result.message || '已启用多设备同步；之后保存会自动对齐'
    gitSourceId.value = ''
  } catch (error) {
    const message = gitErrorMessage(error)
    gitNotice.value = message
    if (gitNeedsInstall(message)) {
      /* keep form open so user can download */
    }
  } finally {
    gitBusy.value = false
  }
}

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
      throw new Error('已不再支持新建直连 S3。请使用云服务后台，并在服务端配置磁盘或 S3。')
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
    : '移除此工作区？该目录和其中的文件不会被删除。'
  if (!window.confirm(label)) return
  await store.removeStorageSource(sourceId)
}

async function renameSource(sourceId: string) {
  if (isBackendSourceId(sourceId)) return
  const source = orderedSources.value.find((item) => item.id === sourceId)
  if (!source) return
  const name = window.prompt('工作区名称', source.name)
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
  return store.canMoveStorageSource(sourceId, direction)
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
  if (appUpdateState.phase === 'downloaded') {
    await openDownloadedAppUpdate()
    return
  }
  await downloadAndInstallAppUpdate()
}

async function downloadAppUpdateOnly() {
  await downloadAppUpdateToLocal()
}

function onUpdateTitleTap() {
  updateTitleTapCount.value += 1
  if (updateTitleTapTimer) clearTimeout(updateTitleTapTimer)
  updateTitleTapTimer = setTimeout(() => {
    updateTitleTapCount.value = 0
  }, 2000)
  if (updateTitleTapCount.value >= 8) {
    updateTitleTapCount.value = 0
    updateConfigVisible.value = true
    updateEndpointDraft.value = loadUpdateEndpoints().join('\n')
    updateConfigNotice.value = ''
  }
}

function saveUpdateEndpointConfig() {
  const endpoints = parseUpdateEndpointInput(updateEndpointDraft.value)
  if (!endpoints.length) {
    updateConfigNotice.value = '至少保留一个有效的 HTTPS/HTTP latest.json 地址'
    return
  }
  saveUpdateEndpoints(endpoints)
  updateConfigNotice.value = '更新源已保存，下次检查时将优先使用自定义地址'
}

function restoreDefaultUpdateEndpoints() {
  resetUpdateEndpoints()
  updateEndpointDraft.value = loadUpdateEndpoints().join('\n')
  updateConfigNotice.value = '已恢复默认 PackHub 更新源'
}
</script>

<template>
  <div class="backend-dialog-backdrop" @mousedown.self="emit('close')">
    <section class="backend-dialog storage-settings-dialog" role="dialog" aria-modal="true" aria-label="设置">
      <header>
        <div>
          <strong>设置</strong>
          <small>本地可添加多个工作区；服务器只绑定一台，绑定后开启云同步</small>
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

      <div class="theme-mode-row app-update-row">
        <span @click="onUpdateTitleTap">
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
            v-if="appUpdateState.phase === 'available' || appUpdateState.phase === 'downloaded'"
            type="button"
            class="primary"
            @click="installAppUpdate"
          >
            {{ primaryUpdateLabel }}
          </button>
          <button
            v-if="showManualDownloadActions && appUpdateState.phase !== 'downloaded'"
            type="button"
            :disabled="appUpdateState.phase === 'downloading' || appUpdateState.phase === 'installing'"
            @click="downloadAppUpdateOnly"
          >
            仅下载
          </button>
        </div>
      </div>

      <div v-if="updateConfigVisible" class="theme-mode-row app-update-config-row">
        <div class="app-update-config-panel">
          <strong>更新服务地址</strong>
          <small>每行一个 latest.json 地址，按顺序尝试；默认 PackHub，GitHub 为回退</small>
          <textarea
            v-model="updateEndpointDraft"
            rows="4"
            spellcheck="false"
            placeholder="https://example.com/tie/latest.json"
          />
          <div class="app-update-config-actions">
            <button type="button" @click="saveUpdateEndpointConfig">保存</button>
            <button type="button" @click="restoreDefaultUpdateEndpoints">恢复默认</button>
            <button type="button" @click="updateConfigVisible = false">收起</button>
          </div>
          <p v-if="updateConfigNotice" class="backend-notice">{{ updateConfigNotice }}</p>
        </div>
      </div>

      <div class="theme-mode-row">
        <span>
          <strong>{{ backend.connected ? '本地 + 服务器' : '本地' }}</strong>
          <small>{{ backend.connected ? `${backend.profile.endpoint} · 保存后自动云同步` : '尚未绑定服务器，页面只保存在本机工作区' }}</small>
        </span>
        <button type="button" :class="{ primary: !backend.connected }" @click="emit('connect-backend')">
          {{ backend.connected ? '服务器' : '绑定服务器' }}
        </button>
      </div>

      <div class="storage-settings-toolbar">
        <button
          v-if="backend.connected"
          type="button"
          title="修改已绑定的服务器"
          @click="emit('connect-backend')"
        >服务器设置</button>
        <button
          v-if="backend.connected"
          type="button"
          :disabled="syncingDefaultBackend || syncingRemote || store.reloading"
          title="把各个工作区同步到已绑定的服务器"
          @click="syncToDefaultBackend"
        >
          {{ syncingDefaultBackend ? '同步到默认服务端…' : '↑ 同步到默认服务端' }}
        </button>
        <button
          :disabled="syncingRemote || store.reloading"
          :title="store.pendingSyncCount > 0
            ? `含 ${store.pendingSyncCount} 条待推送的离线变更`
            : (backend.connected ? '同步到服务器并重新载入工作区' : '重新载入各个工作区')"
          @click="syncAndReload"
        >
          {{ syncingRemote || store.reloading
            ? '同步中…'
            : (store.pendingSyncCount > 0
              ? `↻ 同步并载入 (${store.pendingSyncCount})`
              : '↻ 同步并载入') }}
        </button>
        <button
          v-if="!usesMobileUi"
          type="button"
          :class="{ active: aiFormOpen }"
          :aria-expanded="aiFormOpen"
          :title="aiStatusSummary"
          @click="toggleAiForm"
        >AI 标签提取</button>
        <button
          v-if="supportsAgentSkills"
          type="button"
          :class="{ active: codexFormOpen }"
          :aria-expanded="codexFormOpen"
          :title="codexStatusSummary"
          @click="toggleCodexForm"
        >Agent 知识库</button>
        <button v-if="store.syncConflictsCount > 0" class="storage-conflict-notice" type="button" disabled>{{ store.syncConflictsCount }} 个同步冲突 · 见下方列表</button>
        <button :class="{ active: storageMenuOpen }" @click="storageMenuOpen = !storageMenuOpen">+ 添加工作区</button>
      </div>
      <p v-if="defaultBackendSyncNotice" class="backend-notice">{{ defaultBackendSyncNotice }}</p>

      <div v-if="store.syncConflictPages.length" class="storage-conflict-list">
        <strong>同步冲突</strong>
        <small>内容不一致时请打开页面对照处理。日常保存成功即已写入本机；对端对齐失败不会撤销保存。</small>
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
        <button v-if="supportsLocalFileStorage" :disabled="choosingWorkspace" @click="chooseWorkspace('local')"><strong>本地文件夹</strong><small>{{ usesMobileUi ? '选择手机上的文件夹或应用内知识库' : '再添加一个工作区' }}</small></button>
        <button v-if="supportsSmbStorage" :disabled="choosingWorkspace" @click="chooseWorkspace('smb')"><strong>SMB 挂载目录</strong><small>把已挂载的共享目录当作一个工作区</small></button>
        <button v-if="!supportsLocalFileStorage" :disabled="importingTiez" @click="importBrowserTiez"><strong>{{ importingTiez ? '正在导入…' : '导入压缩包 (.tiez)' }}</strong><small>浏览器演示工作区</small></button>
        <button v-if="!supportsLocalFileStorage" :disabled="packingTiez" @click="exportBrowserTiez"><strong>{{ packingTiez ? '正在导出…' : '导出压缩包 (.tiez)' }}</strong><small>下载当前演示工作区</small></button>
        <button v-if="supportsLocalFileStorage && !usesMobileUi" :disabled="openingFromFiles" @click="openFromFiles"><strong>{{ openingFromFiles ? '正在打开…' : '从文件打开' }}</strong><small>打开 .tie / .tiez / Markdown</small></button>
        <button v-if="supportsLocalFileStorage && !usesMobileUi" :disabled="openingTie" @click="openTieSolution"><strong>{{ openingTie ? '正在打开…' : '打开解决方案 (.tie)' }}</strong><small>文本入口，指向工作区目录树</small></button>
        <button v-if="supportsLocalFileStorage && !usesMobileUi" :disabled="importingTiez" @click="importTiezBundle"><strong>{{ importingTiez ? '正在导入…' : '导入压缩包 (.tiez)' }}</strong><small>解压为一个新的本地工作区</small></button>
        <button v-if="supportsLocalFileStorage && !usesMobileUi" :disabled="packingTiez || !defaultSourceId || isBackendSourceId(defaultSourceId)" @click="exportTiezBundle"><strong>{{ packingTiez ? '正在导出…' : '导出压缩包 (.tiez)' }}</strong><small>打包当前优先本地/SMB 工作区</small></button>
        <button v-if="supportsLocalFileStorage && !usesMobileUi" :disabled="importingMarkdown || !defaultSourceId || isBackendSourceId(defaultSourceId)" @click="importMarkdown"><strong>{{ importingMarkdown ? '正在导入…' : '导入 Markdown 文件' }}</strong><small>导入到当前默认工作区</small></button>
      </div>
      <p v-if="bundleNotice" class="backend-notice">{{ bundleNotice }}</p>

      <form v-if="s3FormOpen" class="minio-config-form" @submit.prevent="saveS3Connection">
        <strong>编辑旧版直连 S3（废弃）</strong>
        <small>请尽快迁到「云服务」后台托管。{{ usesMobileUi ? '连接配置与密钥仍在应用私有目录。' : '连接配置仍在本机，密钥在系统凭据库。' }}</small>
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

      <form v-if="supportsAgentSkills && codexFormOpen" class="minio-config-form codex-mcp-form" @submit.prevent="applyCodexMcp">
        <strong>Agent 知识库</strong>
        <small>{{ codexStatusSummary }}。有后台地址时写入 HTTP；否则写入本机 `tie mcp`，让客户端拉起 MCP。Skill 仍会同步。</small>
        <label>
          <span>工作区</span>
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
              <em v-else-if="agentMcpStatus?.clients.find((item) => item.id === client.id)?.workspacePath">未连接</em>
              <small>{{ client.hint }}</small>
            </span>
          </label>
        </div>
        <div class="mcp-handoff">
          <div>
            <strong>给 Agent 的接入提示词</strong>
            <small>{{ mcpStatusText }}。有后台地址时提示词写 HTTP；否则写本机 `tie mcp`。</small>
          </div>
          <button type="button" :disabled="!selectedMcpSource" @click="copyMcpHandoff">{{ mcpHandoffCopied ? '已复制' : '复制提示词' }}</button>
        </div>
        <small v-if="!remoteMcpUrl && !tieCliPath" class="backend-error">未找到 tie CLI，本地模式无法交给 Agent。可先构建 tie，或绑定已开启 MCP HTTP 的后台。</small>
        <p v-if="codexError" class="backend-error">{{ codexError }}</p>
        <div>
          <button type="button" :disabled="codexBusy" @click="codexFormOpen = false">取消</button>
          <button type="button" :disabled="!selectedMcpSource" @click="openSkillsWorkspace">管理 Skills</button>
          <button type="submit" :disabled="codexBusy || !selectedMcpSource || !selectedClients.length || (!remoteMcpUrl && !tieCliPath)">
            {{ codexBusy ? '正在接入…' : (anySelectedConfigured ? '更新接入' : '接入所选客户端') }}
          </button>
        </div>
        <p v-if="codexNotice" class="minio-config-notice">{{ codexNotice }}</p>
      </form>

      <div v-if="settingsOrderedSources.length || supportsAgentSkills" ref="storageListEl" class="storage-settings-list">
        <div
          v-if="supportsAgentSkills"
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
          v-for="source in settingsOrderedSources"
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
            title="拖动调整工作区顺序"
            aria-label="拖动调整工作区顺序"
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
            <button v-if="canSync(source)" :disabled="syncingRemote || store.reloading" title="同步此工作区" @click="syncSource(source.id)">↻</button>
            <button v-if="isDesktop && (source.kind === 'local' || source.kind === 'smb')" class="labeled" type="button" title="配置多设备同步（保存后自动对齐）" @click="openGitSync(source.id)">同步</button>
            <button v-if="isDesktop && (source.kind === 'local' || source.kind === 'smb')" :disabled="source.available === false" title="在文件管理器中打开" @click="openSource(source.path)">↗</button>
            <button v-if="source.kind === 's3' && !isBackendManagedS3SourceId(source.id)" title="编辑旧版直连 S3" @click="openS3Form(source.id)">✎</button>
            <button v-else-if="source.kind === 'backend'" title="修改后台服务" @click="emit('connect-backend')">✎</button>
            <button v-else-if="canRename(source)" title="重命名显示名称" @click="renameSource(source.id)">✎</button>
            <button v-if="canDisconnect(source)" title="移除工作区" @click="disconnectSource(source.id)">×</button>
          </div>
        </div>
      </div>
      <p v-else class="storage-settings-empty">还没有工作区。点「添加工作区」选择一个文件夹。</p>

      <form v-if="gitSourceId" class="storage-settings-note" @submit.prevent="saveGitSync">
        <label>多设备同步地址
          <input v-model="gitRemoteUrl" type="text" placeholder="https://example.com/notes.git" :disabled="gitBusy" required>
        </label>
        <div>
          <button type="submit" :disabled="gitBusy">{{ gitBusy ? '处理中…' : '启用并保存后自动对齐' }}</button>
          <button v-if="isDesktop" type="button" :disabled="gitBusy" @click="downloadGitRuntime">下载同步组件</button>
        </div>
        <p v-if="gitNotice">{{ gitNotice }}</p>
      </form>

      <p class="storage-settings-note">{{ backend.connected ? '当前是本地 + 服务器。页面写在各个工作区里，保存后同步到这一台服务器。' : '当前是本地。可以添加多个工作区；绑定一台服务器后才会云同步。' }}</p>
    </section>
  </div>
</template>
