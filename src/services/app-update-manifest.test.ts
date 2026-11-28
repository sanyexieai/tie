import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, type RequestListener } from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import {
  compareAppVersions,
  fetchUpdateManifest,
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

describe('fetchUpdateManifest', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('skips endpoints whose manifest lacks the current platform', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          version: '1.0.41',
          platforms: { 'android-aarch64': { url: 'https://example.com/tie.apk' } },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          version: '1.0.40',
          platforms: { 'linux-x86_64': { url: 'https://example.com/tie.deb', signature: 'sig' } },
        }),
      })
    vi.stubGlobal('fetch', fetchMock)

    const manifest = await fetchUpdateManifest(
      ['https://packhub.example/tauri-latest.json', 'https://github.example/latest.json'],
      { platformCandidates: ['linux-x86_64'] },
    )

    expect(manifest.version).toBe('1.0.40')
    expect(manifest.platforms['linux-x86_64']?.url).toContain('.deb')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('aborts a stalled HTTP response and tries the next update source', async () => {
    let slowResponseClosed = false
    await withUpdateServer((request, response) => {
      if (request.url === '/slow') {
        response.on('close', () => { slowResponseClosed = true })
        return
      }
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({
        version: '1.0.70',
        platforms: { 'windows-x86_64': { url: 'https://example.com/tie.exe' } },
      }))
    }, async (baseUrl) => {
      const manifest = await fetchUpdateManifest([`${baseUrl}/slow`, `${baseUrl}/latest.json`], {
        platformCandidates: ['windows-x86_64'],
        timeoutMs: 200,
      })
      expect(manifest.version).toBe('1.0.70')
      expect(slowResponseClosed).toBe(true)
    })
  })

  it('keeps the deadline active while the HTTP response body is stalled', async () => {
    await withUpdateServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.write('{"version":')
    }, async (baseUrl) => {
      await expect(fetchUpdateManifest([`${baseUrl}/latest.json`], { timeoutMs: 200 }))
        .rejects.toThrow('检查更新超时')
    })
  })
})

async function withUpdateServer(handler: RequestListener, run: (baseUrl: string) => Promise<void>) {
  const server = createServer(handler)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    const { port } = server.address() as AddressInfo
    await run(`http://127.0.0.1:${port}`)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    })
  }
}
