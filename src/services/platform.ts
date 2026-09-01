import { computed, ref } from 'vue'

export type TiePlatformType = 'browser' | 'android' | 'ios' | 'linux' | 'macos' | 'windows' | 'unknown'

const platformType = ref<TiePlatformType>('browser')
let initPromise: Promise<void> | null = null

export function isTauriDesktop() {
  if (typeof window === 'undefined') return false
  return '__TAURI_INTERNALS__' in window || '__TAURI__' in window
}

export async function initPlatform() {
  if (initPromise) return initPromise
  initPromise = (async () => {
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
      platformType.value = 'unknown'
    } catch {
      platformType.value = 'unknown'
    }
  })()
  return initPromise
}

export function getPlatformType() {
  return platformType.value
}

export const isMobileClient = computed(() => (
  platformType.value === 'android' || platformType.value === 'ios'
))

export const supportsLocalFileStorage = computed(() => (
  isTauriDesktop() && !isMobileClient.value
))

export const supportsAgentSkills = computed(() => supportsLocalFileStorage.value)

export type TieRuntimeKind = 'browser' | 'desktop-dev' | 'desktop-release' | 'mobile-dev' | 'mobile-release'

export function tieRuntimeKind(): TieRuntimeKind {
  if (!isTauriDesktop()) return 'browser'
  if (isMobileClient.value) return import.meta.env.PROD ? 'mobile-release' : 'mobile-dev'
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
