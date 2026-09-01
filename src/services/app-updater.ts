import { getVersion } from '@tauri-apps/api/app'
import { check, type DownloadEvent } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'
import { reactive, readonly } from 'vue'
import { isTauriDesktop, tieRuntimeKind } from '@/services/platform'

export type AppUpdatePhase =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'installing'
  | 'uptodate'
  | 'error'

export interface AppUpdateSnapshot {
  phase: AppUpdatePhase
  currentVersion: string
  availableVersion: string | null
  notes: string | null
  progress: number | null
  error: string | null
}

const state = reactive<AppUpdateSnapshot>({
  phase: 'idle',
  currentVersion: '0.0.0',
  availableVersion: null,
  notes: null,
  progress: null,
  error: null,
})

export const appUpdateState = readonly(state)

export function isDesktopApp() {
  return isTauriDesktop()
}

export function appUpdaterUnavailableReason(): string | null {
  const runtime = tieRuntimeKind()
  if (runtime === 'browser') {
    return '浏览器演示模式不支持自动更新'
  }
  if (runtime === 'desktop-dev') {
    return '桌面开发版不支持自动更新，请安装 Release 安装包后使用'
  }
  if (runtime === 'mobile-dev') {
    return 'Android 开发版不支持自动更新，请安装 Release APK 后使用'
  }
  return null
}

export function canUseAppUpdater() {
  return appUpdaterUnavailableReason() === null
}

let pendingUpdate: Awaited<ReturnType<typeof check>> | null = null
let downloadedBytes = 0
let downloadTotalBytes = 0

function resetProgress() {
  state.progress = null
  downloadedBytes = 0
  downloadTotalBytes = 0
}

function setError(message: string) {
  state.phase = 'error'
  state.error = message
}

async function loadCurrentVersion() {
  if (!isDesktopApp()) {
    state.currentVersion = '0.0.0'
    return
  }
  state.currentVersion = await getVersion()
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
  resetProgress()
  pendingUpdate = null

  try {
    await loadCurrentVersion()
    const update = await check()
    if (!update) {
      state.phase = 'uptodate'
      return null
    }
    pendingUpdate = update
    state.phase = 'available'
    state.availableVersion = update.version
    state.notes = update.body ?? null
    return update
  } catch (error) {
    const message = error instanceof Error ? error.message : '检查更新失败'
    if (options.silent) {
      state.phase = 'idle'
      state.error = null
      return null
    }
    setError(message)
    return null
  }
}

function onDownloadEvent(event: DownloadEvent) {
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

export async function downloadAndInstallAppUpdate() {
  const unavailableReason = appUpdaterUnavailableReason()
  if (unavailableReason) {
    setError(unavailableReason)
    return false
  }
  if (!pendingUpdate) {
    const update = await checkForAppUpdate()
    if (!update) return false
  }
  const update = pendingUpdate
  if (!update) return false

  state.phase = 'downloading'
  state.error = null
  resetProgress()

  try {
    await update.downloadAndInstall(onDownloadEvent)
    state.phase = 'installing'
    await relaunch()
    return true
  } catch (error) {
    const message = error instanceof Error ? error.message : '下载或安装更新失败'
    setError(message)
    return false
  }
}

export async function checkForAppUpdateOnStartup() {
  if (!canUseAppUpdater()) return null
  await initializeAppUpdater()
  return checkForAppUpdate({ silent: true })
}
