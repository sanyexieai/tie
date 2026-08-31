export type ThemeMode = 'system' | 'light' | 'dark'
export type ResolvedTheme = 'light' | 'dark'

const storageKey = 'tie-theme-mode-v1'

export function loadThemeMode(): ThemeMode {
  try {
    const saved = localStorage.getItem(storageKey)
    if (saved === 'system' || saved === 'light' || saved === 'dark') return saved
  } catch {
    // ignore
  }
  return 'system'
}

export function saveThemeMode(mode: ThemeMode) {
  localStorage.setItem(storageKey, mode)
}

export function systemPrefersDark() {
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

export function resolveTheme(mode: ThemeMode = loadThemeMode()): ResolvedTheme {
  if (mode === 'system') return systemPrefersDark() ? 'dark' : 'light'
  return mode
}

function notifyThemeChanged() {
  window.dispatchEvent(new CustomEvent('tie:theme-changed'))
}

export function applyTheme(mode: ThemeMode = loadThemeMode()) {
  const resolved = resolveTheme(mode)
  document.documentElement.dataset.theme = resolved
  document.documentElement.style.colorScheme = resolved
  notifyThemeChanged()
  return resolved
}

export function initTheme() {
  const mode = loadThemeMode()
  applyTheme(mode)
  const media = window.matchMedia('(prefers-color-scheme: dark)')
  const onChange = () => {
    if (loadThemeMode() === 'system') applyTheme('system')
  }
  media.addEventListener('change', onChange)
  return () => media.removeEventListener('change', onChange)
}

export function setThemeMode(mode: ThemeMode) {
  saveThemeMode(mode)
  return applyTheme(mode)
}

export function readThemeColor(name: string, fallback: string) {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value || fallback
}

export function readGraphPalette() {
  return {
    bg0: readThemeColor('--graph-bg-0', '#fffefa'),
    bg1: readThemeColor('--graph-bg-1', '#f3f1ec'),
    link: readThemeColor('--graph-link', 'rgba(111, 137, 112, 0.55)'),
    linkDim: readThemeColor('--graph-link-dim', 'rgba(111, 137, 112, 0.08)'),
    tagLink: readThemeColor('--graph-tag-link', 'rgba(176, 146, 81, 0.45)'),
    tagLinkDim: readThemeColor('--graph-tag-link-dim', 'rgba(176, 146, 81, 0.08)'),
    node: readThemeColor('--graph-node', '#dfe8df'),
    nodeActive: readThemeColor('--graph-node-active', '#839a85'),
    nodeDim: readThemeColor('--graph-node-dim', 'rgba(131, 154, 133, 0.14)'),
    tagNode: readThemeColor('--graph-tag-node', '#f0e4c8'),
    tagNodeDim: readThemeColor('--graph-tag-node-dim', 'rgba(196, 160, 90, 0.14)'),
    text: readThemeColor('--graph-text', '#5f5952'),
    textStrong: readThemeColor('--graph-text-strong', '#3f3932'),
    textMuted: readThemeColor('--graph-text-muted', '#9a938a'),
    ring: readThemeColor('--graph-ring', 'rgba(111, 137, 112, 0.85)'),
  }
}
