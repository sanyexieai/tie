export function isTauriDesktop() {
  if (typeof window === 'undefined') return false
  return '__TAURI_INTERNALS__' in window || '__TAURI__' in window
}

export type TieRuntimeKind = 'browser' | 'desktop-dev' | 'desktop-release'

export function tieRuntimeKind(): TieRuntimeKind {
  if (!isTauriDesktop()) return 'browser'
  if (import.meta.env.PROD) return 'desktop-release'
  return 'desktop-dev'
}

export function tieRuntimeLabel(kind: TieRuntimeKind = tieRuntimeKind()) {
  switch (kind) {
    case 'browser':
      return '浏览器演示'
    case 'desktop-dev':
      return '桌面开发版'
    case 'desktop-release':
      return '桌面正式版'
  }
}
