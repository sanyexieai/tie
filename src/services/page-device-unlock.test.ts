import { afterEach, expect, it, vi } from 'vitest'
import { deviceUnlockAvailable, forgetDevicePagePassword, loadDevicePagePassword, saveDevicePagePassword } from './page-device-unlock'

const runtime = vi.hoisted(() => ({ native: false, platform: 'browser', invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: runtime.invoke }))
vi.mock('@/services/platform', () => ({ isTauriDesktop: () => runtime.native, getPlatformType: () => runtime.platform }))

afterEach(() => { runtime.native = false; runtime.platform = 'browser'; runtime.invoke.mockReset(); vi.unstubAllGlobals() })

it('does not load or persist a remembered password in browsers or mobile clients', async () => {
  for (const platform of ['browser', 'android', 'ios']) {
    runtime.platform = platform
    runtime.native = platform !== 'browser'
    expect(deviceUnlockAvailable()).toBe(false)
    expect(await loadDevicePagePassword('fixture-scope')).toBeNull()
    await expect(saveDevicePagePassword('fixture-scope', 'fixture-password')).rejects.toThrow('仅桌面客户端')
    await expect(forgetDevicePagePassword('fixture-scope')).rejects.toThrow('仅桌面客户端')
  }
  expect(runtime.invoke).not.toHaveBeenCalled()
})

it('supports desktop Tauri without the optional OS plugin while rejecting mobile user agents', () => {
  runtime.native = true; runtime.platform = 'unknown'
  vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' })
  expect(deviceUnlockAvailable()).toBe(true)
  vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Linux; Android 15)' })
  expect(deviceUnlockAvailable()).toBe(false)
  vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)' })
  expect(deviceUnlockAvailable()).toBe(false)
})

it('uses only the desktop credential commands for explicit remember and forget operations', async () => {
  runtime.native = true; runtime.platform = 'linux'
  const scope = JSON.stringify(['https://example.test', 'user-a', 'source-a', 'page-a'])
  const password = 'fixture-only-page-password'
  runtime.invoke.mockResolvedValueOnce(null).mockResolvedValueOnce(undefined).mockResolvedValueOnce(password).mockResolvedValueOnce(undefined)
  expect(await loadDevicePagePassword(scope)).toBeNull()
  await saveDevicePagePassword(scope, password)
  expect(await loadDevicePagePassword(scope)).toBe(password)
  await forgetDevicePagePassword(scope)
  expect(runtime.invoke.mock.calls).toEqual([
    ['page_device_password_load', { scope }], ['page_device_password_save', { scope, password }],
    ['page_device_password_load', { scope }], ['page_device_password_forget', { scope }],
  ])
})

it('propagates a credential store failure without treating it as a saved or missing credential', async () => {
  runtime.native = true; runtime.platform = 'windows'
  runtime.invoke.mockRejectedValue('无法读取系统凭据库，请使用密码解锁')
  await expect(loadDevicePagePassword('fixture-scope')).rejects.toThrow('无法读取系统凭据库')
  await expect(saveDevicePagePassword('fixture-scope', 'fixture-password')).rejects.toThrow('无法读取系统凭据库')
})
