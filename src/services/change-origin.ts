import { getPlatformType, isTauriDesktop } from '@/services/platform'
import { invoke } from '@tauri-apps/api/core'
import packageInfo from '../../package.json'

export interface ChangeOrigin {
  clientId: string
  clientName: string
  clientVersion: string
  deviceId: string
  deviceName: string
  platform: string
  actor: string
  userId?: string
}

let originPromise: Promise<ChangeOrigin> | undefined

export async function currentChangeOrigin(actor?: string): Promise<ChangeOrigin> {
  originPromise ??= loadChangeOrigin()
  const origin = await originPromise
  return { ...origin, actor: actor?.trim() || origin.actor }
}

async function loadChangeOrigin(): Promise<ChangeOrigin> {
  if (isTauriDesktop()) {
    try {
      const origin = await invoke<ChangeOrigin>('get_change_origin')
      if (origin?.clientId && origin.deviceId) return origin
    } catch { /* Older native clients cannot claim a device identity. */ }
    return { clientId: 'tie-desktop', clientName: clientKindLabel(), clientVersion: packageInfo.version,
      deviceId: '', deviceName: '', platform: getPlatformType(), actor: '' }
  }
  const key = 'tie.device.identity.v1'
  let identity: { id: string; name: string; platform: string } | null = null
  try {
    const value = JSON.parse(localStorage.getItem(key) || 'null')
    if (typeof value?.id === 'string' && value.id && typeof value.name === 'string' && typeof value.platform === 'string') identity = value
  } catch { /* Create a browser installation identity when none was stored. */ }
  if (!identity) {
    const platform = typeof navigator === 'undefined' ? 'browser' : navigator.platform || 'browser'
    identity = { id: `dev_${crypto.randomUUID()}`, name: `浏览器 · ${platform}`, platform }
    try { localStorage.setItem(key, JSON.stringify(identity)) } catch { /* The identity remains valid for this session. */ }
  }
  return { clientId: 'tie-web', clientName: 'Tie 网页', clientVersion: packageInfo.version,
    deviceId: identity.id, deviceName: identity.name, platform: identity.platform, actor: '' }
}

export function changeOriginLabel(origin?: Partial<ChangeOrigin> | null) {
  if (!origin) return '来源未记录'
  return [origin.actor, origin.clientName || origin.clientId, origin.deviceName || (origin.deviceId ? origin.deviceId : '设备未记录')].filter(Boolean).join(' · ')
}

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
  const origin = await currentChangeOrigin()
  if (origin.deviceName) return `${origin.deviceName} · ${origin.clientName}`
  const kind = clientKindLabel()
  if (!isTauriDesktop()) return kind
  try {
    const { hostname } = await import('@tauri-apps/plugin-os')
    const host = (await hostname())?.trim()
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
