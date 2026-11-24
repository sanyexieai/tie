import { invoke } from '@tauri-apps/api/core'
import { isFileSourceId } from '@/services/storage/types'

export interface GitSyncResult {
  mode: 'skipped' | 'committed' | 'synced'
  message: string
  committed: boolean
  pushed: boolean
}

export interface GitRuntimeStatus {
  available: boolean
  path: string | null
  source: string
  version: string | null
  downloadUrl: string | null
  canDownload: boolean
  message: string
}

function isTauri() {
  return '__TAURI_INTERNALS__' in window
}

export function gitErrorMessage(error: unknown) {
  if (typeof error === 'string') return error
  if (error instanceof Error) return error.message
  return '同步失败'
}

export async function syncWorkspaceWithGit(sourceId: string): Promise<GitSyncResult> {
  if (!isTauri()) {
    return { mode: 'skipped', message: '', committed: false, pushed: false }
  }
  return invoke<GitSyncResult>('git_sync_workspace', { sourceId })
}

export async function enableGitSync(sourceId: string, remoteUrl: string): Promise<GitSyncResult> {
  if (!isTauri()) throw new Error('多设备同步只在桌面端可用')
  return invoke<GitSyncResult>('git_enable_sync', { sourceId, remoteUrl })
}

export async function gitRuntimeStatus(): Promise<GitRuntimeStatus> {
  if (!isTauri()) {
    return {
      available: false,
      path: null,
      source: 'missing',
      version: null,
      downloadUrl: null,
      canDownload: false,
      message: '仅桌面端可用',
    }
  }
  return invoke<GitRuntimeStatus>('git_runtime_status')
}

export async function ensureGitRuntime(): Promise<GitRuntimeStatus> {
  if (!isTauri()) throw new Error('仅桌面端可下载同步组件')
  return invoke<GitRuntimeStatus>('git_ensure_runtime')
}

/** 保存成功后静默对齐；无 remote / 未配置时 skipped。失败不抛给保存主路径。 */
export async function syncAfterSave(sourceId: string | null | undefined): Promise<GitSyncResult | null> {
  if (!sourceId || !isFileSourceId(sourceId) || !isTauri()) return null
  try {
    return await syncWorkspaceWithGit(sourceId)
  } catch (error) {
    const message = gitErrorMessage(error)
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('tie:sync-after-save', { detail: { sourceId, error: message } }))
    }
    return { mode: 'skipped', message, committed: false, pushed: false }
  }
}

/** 缺 Git / 找不到可执行文件时可继续读盘；冲突与 remote 错误交给界面。 */
export function gitSyncCanFallback(message: string) {
  return message.includes('无法运行 git')
    || message.includes('未找到 Git')
    || message.includes('找不到')
    || message.includes('请先安装 Git')
}

export function gitNeedsInstall(message: string) {
  return message.includes('未找到 Git') || message.includes('请先安装 Git')
}
