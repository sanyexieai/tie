import { computed, ref } from 'vue'
import type { StorageKind, StorageSource } from '@/types'

export type TiePlatformType = 'browser' | 'android' | 'ios' | 'linux' | 'macos' | 'windows' | 'unknown'

function guessMobilePlatformFromUserAgent(): 'android' | 'ios' | null {
  if (typeof navigator === 'undefined') return null
  const ua = navigator.userAgent
  if (/Android/i.test(ua)) return 'android'
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios'
  return null
}

function syncMobileViewport() {
  if (typeof window === 'undefined') return
  mobileViewport.value = window.matchMedia('(max-width: 720px)').matches
}

function initialPlatformType(): TiePlatformType {
  if (typeof window === 'undefined') return 'browser'
  if (!('__TAURI_INTERNALS__' in window || '__TAURI__' in window)) return 'browser'
  return guessMobilePlatformFromUserAgent() ?? 'unknown'
}

const platformType = ref<TiePlatformType>(initialPlatformType())
const mobileViewport = ref(
  typeof window !== 'undefined' && window.matchMedia('(max-width: 720px)').matches,
)
let initPromise: Promise<void> | null = null

export function isTauriDesktop() {
  if (typeof window === 'undefined') return false
  return '__TAURI_INTERNALS__' in window || '__TAURI__' in window
}

export async function initPlatform() {
  if (initPromise) return initPromise
  initPromise = (async () => {
    syncMobileViewport()
    if (typeof window !== 'undefined') {
      const mq = window.matchMedia('(max-width: 720px)')
      mq.addEventListener('change', syncMobileViewport)
    }
    if (!isTauriDesktop()) {
      platformType.value = 'browser'
      return
    }
    try {
      const { type } = await import('@tauri-apps/plugin-os')
      const osType = await type()
      if (osType === 'android' || osType === 'ios' || osType === 'linux' || osType === 'macos' || osType === 'windows') {
        platformType.value = osType
        return
      }
      platformType.value = guessMobilePlatformFromUserAgent() ?? 'unknown'
    } catch {
      platformType.value = guessMobilePlatformFromUserAgent() ?? 'unknown'
    }
  })()
  return initPromise
}

export function getPlatformType() {
  return platformType.value
}

/** 原生 Android / iOS 客户端 */
export const isMobileClient = computed(() => (
  platformType.value === 'android' || platformType.value === 'ios'
))

/**
 * 使用移动端布局与能力限制（含 Android WebView OS 识别失败、窄屏 Tauri 壳）。
 * 存储源过滤、隐藏 SMB/Skills 等应使用此标志，而非仅用 isMobileClient。
 */
export const usesMobileUi = computed(() => {
  if (isMobileClient.value) return true
  if (!isTauriDesktop()) return false
  if (mobileViewport.value) return true
  return guessMobilePlatformFromUserAgent() !== null
})

export const supportsLocalFileStorage = computed(() => isTauriDesktop())

export const supportsSmbStorage = computed(() => (
  isTauriDesktop() && !usesMobileUi.value
))

export const supportsAgentSkills = computed(() => supportsSmbStorage.value)

/** 移动端仅支持本地目录、S3 与自定义后台存储源 */
export function isMobileSupportedStorageKind(kind: StorageKind | string) {
  return kind === 'local' || kind === 's3' || kind === 'backend'
}

export function isMobileSupportedStorageSource(source: StorageSource) {
  return isMobileSupportedStorageKind(source.kind)
}

export type TieRuntimeKind = 'browser' | 'desktop-dev' | 'desktop-release' | 'mobile-dev' | 'mobile-release'

export function tieRuntimeKind(): TieRuntimeKind {
  if (!isTauriDesktop()) return 'browser'
  if (usesMobileUi.value) return import.meta.env.PROD ? 'mobile-release' : 'mobile-dev'
  return import.meta.env.PROD ? 'desktop-release' : 'desktop-dev'
}

export function tieRuntimeLabel(kind: TieRuntimeKind = tieRuntimeKind()) {
  switch (kind) {
    case 'browser':
      return '浏览器演示'
    case 'desktop-dev':
      return '桌面开发版'
    case 'desktop-release':
      return '桌面正式版'
    case 'mobile-dev':
      return 'Android 开发版'
    case 'mobile-release':
      return 'Android 正式版'
  }
}
