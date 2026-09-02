import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { getVersion } from '@tauri-apps/api/app'
import { check, type DownloadEvent, type Update } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'
import { openPath, revealItemInDir } from '@tauri-apps/plugin-opener'
import { reactive, readonly } from 'vue'
import {
  hasCustomUpdateEndpoints,
  loadUpdateEndpoints,
} from '@/services/app-update-config'
import {
  ANDROID_PLATFORM_KEYS,
  fetchUpdateManifest,
  fileNameFromUpdateUrl,
  isAppVersionNewer,
  pickPlatformArtifact,
  resolveDesktopPlatformCandidates,
  type UpdateManifest,
  type UpdatePlatformArtifact,
} from '@/services/app-update-manifest'
import { isMobileClient, isTauriDesktop, tieRuntimeKind, type TieRuntimeKind } from '@/services/platform'

export type AppUpdatePhase =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'installing'
  | 'downloaded'
  | 'uptodate'
  | 'error'

export type AppUpdateInstallMode = 'auto' | 'manual'

export interface AppUpdateSnapshot {
  phase: AppUpdatePhase
  currentVersion: string
  availableVersion: string | null
  notes: string | null
  progress: number | null
  error: string | null
  installMode: AppUpdateInstallMode | null
  downloadedPath: string | null
}

interface PendingManualUpdate {
  version: string
  notes: string | null
  url: string
  fileName: string
}

const state = reactive<AppUpdateSnapshot>({
  phase: 'idle',
  currentVersion: '0.0.0',
  availableVersion: null,
  notes: null,
  progress: null,
  error: null,
  installMode: null,
  downloadedPath: null,
})

export const appUpdateState = readonly(state)

export {
  hasCustomUpdateEndpoints,
  loadUpdateEndpoints,
  resetUpdateEndpoints,
  saveUpdateEndpoints,
} from '@/services/app-update-config'

export function isDesktopApp() {
  return isTauriDesktop()
}

export function supportsAppUpdateCheck(): boolean {
  return tieRuntimeKind() !== 'browser'
}

export function supportsAutoAppUpdate(): boolean {
  return tieRuntimeKind() === 'desktop-release' && !hasCustomUpdateEndpoints()
}

export function appUpdaterUnavailableReasonForRuntime(runtime: TieRuntimeKind): string | null {
  if (runtime === 'browser') {
    return '浏览器演示模式不支持检查更新'
  }
  return null
}

export function appUpdaterUnavailableReason(): string | null {
  return appUpdaterUnavailableReasonForRuntime(tieRuntimeKind())
}

export function canUseAppUpdater() {
  return supportsAppUpdateCheck()
}

export function appUpdateModeHint(): string {
  const runtime = tieRuntimeKind()
  if (runtime === 'browser') return '浏览器演示模式'
  if (supportsAutoAppUpdate()) return '支持自动更新；失败时可下载安装包手动安装'
  if (runtime === 'mobile-release' || runtime === 'mobile-dev') {
    return '移动端不支持应用内自动安装，可下载 APK 后手动安装'
  }
  if (runtime === 'desktop-dev') return '开发版仅支持下载安装包手动安装'
  if (hasCustomUpdateEndpoints()) return '已启用自定义更新源，将下载安装包手动安装'
  return '支持下载安装包手动安装'
}

export function extractUpdaterErrorMessage(error: unknown): string | null {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim()
  }
  if (typeof error === 'string' && error.trim()) {
    return error.trim()
  }
  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>
    if (typeof record.message === 'string' && record.message.trim()) {
      return record.message.trim()
    }
    if (typeof record.error === 'string' && record.error.trim()) {
      return record.error.trim()
    }
  }
  return null
}

export function humanizeUpdaterError(raw: string, context: 'check' | 'install'): string {
  const lower = raw.toLowerCase()

  if (/signature|minisign|verify|验签|签名/.test(raw)) {
    return `签名验证失败：${raw}。可改用「下载到本地」手动安装，或确认 Release 使用一致的 updater 私钥。`
  }
  if (/404|not found|不存在/.test(lower)) {
    return `更新文件不存在：${raw}。请确认 Release 已上传对应平台的安装包与 latest.json。`
  }
  if (/network|fetch|timeout|connection|timed out|dns|ssl|certificate|网络|连接|超时/.test(lower)) {
    return `网络错误：${raw}。请检查能否访问更新源。`
  }
  if (/permission|access denied|eacces|eperm|denied|权限|拒绝/.test(lower)) {
    return context === 'install'
      ? `安装权限不足：${raw}。可改用「下载到本地」手动安装。`
      : `权限不足：${raw}`
  }
  if (/plugin|not allowed|forbidden|updater|unsupported|未实现|not found.*plugin/.test(lower)) {
    return `当前环境不支持应用内自动更新：${raw}。请改用「下载到本地」。`
  }
  if (/platform|arch|unsupported target|不支持的平台/.test(lower)) {
    return `当前平台无可用更新包：${raw}。请确认 latest.json 包含本机平台条目。`
  }

  return raw
}

export function formatUpdaterError(
  error: unknown,
  fallback: string,
  context: 'check' | 'install',
): string {
  const raw = extractUpdaterErrorMessage(error) ?? fallback
  return humanizeUpdaterError(raw, context)
}

let pendingPluginUpdate: Update | null = null
let pendingManualUpdate: PendingManualUpdate | null = null
let downloadedBytes = 0
let downloadTotalBytes = 0
let downloadProgressUnlisten: UnlistenFn | null = null

function resetProgress() {
  state.progress = null
  downloadedBytes = 0
  downloadTotalBytes = 0
}

function setError(message: string) {
  state.phase = 'error'
  state.error = message
}

function clearPendingUpdate() {
  pendingPluginUpdate = null
  pendingManualUpdate = null
}

function setAvailableUpdate(options: {
  version: string
  notes: string | null
  installMode: AppUpdateInstallMode
  manual?: PendingManualUpdate
  plugin?: Update
}) {
  state.phase = 'available'
  state.availableVersion = options.version
  state.notes = options.notes
  state.installMode = options.installMode
  state.downloadedPath = null
  state.error = null
  pendingManualUpdate = options.manual ?? null
  pendingPluginUpdate = options.plugin ?? null
}

async function loadCurrentVersion() {
  if (!isDesktopApp()) {
    state.currentVersion = '0.0.0'
    return
  }
  state.currentVersion = await getVersion()
}

async function resolvePlatformCandidates(): Promise<string[]> {
  if (isMobileClient.value) return [...ANDROID_PLATFORM_KEYS]
  try {
    const { arch, type } = await import('@tauri-apps/plugin-os')
    return resolveDesktopPlatformCandidates(await type(), await arch())
  } catch {
    return ['linux-x86_64', 'windows-x86_64', 'darwin-aarch64']
  }
}

function manualUpdateFromManifest(manifest: UpdateManifest, artifactUrl: string, platformKey: string): PendingManualUpdate {
  const fallbackName = platformKey.startsWith('android')
    ? `tie-${manifest.version}-android-universal.apk`
    : `tie-${manifest.version}-update.bin`
  return {
    version: manifest.version,
    notes: manifest.notes ?? null,
    url: artifactUrl,
    fileName: fileNameFromUpdateUrl(artifactUrl, fallbackName),
  }
}

async function checkViaManifest(currentVersion: string): Promise<PendingManualUpdate | null> {
  const manifest = await fetchUpdateManifest(loadUpdateEndpoints())
  if (!isAppVersionNewer(manifest.version, currentVersion)) return null
  const candidates = await resolvePlatformCandidates()
  const artifact = pickPlatformArtifact(manifest, candidates)
  if (!artifact) {
    throw new Error(`latest.json 中未找到当前平台条目（${candidates.join(' / ') || 'unknown'}）`)
  }
  return manualUpdateFromManifest(manifest, artifact.url, artifact.platformKey)
}

function manualUpdateFromPlugin(update: Update, candidates: string[]): PendingManualUpdate | null {
  const platforms = update.rawJson.platforms
  if (!platforms || typeof platforms !== 'object') return null

  const manifestPlatforms: Record<string, UpdatePlatformArtifact> = {}
  for (const [key, value] of Object.entries(platforms as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue
    const entry = value as Record<string, unknown>
    if (typeof entry.url !== 'string' || !entry.url.trim()) continue
    manifestPlatforms[key] = {
      url: entry.url.trim(),
      signature: typeof entry.signature === 'string' ? entry.signature.trim() : undefined,
    }
  }

  const manifest: UpdateManifest = {
    version: update.version,
    notes: update.body ?? null,
    platforms: manifestPlatforms,
  }
  const artifact = pickPlatformArtifact(manifest, candidates)
  if (!artifact) return null
  return manualUpdateFromManifest(manifest, artifact.url, artifact.platformKey)
}

async function ensureDownloadProgressListener() {
  if (downloadProgressUnlisten) return
  downloadProgressUnlisten = await listen<{ downloaded: number; total?: number | null }>(
    'app-update-download-progress',
    (event) => {
      downloadedBytes = event.payload.downloaded
      downloadTotalBytes = event.payload.total ?? 0
      if (downloadTotalBytes > 0) {
        state.progress = Math.min(100, Math.round((downloadedBytes / downloadTotalBytes) * 100))
      } else {
        state.progress = null
      }
    },
  )
}

function onPluginDownloadEvent(event: DownloadEvent) {
  switch (event.event) {
    case 'Started':
      downloadedBytes = 0
      downloadTotalBytes = event.data.contentLength ?? 0
      state.progress = downloadTotalBytes ? 0 : null
      break
    case 'Progress':
      downloadedBytes += event.data.chunkLength
      if (downloadTotalBytes > 0) {
        state.progress = Math.min(100, Math.round((downloadedBytes / downloadTotalBytes) * 100))
      }
      break
    case 'Finished':
      state.progress = 100
      break
  }
}

async function openDownloadedArtifact(path: string) {
  if (isMobileClient.value) {
    await openPath(path)
    return
  }
  await revealItemInDir(path)
}

export async function initializeAppUpdater() {
  if (!canUseAppUpdater()) return
  await loadCurrentVersion()
}

export async function checkForAppUpdate(options: { silent?: boolean } = {}) {
  const unavailableReason = appUpdaterUnavailableReason()
  if (unavailableReason) {
    if (!options.silent) setError(unavailableReason)
    return null
  }

  state.phase = 'checking'
  state.error = null
  state.availableVersion = null
  state.notes = null
  state.installMode = null
  state.downloadedPath = null
  resetProgress()
  clearPendingUpdate()

  try {
    await loadCurrentVersion()
    const currentVersion = state.currentVersion

    if (supportsAutoAppUpdate()) {
      try {
        const update = await check()
        if (update) {
          const candidates = await resolvePlatformCandidates()
          const manual = manualUpdateFromPlugin(update, candidates) ?? undefined
          setAvailableUpdate({
            version: update.version,
            notes: update.body ?? null,
            installMode: 'auto',
            plugin: update,
            manual,
          })
          return update
        }
        state.phase = 'uptodate'
        return null
      } catch (pluginError) {
        const manual = await checkViaManifest(currentVersion)
        if (manual) {
          setAvailableUpdate({
            version: manual.version,
            notes: manual.notes,
            installMode: 'manual',
            manual,
          })
          return manual
        }
        throw pluginError
      }
    }

    const manual = await checkViaManifest(currentVersion)
    if (!manual) {
      state.phase = 'uptodate'
      return null
    }
    setAvailableUpdate({
      version: manual.version,
      notes: manual.notes,
      installMode: 'manual',
      manual,
    })
    return manual
  } catch (error) {
    const message = formatUpdaterError(error, '检查更新失败', 'check')
    if (options.silent) {
      state.phase = 'idle'
      state.error = null
      return null
    }
    setError(message)
    return null
  }
}

export async function downloadAppUpdateToLocal() {
  const unavailableReason = appUpdaterUnavailableReason()
  if (unavailableReason) {
    setError(unavailableReason)
    return null
  }

  if (!pendingManualUpdate) {
    const update = await checkForAppUpdate()
    if (!update) return null
  }
  const manual = pendingManualUpdate
  if (!manual) {
    setError('未找到可下载的更新包')
    return null
  }

  state.phase = 'downloading'
  state.error = null
  state.downloadedPath = null
  resetProgress()

  try {
    await ensureDownloadProgressListener()
    const path = await invoke<string>('download_update_file', {
      url: manual.url,
      fileName: manual.fileName,
    })
    state.phase = 'downloaded'
    state.downloadedPath = path
    state.progress = 100
    state.installMode = 'manual'
    return path
  } catch (error) {
    const message = formatUpdaterError(error, '下载更新包失败', 'install')
    setError(message)
    return null
  }
}

export async function openDownloadedAppUpdate() {
  if (!state.downloadedPath) return false
  try {
    await openDownloadedArtifact(state.downloadedPath)
    return true
  } catch (error) {
    setError(formatUpdaterError(error, '无法打开安装包', 'install'))
    return false
  }
}

export async function downloadAndInstallAppUpdate() {
  const unavailableReason = appUpdaterUnavailableReason()
  if (unavailableReason) {
    setError(unavailableReason)
    return false
  }

  if (!pendingPluginUpdate && !pendingManualUpdate) {
    const update = await checkForAppUpdate()
    if (!update) return false
  }

  if (supportsAutoAppUpdate() && pendingPluginUpdate) {
    state.phase = 'downloading'
    state.error = null
    resetProgress()
    try {
      await pendingPluginUpdate.downloadAndInstall(onPluginDownloadEvent)
      state.phase = 'installing'
      await relaunch()
      return true
    } catch (error) {
      const path = await downloadAppUpdateToLocal()
      if (path) {
        state.error = `${formatUpdaterError(error, '自动安装失败', 'install')} 已下载到：${path}`
        return false
      }
      setError(formatUpdaterError(error, '下载或安装更新失败', 'install'))
      return false
    }
  }

  const path = await downloadAppUpdateToLocal()
  if (!path) return false

  if (isMobileClient.value) {
    try {
      await openDownloadedArtifact(path)
      state.error = null
      return true
    } catch (error) {
      setError(`${formatUpdaterError(error, '无法唤起安装程序', 'install')} 安装包已保存到：${path}`)
      return false
    }
  }

  try {
    await openDownloadedArtifact(path)
    state.error = null
    return true
  } catch (error) {
    setError(`${formatUpdaterError(error, '无法打开安装包', 'install')} 文件已保存到：${path}`)
    return false
  }
}

export async function checkForAppUpdateOnStartup() {
  if (!canUseAppUpdater()) return null
  await initializeAppUpdater()
  return checkForAppUpdate({ silent: true })
}
