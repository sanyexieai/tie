import { describe, expect, it } from 'vitest'
import {
  compareAppVersions,
  isAppVersionNewer,
  parseUpdateManifest,
  pickPlatformArtifact,
} from '@/services/app-update-manifest'

describe('parseUpdateManifest', () => {
  it('parses tauri latest.json shape', () => {
    const manifest = parseUpdateManifest({
      version: '1.0.9',
      notes: 'fix',
      pub_date: '2026-01-01T00:00:00Z',
      platforms: {
        'linux-x86_64': { url: 'https://example.com/tie.deb', signature: 'sig' },
        'android-aarch64': { url: 'https://example.com/tie.apk', signature: '' },
      },
    })
    expect(manifest?.version).toBe('1.0.9')
    expect(manifest?.platforms['android-aarch64']?.url).toContain('.apk')
  })
})

describe('pickPlatformArtifact', () => {
  it('falls back through candidate platform keys', () => {
    const manifest = parseUpdateManifest({
      version: '1.0.9',
      platforms: {
        'android-universal': { url: 'https://example.com/tie.apk' },
      },
    })
    expect(pickPlatformArtifact(manifest!, ['android-aarch64', 'android-universal'])?.platformKey)
      .toBe('android-universal')
  })
})

describe('compareAppVersions', () => {
  it('compares semver-like versions', () => {
    expect(isAppVersionNewer('1.0.9', '1.0.8')).toBe(true)
    expect(isAppVersionNewer('1.0.8', '1.0.8')).toBe(false)
    expect(compareAppVersions('v1.2.0', '1.10.0')).toBeLessThan(0)
  })
})
