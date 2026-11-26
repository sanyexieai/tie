import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { bindFileToDevice, resolveFileDeviceBinding } from './file-bindings'
import { backendWorkspaceBlobStore } from './storage/blobs-remote'
import { backendService } from './backend'
import { normalizeFileMeta, fileMetaToJson, mergeDeviceBindings } from './storage/file-meta'
import { openLocalLink } from './local-links'
import type { WorkspaceFileResource } from './storage/blobs'
const native = vi.hoisted(() => ({ invoke: vi.fn(), openPath: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }))
vi.mock('@tauri-apps/plugin-opener', () => ({ openPath: native.openPath }))
const a = { id: 'dev_a', name: 'Workstation A', platform: 'linux' }
const b = { id: 'dev_b', name: 'Workstation B', platform: 'windows' }
const stamp = '2026-01-01T00:00:00.000Z'
const linked: WorkspaceFileResource = { id: 'file_abcdef123456abcd', title: 'Source', kind: 'directory', mode: 'link', ext: 'dir', mime: 'inode/directory', size: 0,
  sourcePath: '/same/path/source', storedPath: '/same/path/source', openPath: '/same/path/source', exists: true, updatedAt: stamp,
  deviceBindings: bindFileToDevice({}, a, '/same/path/source', stamp) }
beforeEach(() => {
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) })
  vi.stubGlobal('window', Object.assign(new EventTarget(), { __TAURI_INTERNALS__: {} }))
  native.invoke.mockReset()
  native.openPath.mockReset()
  native.invoke.mockImplementation(async (command: string) => {
    if (command === 'get_device_identity') return b
    if (command === 'native_path_exists') return true
    if (command === 'native_path_stat') return { exists: true, isDirectory: true, size: 0 }
    throw new Error(`Unexpected command: ${command}`)
  })
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('does not probe or open a foreign or legacy path even when the same path would exist locally', async () => {
  const foreign = await resolveFileDeviceBinding(linked)
  expect(foreign).toMatchObject({ bindingState: 'other-device', exists: false, openPath: '', currentDeviceId: b.id })
  const legacy = await resolveFileDeviceBinding({ ...linked, deviceBindings: {} })
  expect(legacy).toMatchObject({ bindingState: 'unbound', exists: false, openPath: '' })
  expect(native.invoke.mock.calls.every(([command]) => command === 'get_device_identity')).toBe(true)
  await expect(backendWorkspaceBlobStore.open!({ id: 'backend:ws_test', name: 'Test', kind: 'backend', path: '' }, linked)).rejects.toThrow('已绑定设备')
  expect(native.openPath).not.toHaveBeenCalled()
  await expect(openLocalLink('file:///same/path/source')).rejects.toThrow('尚未绑定设备')
  expect(native.openPath).not.toHaveBeenCalled()
})

it('adds and updates the current device binding without overwriting another device', async () => {
  const both = bindFileToDevice(linked.deviceBindings, b, 'C:\\Source', stamp)
  const rebound = bindFileToDevice(both, b, 'D:\\Source', '2026-01-01T00:00:01Z')
  expect(rebound.dev_a!.sourcePath).toBe('/same/path/source')
  expect(rebound.dev_b!.sourcePath).toBe('D:\\Source')
  const projected = await resolveFileDeviceBinding({ ...linked, deviceBindings: rebound })
  expect(projected).toMatchObject({ bindingState: 'bound', openPath: 'D:\\Source', exists: true })
  expect(native.invoke).toHaveBeenCalledWith('native_path_exists', { path: 'D:\\Source' })
  expect(mergeDeviceBindings(rebound, both)).toEqual(rebound)
})

it('keeps binding metadata through normalization and removes linked content previews', () => {
  const meta = normalizeFileMeta({ ...linked, preview: 'source text must not be uploaded' })
  expect(meta.deviceBindings).toEqual(linked.deviceBindings)
  expect(meta.preview).toBeUndefined()
  expect(fileMetaToJson(meta).deviceBindings).toEqual(linked.deviceBindings)
  expect(fileMetaToJson(meta).preview).toBeUndefined()
})

it('does not bind portable copies to a device', async () => {
  const result = await resolveFileDeviceBinding({ ...linked, mode: 'copy', storedPath: 'legacy/manual.txt', openPath: '/workspace/legacy/manual.txt' })
  expect(result.bindingState).toBe('portable')
  expect(result.exists).toBe(true)
  expect(result.openPath).toBe('/workspace/legacy/manual.txt')
  expect(native.invoke).not.toHaveBeenCalled()
})

it.each(['/outside/source', '../source', 'safe/../../source', 'C:\\Source', 'C:Source', '\\\\server\\share\\source', 'content://provider/document'])('rejects a copy that refers outside its workspace: %s', async (storedPath) => {
  const resource = { ...linked, mode: 'copy', storedPath, openPath: storedPath }
  const result = await resolveFileDeviceBinding(resource)
  expect(result.exists).toBe(false)
  expect(result.openPath).toBe('')
  await expect(backendWorkspaceBlobStore.open!({ id: 'backend:ws_test', name: 'Test', kind: 'backend', path: '' }, resource)).rejects.toThrow('相对路径')
  expect(native.invoke).not.toHaveBeenCalled()
  expect(native.openPath).not.toHaveBeenCalled()
})

it('uses the real HTTP rebind adapter to retain device A when device B selects its own path', async () => {
  vi.spyOn(backendService, 'loadProfile').mockReturnValue({ endpoint: 'https://fixture.test', accessToken: 'fixture', refreshToken: null, accessExpiresAt: null,
    user: { id: 'usr_fixture', name: 'Fixture', email: 'fixture@example.test', createdAt: '' } })
  vi.spyOn(backendService, 'getWorkspaceFile').mockResolvedValue(linked)
  const save = vi.spyOn(backendService, 'upsertWorkspaceFile').mockImplementation(async (_profile, _workspaceId, resource) => resource)
  const source = { id: 'backend:ws_test', name: 'Test', kind: 'backend' as const, path: '' }
  await backendWorkspaceBlobStore.rebind!(source, linked.id, 'C:\\SelectedSource')
  const payload = save.mock.calls[0]![2]
  expect(payload.deviceBindings?.dev_a).toEqual(linked.deviceBindings!.dev_a)
  expect(payload.deviceBindings?.dev_b).toMatchObject({ deviceId: b.id, sourcePath: 'C:\\SelectedSource' })
  expect(native.invoke.mock.calls.some(([command, args]) => command === 'native_path_exists' && args.path === linked.sourcePath)).toBe(false)
})
