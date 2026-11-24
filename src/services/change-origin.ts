import { getPlatformType, isTauriDesktop } from '@/services/platform'

/** 人称「我」分不出是哪台客户端、哪个 Agent。 */
const GENERIC_ACTORS = new Set(['我', 'me', 'i', 'user', 'myself'])

export const CHANGE_AGENTS = ['Cursor', 'Codex', 'Claude Code'] as const

export function isGenericChangeActor(value: string | null | undefined) {
  const text = value?.trim() ?? ''
  if (!text) return true
  if (text === '我') return true
  return GENERIC_ACTORS.has(text.toLowerCase())
}

export function clientKindLabel() {
  if (typeof window === 'undefined' || !isTauriDesktop()) return '浏览器'
  const type = getPlatformType()
  if (type === 'android') return 'Android'
  if (type === 'ios') return 'iOS'
  return '桌面'
}

export async function resolveClientLabel() {
  const kind = clientKindLabel()
  if (!isTauriDesktop()) return kind
  try {
    const { hostname } = await import('@tauri-apps/plugin-os')
    const host = (await hostname()).trim()
    if (host) return `${host} · ${kind}`
  } catch {
    // 拿不到主机名时只保留客户端种类
  }
  return kind
}

export function formatChangeActor(client: string, agent?: string | null) {
  const who = agent?.trim() ?? ''
  const where = client.trim()
  if (who && where) return `${who} · ${where}`
  return who || where
}

export function auditActorLabel(actor?: string | null) {
  const text = actor?.trim() ?? ''
  if (!text || isGenericChangeActor(text) || text === 'mcp' || text === 'mcp-http') return '未标明来源'
  return text
}
