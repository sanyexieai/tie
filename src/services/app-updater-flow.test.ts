import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  check: vi.fn(),
  manifest: vi.fn(),
  install: vi.fn(),
  relaunch: vi.fn(),
  runtime: 'desktop-release',
  custom: false,
}))

vi.mock('@tauri-apps/plugin-updater', () => ({ check: mocks.check }))
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: mocks.relaunch }))
vi.mock('@tauri-apps/api/app', () => ({ getVersion: async () => '1.0.48' }))
vi.mock('@tauri-apps/plugin-os', () => ({ type: () => 'linux', arch: () => 'x86_64' }))
vi.mock('@/services/platform', () => ({
  isTauriDesktop: () => true,
  isMobileClient: { value: false },
  tieRuntimeKind: () => mocks.runtime,
}))
vi.mock('@/services/app-update-config', async (original) => ({
  ...await original<typeof import('./app-update-config')>(),
  hasCustomUpdateEndpoints: () => mocks.custom,
}))
vi.mock('@/services/app-update-manifest', async (original) => ({
  ...await original<typeof import('./app-update-manifest')>(),
  fetchUpdateManifest: mocks.manifest,
}))

import { appUpdateState, checkForAppUpdate, downloadAndInstallAppUpdate } from './app-updater'
import { APP_UPDATE_CHECK_TIMEOUT_MS } from './app-update-config'

const platforms = {
  'linux-x86_64': { url: 'https://example.com/Tie_1.0.49_amd64.deb', signature: 'signed' },
}

beforeEach(() => {
  vi.resetAllMocks()
  mocks.runtime = 'desktop-release'
  mocks.custom = false
  mocks.manifest.mockResolvedValue({ version: '1.0.49', platforms })
  mocks.check.mockResolvedValue({
    version: '1.0.49', rawJson: { platforms }, downloadAndInstall: mocks.install,
  })
})

describe('desktop update selection', () => {
  it('uses the signed updater even when PackHub has a new release, then installs and relaunches', async () => {
    await checkForAppUpdate()
    expect(mocks.check).toHaveBeenCalledOnce()
    expect(mocks.check).toHaveBeenCalledWith({ timeout: APP_UPDATE_CHECK_TIMEOUT_MS })
    expect(mocks.manifest).not.toHaveBeenCalled()
    expect(appUpdateState.installMode).toBe('auto')
    expect(await downloadAndInstallAppUpdate()).toBe(true)
    expect(mocks.install).toHaveBeenCalledOnce()
    expect(mocks.relaunch).toHaveBeenCalledOnce()
  })

  it('falls back to a manual download when the plugin fails', async () => {
    mocks.check.mockRejectedValue(new Error('network timeout'))
    await checkForAppUpdate()
    expect(appUpdateState.phase).toBe('available')
    expect(appUpdateState.installMode).toBe('manual')
    expect(appUpdateState.availableVersion).toBe('1.0.49')
  })

  it('checks the manifest when the plugin endpoint reports no update', async () => {
    mocks.check.mockResolvedValue(null)
    await checkForAppUpdate()
    expect(mocks.manifest).toHaveBeenCalledOnce()
    expect(appUpdateState.installMode).toBe('manual')
  })

  it('reports up to date only when neither source has an update', async () => {
    mocks.check.mockResolvedValue(null)
    mocks.manifest.mockResolvedValue({ version: '1.0.48', platforms })
    await checkForAppUpdate()
    expect(appUpdateState.phase).toBe('uptodate')
    expect(appUpdateState.installMode).toBeNull()
  })

  it.each(['development', 'custom source'])('keeps manual downloads for %s', async (mode) => {
    if (mode === 'development') mocks.runtime = 'desktop-dev'
    else mocks.custom = true
    await checkForAppUpdate()
    expect(mocks.check).not.toHaveBeenCalled()
    expect(appUpdateState.installMode).toBe('manual')
  })

  it('reports an error if both update checks fail', async () => {
    mocks.check.mockRejectedValue(new Error('network timeout'))
    mocks.manifest.mockRejectedValue(new Error('network timeout'))
    await checkForAppUpdate()
    expect(appUpdateState.phase).toBe('error')
    expect(appUpdateState.error).toContain('网络错误')
  })
})
