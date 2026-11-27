import { invoke } from '@tauri-apps/api/core'
import { getPlatformType, isTauriDesktop } from '@/services/platform'

export function deviceUnlockAvailable(): boolean {
  if (!isTauriDesktop()) return false
  const platform = getPlatformType()
  if (platform === 'android' || platform === 'ios') return false
  return typeof navigator === 'undefined' || !/Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
}

export async function loadDevicePagePassword(scope: string): Promise<string | null> {
  if (!deviceUnlockAvailable()) return null
  return request<string | null>('page_device_password_load', { scope })
}

export async function saveDevicePagePassword(scope: string, password: string): Promise<void> {
  if (!deviceUnlockAvailable()) throw new Error('仅桌面客户端支持在此设备记住解锁')
  await request<void>('page_device_password_save', { scope, password })
}

export async function forgetDevicePagePassword(scope: string): Promise<void> {
  if (!deviceUnlockAvailable()) throw new Error('仅桌面客户端支持管理本机解锁凭据')
  await request<void>('page_device_password_forget', { scope })
}

async function request<T>(command: string, payload: Record<string, string>): Promise<T> {
  try { return await invoke<T>(command, payload) }
  catch (reason) { throw new Error(typeof reason === 'string' ? reason : '系统凭据库暂时不可用，请使用密码解锁') }
}
