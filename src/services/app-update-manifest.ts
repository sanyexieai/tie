export interface UpdatePlatformArtifact {
  url: string
  signature?: string
}

export interface UpdateManifest {
  version: string
  notes?: string | null
  pubDate?: string | null
  platforms: Record<string, UpdatePlatformArtifact>
}

export const ANDROID_PLATFORM_KEYS = [
  'android-aarch64',
  'android-arm64',
  'android-universal',
  'android-armv7',
  'android',
] as const

export function parseVersionParts(version: string): number[] {
  return version
    .trim()
    .replace(/^v/i, '')
    .split(/[.+_-]/)
    .map((part) => Number.parseInt(part, 10))
    .map((part) => (Number.isFinite(part) ? part : 0))
}

export function compareAppVersions(left: string, right: string): number {
  const a = parseVersionParts(left)
  const b = parseVersionParts(right)
  const length = Math.max(a.length, b.length)
  for (let index = 0; index < length; index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0)
    if (diff !== 0) return diff > 0 ? 1 : -1
  }
  return 0
}

export function isAppVersionNewer(candidate: string, current: string): boolean {
  return compareAppVersions(candidate, current) > 0
}

export function pickPlatformArtifact(
  manifest: UpdateManifest,
  candidates: readonly string[],
): (UpdatePlatformArtifact & { platformKey: string }) | null {
  for (const platformKey of candidates) {
    const entry = manifest.platforms[platformKey]
    if (entry?.url?.trim()) {
      return { platformKey, url: entry.url.trim(), signature: entry.signature?.trim() }
    }
  }
  return null
}

export function fileNameFromUpdateUrl(url: string, fallback: string): string {
  try {
    const pathname = new URL(url).pathname
    const base = pathname.split('/').pop()
    if (base?.trim()) return decodeURIComponent(base.trim())
  } catch {
    // ignore
  }
  return fallback
}

export function parseUpdateManifest(raw: unknown): UpdateManifest | null {
  if (!raw || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  if (typeof record.version !== 'string' || !record.version.trim()) return null
  if (!record.platforms || typeof record.platforms !== 'object') return null

  const platforms: Record<string, UpdatePlatformArtifact> = {}
  for (const [platformKey, value] of Object.entries(record.platforms as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue
    const platform = value as Record<string, unknown>
    if (typeof platform.url !== 'string' || !platform.url.trim()) continue
    platforms[platformKey] = {
      url: platform.url.trim(),
      signature: typeof platform.signature === 'string' ? platform.signature.trim() : undefined,
    }
  }
  if (!Object.keys(platforms).length) return null

  return {
    version: record.version.trim(),
    notes: typeof record.notes === 'string' ? record.notes : null,
    pubDate: typeof record.pub_date === 'string'
      ? record.pub_date
      : typeof record.pubDate === 'string'
        ? record.pubDate
        : null,
    platforms,
  }
}

export async function fetchUpdateManifest(endpoints: string[]): Promise<UpdateManifest> {
  let lastError = '无法获取更新清单'
  for (const endpoint of endpoints) {
    try {
      const response = await fetch(endpoint, {
        method: 'GET',
        headers: { Accept: 'application/json' },
      })
      if (!response.ok) {
        lastError = `${endpoint} 返回 HTTP ${response.status}`
        continue
      }
      const manifest = parseUpdateManifest(await response.json())
      if (!manifest) {
        lastError = `${endpoint} 的 latest.json 格式无效`
        continue
      }
      return manifest
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
  }
  throw new Error(lastError)
}

export function resolveDesktopPlatformCandidates(osType: string, osArch: string): string[] {
  const arch = osArch.trim().toLowerCase() || 'x86_64'
  if (osType === 'linux') return [`linux-${arch}`, 'linux-x86_64']
  if (osType === 'windows') return [`windows-${arch}`, 'windows-x86_64']
  if (osType === 'macos') return [`darwin-${arch}`, 'darwin-aarch64', 'darwin-x86_64']
  return []
}
