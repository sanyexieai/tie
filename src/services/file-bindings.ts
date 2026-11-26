import { invoke } from '@tauri-apps/api/core'
import { getPlatformAccess } from '@/services/platform-access'
import { normalizeDeviceBindings, type DeviceFileBinding } from '@/services/storage/file-meta'
import type { WorkspaceFileResource } from '@/services/storage/blobs'
import { normalizeRelativePath } from '@/services/link-runtime'

export interface ResourceDeviceIdentity { id: string; name: string; platform: string }

export function portableCopyRelativePath(storedPath: string): string | null {
  if (/^[^/\\]*:/.test(storedPath) || storedPath.includes('\0')) return null
  try { return normalizeRelativePath(storedPath) } catch { return null }
}

export async function currentResourceDevice(): Promise<ResourceDeviceIdentity | null> {
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window || '__TAURI__' in window)) return null
  return invoke<ResourceDeviceIdentity>('get_device_identity')
}

export function fileBindingForDevice(resource: Pick<WorkspaceFileResource, 'deviceBindings'>, device: ResourceDeviceIdentity | null) {
  return device ? normalizeDeviceBindings(resource.deviceBindings)[device.id] : undefined
}

export function bindFileToDevice(
  bindings: unknown,
  device: ResourceDeviceIdentity,
  sourcePath: string,
  boundAt: string,
): Record<string, DeviceFileBinding> {
  const locator = sourcePath.startsWith('content://')
    ? { type: 'android' as const, androidUri: sourcePath, displayPath: sourcePath }
    : { type: 'desktop' as const, desktopPath: sourcePath, displayPath: sourcePath }
  return { ...normalizeDeviceBindings(bindings), [device.id]: {
    deviceId: device.id, deviceName: device.name, platform: device.platform, sourcePath, locator, boundAt,
  } }
}

export async function resolveFileDeviceBinding(resource: WorkspaceFileResource): Promise<WorkspaceFileResource> {
  if (resource.mode === 'copy') return portableCopyRelativePath(resource.storedPath)
    ? { ...resource, bindingState: 'portable' }
    : { ...resource, bindingState: 'portable', openPath: '', exists: false }
  const device = await currentResourceDevice()
  const bindings = normalizeDeviceBindings(resource.deviceBindings)
  const binding = fileBindingForDevice(resource, device)
  if (!binding) return { ...resource, deviceBindings: bindings, openPath: '', exists: false,
    currentDeviceId: device?.id ?? null, bindingState: Object.keys(bindings).length ? 'other-device' : 'unbound' }
  return { ...resource, deviceBindings: bindings, openPath: binding.sourcePath,
    currentDeviceId: device!.id, bindingState: 'bound', exists: await getPlatformAccess().exists(binding.sourcePath) }
}

export function fileBindingUnavailableMessage(resource: WorkspaceFileResource) {
  const devices = Object.values(resource.deviceBindings ?? {}).map((binding) => binding.deviceName || binding.deviceId)
  return resource.bindingState === 'other-device'
    ? `此资源仅在已绑定设备可用：${devices.join('、')}。请选择本机路径绑定，其他设备的绑定会保留。`
    : '此资源尚未绑定本机设备。请选择本机路径绑定后再打开。'
}
