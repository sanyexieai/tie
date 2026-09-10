import { getPlatformType } from '@/services/platform'

export type PlatformAccessKind = 'desktop' | 'android' | 'browser'

export interface PlatformAccess {
  readonly kind: PlatformAccessKind
  readonly canPick: boolean
  readonly canPickFile: boolean
  readonly canRegisterAbsolute: boolean
  pick(kind: 'file' | 'directory'): Promise<string | null>
  pickFile(options?: { accept?: string }): Promise<File | null>
  exists(path: string): Promise<boolean>
  openNative(path: string): Promise<void>
}

export function isContentUri(path: string) {
  return /^content:\/\//i.test(String(path || '').trim())
}

function isTauriRuntime() {
  return typeof window !== 'undefined' && ('__TAURI_INTERNALS__' in window || '__TAURI__' in window)
}

function accessKind(): PlatformAccessKind {
  if (!isTauriRuntime()) return 'browser'
  if (getPlatformType() === 'android') return 'android'
  return 'desktop'
}

async function pickBrowserFile(accept?: string): Promise<File | null> {
  if (typeof window === 'undefined') throw new Error('当前环境不能选择文件')
  const picker = (window as Window & {
    showOpenFilePicker?: (options: { multiple?: boolean }) => Promise<Array<{ getFile: () => Promise<File> }>>
  }).showOpenFilePicker
  if (typeof picker === 'function') {
    try {
      const handles = await picker({ multiple: false })
      return await handles[0]?.getFile() ?? null
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return null
    }
  }
  if (typeof document === 'undefined') throw new Error('当前环境不能选择文件')
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    if (accept) input.accept = accept
    let settled = false
    const finish = (file: File | null) => {
      if (settled) return
      settled = true
      window.removeEventListener('focus', onFocus)
      resolve(file)
    }
    const onFocus = () => {
      window.setTimeout(() => {
        if (!settled) finish(input.files?.[0] ?? null)
      }, 600)
    }
    input.addEventListener('change', () => finish(input.files?.[0] ?? null), { once: true })
    input.addEventListener('cancel', () => finish(null), { once: true })
    window.addEventListener('focus', onFocus, { once: true })
    input.click()
  })
}

const browserAccess: PlatformAccess = {
  kind: 'browser',
  canPick: false,
  canPickFile: true,
  canRegisterAbsolute: false,
  async pick() {
    throw new Error('浏览器演示模式不能选择本机路径，请导入文件副本。')
  },
  async pickFile(options) {
    return pickBrowserFile(options?.accept)
  },
  async exists() {
    return false
  },
  async openNative(path) {
    if (/^https?:/i.test(path) && typeof window !== 'undefined') {
      window.open(path, '_blank', 'noopener,noreferrer')
      return
    }
    throw new Error('浏览器演示模式不能打开本机路径')
  },
}

const desktopAccess: PlatformAccess = {
  kind: 'desktop',
  canPick: true,
  canPickFile: false,
  canRegisterAbsolute: true,
  async pick(kind) {
    const { open } = await import('@tauri-apps/plugin-dialog')
    const selected = await open({
      directory: kind === 'directory',
      multiple: false,
      title: kind === 'directory' ? '选择要链接的本地目录' : '选择要链接的本地文件',
    })
    if (typeof selected === 'string') return selected
    if (Array.isArray(selected) && typeof selected[0] === 'string') return selected[0]
    return null
  },
  async pickFile() {
    throw new Error('桌面客户端请使用系统文件对话框')
  },
  async exists(path) {
    const trimmed = path.trim()
    if (!trimmed) return false
    const { invoke } = await import('@tauri-apps/api/core')
    return invoke<boolean>('native_path_exists', { path: trimmed })
  },
  async openNative(path) {
    const trimmed = String(path || '').trim()
    if (!trimmed) throw new Error('打开路径为空')
    if (/^(https?:|mailto:|tie:)/i.test(trimmed)) {
      throw new Error(`不能用系统打开器打开链接：${trimmed}`)
    }
    const { openPath } = await import('@tauri-apps/plugin-opener')
    await openPath(trimmed)
  },
}

const androidAccess: PlatformAccess = {
  kind: 'android',
  canPick: true,
  canPickFile: false,
  canRegisterAbsolute: true,
  async pick(kind) {
    const { invoke } = await import('@tauri-apps/api/core')
    const picked = await invoke<{ uri?: string; cancelled?: boolean } | null>('pick_native_resource', { kind })
    const uri = String(picked?.uri || '').trim()
    if (!uri || picked?.cancelled) return null
    return uri
  },
  async pickFile() {
    throw new Error('Android 请使用系统文档选择器')
  },
  async exists(path) {
    const trimmed = path.trim()
    if (!trimmed) return false
    const { invoke } = await import('@tauri-apps/api/core')
    return invoke<boolean>('native_path_exists', { path: trimmed })
  },
  async openNative(path) {
    const trimmed = path.trim()
    if (isContentUri(trimmed)) {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('open_native_resource', { path: trimmed })
      return
    }
    const { openPath } = await import('@tauri-apps/plugin-opener')
    await openPath(trimmed)
  },
}

export function getPlatformAccess(): PlatformAccess {
  if (!isTauriRuntime()) return browserAccess
  return accessKind() === 'android' ? androidAccess : desktopAccess
}
