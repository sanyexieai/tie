import type { Page, PageRevision, StorageSource } from '@/types'
import { currentChangeOrigin } from '@/services/change-origin'
import type { ReviewEntry, ReviewFile } from '@/services/review-service'
import type { DeviceFileBinding, FileBindingState } from '@/services/storage/file-meta'
import type { PageProtectionBundle } from '@/services/page-protection-types'
import type { BackendSyncManifest } from '@/services/backend-sync'

export interface BackendUser {
  id: string
  email: string
  name: string
  createdAt: string
  managedCloud?: boolean
}

export interface BackendWorkspace {
  id: string
  name: string
  ownerId: string
  createdAt: string
  default?: boolean
  storageProviderId?: string | null
}

export interface BackendStorageSource {
  id: string
  workspaceId: string
  name: string
  kind: 'local_folder' | 'smb' | 's3' | 'cloud' | 'backend'
  publicConfig: Record<string, unknown>
  credentialRef: string | null
  createdAt: string
}

export interface BackendMcpStatus {
  enabled: boolean
  running: boolean
  url: string | null
  error: string | null
  transport?: string
}

export interface BackendMcpToken {
  id: string
  name: string
  workspaceId: string
  createdAt: string
  lastUsedAt: string | null
  canReveal: boolean
}

export interface BackendHealth {
  ok: boolean
  service?: string
  mcp?: BackendMcpStatus
}

export interface BackendProfile {
  endpoint: string
  accessToken: string | null
  refreshToken: string | null
  accessExpiresAt: string | null
  user: BackendUser | null
}
export interface BackendServer {
  id: string
  endpoint: string
  defaultPrompt: boolean
}

interface AuthResponse {
  accessToken: string
  refreshToken?: string
  accessExpiresAt?: string
  tokenType: string
  user: BackendUser
}

export function backendWorkspaceSource(workspace: BackendWorkspace, endpoint: string): StorageSource {
  const base = normalizeEndpoint(endpoint)
  return {
    id: `backend:${workspace.id}`,
    name: workspace.name,
    kind: 'backend',
    path: `${base}/workspaces/${workspace.id}`,
    available: true,
  }
}
export function backendS3ProviderSource(provider: BackendStorageSource, connected = true): StorageSource {
  return {
    id: `backend-s3:${provider.id}`,
    name: provider.name,
    kind: 's3',
    path: `${String(provider.publicConfig.endpoint ?? '')}/${String(provider.publicConfig.bucket ?? '')}`,
    available: connected,
  }
}

export function isBackendManagedS3SourceId(sourceId: string | null | undefined) {
  return Boolean(sourceId?.startsWith('backend-s3:'))
}

export function isBackendRemoteSourceId(sourceId: string | null | undefined) {
  return isBackendSourceId(sourceId) || isBackendManagedS3SourceId(sourceId)
}

export function parseBackendProviderId(sourceId: string) {
  if (!isBackendManagedS3SourceId(sourceId)) throw new Error('不是后台 S3 Provider')
  return sourceId.slice('backend-s3:'.length)
}

export function isBackendSourceId(sourceId: string | null | undefined) {
  return Boolean(sourceId?.startsWith('backend:'))
}

export function parseBackendWorkspaceId(sourceId: string) {
  if (!isBackendSourceId(sourceId)) throw new Error('不是后台存储源')
  return sourceId.slice('backend:'.length)
}

type BackendPagePayload = Omit<Page, 'storageSourceId'>
type BackendFileResource = {
  id: string
  title: string
  kind?: string
  mode: string
  ext: string
  mime: string
  size: number
  sourcePath: string
  storedPath: string
  openPath: string
  exists: boolean
  updatedAt: string
  deviceBindings?: Record<string, DeviceFileBinding>
  bindingState?: FileBindingState
  currentDeviceId?: string | null
}

const storageKey = 'tie-backend-profile-v1'
const serversKey = 'tie-backend-servers-v1'
const workspaceMappingsKey = 'tie-backend-workspace-mappings-v1'
const defaultPromptDismissedKey = 'tie-backend-default-prompt-dismissed-v1'
export const defaultBackendEndpoint = 'https://3ye.co:32043'
export const localBackendEndpoint = 'http://127.0.0.1:8787'
const defaultEndpointMigratedKey = 'tie-backend-default-endpoint-migrated-v1'

// 只把内置的 default-local 从旧的本机地址迁到已发布服务器，而且只迁一次。
// 之后用户再选本机后台，或已经登录在本机，都保持原地址。
function migrateBuiltInDefault(servers: BackendServer[]) {
  if (localStorage.getItem(defaultEndpointMigratedKey) === '1') return servers
  localStorage.setItem(defaultEndpointMigratedKey, '1')
  return servers.map((server) => {
    if (server.id !== 'default-local') return server
    if (server.endpoint.replace(/\/+$/, '') !== localBackendEndpoint) return server
    return { ...server, endpoint: defaultBackendEndpoint, defaultPrompt: true }
  })
}

function normalizeEndpoint(value: string) {
  const endpoint = value.trim().replace(/\/+$/, '') || defaultBackendEndpoint
  const url = new URL(endpoint)
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('后台地址必须以 http:// 或 https:// 开头')
  return url.toString().replace(/\/$/, '')
}

async function refreshProfile(profile: BackendProfile, force: boolean) {
  return backendService.refresh(profile, force)
}

export async function fetchBackendJsonWithTimeout<T>(url: string, options: RequestInit = {}): Promise<{ response: Response; body: T | null }> {
  const callerSignal = options.signal
  if (callerSignal?.aborted) throw callerSignal.reason ?? new DOMException('请求已取消', 'AbortError')
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout>
  let abortFromCaller: () => void
  const interrupted = new Promise<never>((_, reject) => {
    abortFromCaller = () => {
      const reason = callerSignal?.reason ?? new DOMException('请求已取消', 'AbortError')
      reject(reason)
      controller.abort(reason)
    }
    callerSignal?.addEventListener('abort', abortFromCaller, { once: true })
    timer = setTimeout(() => {
      const reason = new BackendRequestError('后台响应超时，请稍后重试', 0)
      reject(reason)
      controller.abort(reason)
    }, 10_000)
  })
  try {
    return await Promise.race([
      (async () => {
        const response = await fetch(url, { ...options, signal: controller.signal })
        const body = await response.json().catch((reason) => {
          if (controller.signal.aborted) throw reason
          return null
        }) as T | null
        return { response, body }
      })(),
      interrupted,
    ])
  } finally {
    clearTimeout(timer!)
    callerSignal?.removeEventListener('abort', abortFromCaller!)
  }
}

async function request<T>(profile: BackendProfile, path: string, options: RequestInit = {}, allowRefresh = true): Promise<T> {
  const headers = new Headers(options.headers)
  if (options.method && !['GET', 'HEAD'].includes(options.method.toUpperCase())) {
    headers.set('x-tie-origin', encodeURIComponent(JSON.stringify(await currentChangeOrigin(profile.user?.name))))
  }
  headers.set('accept', 'application/json')
  if (options.body) headers.set('content-type', 'application/json')
  if (profile.accessToken) headers.set('authorization', `Bearer ${profile.accessToken}`)
  let response: Response
  let body: { message?: string; error?: string } | T | null
  try {
    const url = `${normalizeEndpoint(profile.endpoint)}${path}`
    if ((options.method ?? 'GET').toUpperCase() === 'GET') {
      const result = await fetchBackendJsonWithTimeout<{ message?: string; error?: string } | T>(url, { ...options, headers })
      response = result.response
      body = result.body
    } else {
      response = await fetch(url, { ...options, headers })
      body = await response.json().catch(() => null) as { message?: string; error?: string } | T | null
    }
  } catch (reason) {
    if (reason instanceof BackendRequestError) throw reason
    throw new BackendRequestError('无法连接后台，请检查地址和服务是否已启动', 0)
  }
  if (response.status === 401 && allowRefresh && profile.refreshToken && path !== '/api/v1/auth/refresh') {
    await refreshProfile(profile, true)
    return request<T>(profile, path, options, false)
  }
  if (response.status === 304) return null as T
  if (!response.ok) {
    const error = body as { message?: string; error?: string } | null
    if (response.status === 409) throw new BackendRequestError('页面已在其他设备更新，请重新载入后再保存', 409)
    throw new BackendRequestError(error?.message ?? error?.error ?? `后台请求失败（${response.status}）`, response.status)
  }
  if (response.status === 204 || body === null) return null as T
  return body as T
}

export { request as backendRequest }

async function uploadBinary(profile: BackendProfile, path: string, data: Uint8Array) {
  const headers = new Headers()
  headers.set('content-type', 'application/octet-stream')
  if (profile.accessToken) headers.set('authorization', `Bearer ${profile.accessToken}`)
  let response: Response
  try {
    response = await fetch(`${normalizeEndpoint(profile.endpoint)}${path}`, {
      method: 'PUT',
      headers,
      body: new Blob([new Uint8Array(data)]),
    })
  } catch {
    throw new Error('无法连接后台，请检查地址和服务是否已启动')
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { message?: string } | null
    throw new Error(body?.message ?? `后台请求失败（${response.status}）`)
  }
}

async function readBinary(profile: BackendProfile, path: string) {
  const headers = new Headers()
  if (profile.accessToken) headers.set('authorization', `Bearer ${profile.accessToken}`)
  let response: Response
  try {
    response = await fetch(`${normalizeEndpoint(profile.endpoint)}${path}`, { headers })
  } catch {
    throw new Error('无法连接后台，请检查地址和服务是否已启动')
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { message?: string } | null
    throw new Error(body?.message ?? `后台请求失败（${response.status}）`)
  }
  return response.arrayBuffer()
}

function initialProfile(): BackendProfile {
  return { endpoint: defaultBackendEndpoint, accessToken: null, refreshToken: null, accessExpiresAt: null, user: null }
}

function isDesktop() {
  return typeof window !== 'undefined' && ('__TAURI_INTERNALS__' in window || '__TAURI__' in window)
}

export class BackendRequestError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

function readBrowserProfile(): BackendProfile {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) ?? '') as Partial<BackendProfile>
    return {
      endpoint: normalizeEndpoint(typeof saved.endpoint === 'string' ? saved.endpoint : defaultBackendEndpoint),
      accessToken: typeof saved.accessToken === 'string' ? saved.accessToken : null,
      refreshToken: typeof saved.refreshToken === 'string' ? saved.refreshToken : null,
      accessExpiresAt: typeof saved.accessExpiresAt === 'string' ? saved.accessExpiresAt : null,
      user: saved.user && typeof saved.user.id === 'string' ? saved.user as BackendUser : null,
    }
  } catch { return initialProfile() }
}

function dueForRefresh(profile: BackendProfile) {
  if (!profile.refreshToken || !profile.accessExpiresAt) return false
  return Date.parse(profile.accessExpiresAt) - Date.now() <= 120_000
}

interface StoredSession {
  endpoint?: string
  accessToken?: string
  refreshToken?: string
  accessExpiresAt?: string
  userId?: string
  email?: string
  name?: string
}

function profileFromSession(session: StoredSession, fallbackEndpoint: string): BackendProfile {
  const user = session.userId
    ? { id: session.userId, email: session.email || '', name: session.name || '', createdAt: '' }
    : null
  return {
    endpoint: normalizeEndpoint(session.endpoint || fallbackEndpoint),
    accessToken: session.accessToken || null,
    refreshToken: session.refreshToken || null,
    accessExpiresAt: session.accessExpiresAt || null,
    user,
  }
}

export const backendService = {
  loadWorkspaceMappings(): Record<string, string> {
    try {
      const value = JSON.parse(localStorage.getItem(workspaceMappingsKey) ?? '{}')
      return value && typeof value === 'object' ? value as Record<string, string> : {}
    } catch { return {} }
  },
  saveWorkspaceMappings(mappings: Record<string, string>) {
    localStorage.setItem(workspaceMappingsKey, JSON.stringify(mappings))
  },
  workspaceMapping(localSourceId: string) {
    return this.loadWorkspaceMappings()[localSourceId] ?? null
  },
  mapWorkspace(localSourceId: string, workspaceId: string) {
    const mappings = this.loadWorkspaceMappings()
    mappings[localSourceId] = workspaceId
    this.saveWorkspaceMappings(mappings)
  },
  loadServers(): BackendServer[] {
    try {
      const list = JSON.parse(localStorage.getItem(serversKey) ?? '[]') as BackendServer[]
      const servers = Array.isArray(list) ? list.filter((s) => s && typeof s.id === 'string' && typeof s.endpoint === 'string') : []
      if (servers.length) {
        const migrated = migrateBuiltInDefault(servers)
        if (migrated.some((server, index) => server.endpoint !== servers[index]?.endpoint || server.defaultPrompt !== servers[index]?.defaultPrompt)) this.saveServers(migrated)
        return migrated
      }
      const profile = JSON.parse(localStorage.getItem(storageKey) ?? 'null') as Partial<BackendProfile> | null
      if (typeof profile?.endpoint === 'string' && profile.endpoint.trim()) return [{ id: 'migrated-default', endpoint: normalizeEndpoint(profile.endpoint), defaultPrompt: false }]
      return [{ id: 'default-local', endpoint: defaultBackendEndpoint, defaultPrompt: true }]
    } catch { return [] }
  },
  saveServers(servers: BackendServer[]) { localStorage.setItem(serversKey, JSON.stringify(servers)) },
  addServer(endpoint: string) {
    const normalized = normalizeEndpoint(endpoint); const servers = this.loadServers(); const found = servers.find((s) => s.endpoint === normalized)
    if (found) return found
    const server = { id: globalThis.crypto?.randomUUID?.() ?? `server-${Date.now()}`, endpoint: normalized, defaultPrompt: false }; this.saveServers([...servers, server]); return server
  },
  updateServer(id: string, endpoint: string) {
    const normalized = normalizeEndpoint(endpoint)
    const servers = this.loadServers()
    if (!servers.some((server) => server.id === id)) throw new Error('后台服务器不存在')
    const duplicate = servers.find((server) => server.id !== id && server.endpoint === normalized)
    if (duplicate) throw new Error('该后台地址已经存在')
    const updated = servers.map((server) => server.id === id ? { ...server, endpoint: normalized } : server)
    this.saveServers(updated)
    return updated.find((server) => server.id === id)!
  },
  removeServer(id: string) { this.saveServers(this.loadServers().filter((s) => s.id !== id)) },
  setDefaultPrompt(id: string, enabled: boolean) { this.saveServers(this.loadServers().map((s) => ({ ...s, defaultPrompt: enabled ? s.id === id : s.id === id ? false : s.defaultPrompt }))) },
  isDefaultPromptDismissed() { return localStorage.getItem(defaultPromptDismissedKey) === '1' },
  dismissDefaultPrompt() { localStorage.setItem(defaultPromptDismissedKey, '1') },
  clearDefaultPromptDismissal() { localStorage.removeItem(defaultPromptDismissedKey) },
  loadProfile(): BackendProfile {
    if (isDesktop()) return initialProfile()
    return readBrowserProfile()
  },
  saveProfile(profile: BackendProfile) {
    if (isDesktop()) {
      localStorage.removeItem(storageKey)
      return
    }
    localStorage.setItem(storageKey, JSON.stringify({ ...profile, endpoint: normalizeEndpoint(profile.endpoint) }))
  },
  async readSession(): Promise<BackendProfile> {
    const browser = readBrowserProfile()
    if (!isDesktop()) return browser
    const { invoke } = await import('@tauri-apps/api/core')
    const session = await invoke<StoredSession | null>('load_backend_session')
    if (session?.accessToken) {
      localStorage.removeItem(storageKey)
      return profileFromSession(session, browser.endpoint)
    }
    if (browser.accessToken && browser.user) {
      await this.publishSession(browser)
      localStorage.removeItem(storageKey)
      return browser
    }
    return { ...initialProfile(), endpoint: browser.endpoint }
  },
  async publishSession(profile: BackendProfile) {
    if (!isDesktop()) {
      this.saveProfile(profile)
      return
    }
    const { invoke } = await import('@tauri-apps/api/core')
    localStorage.removeItem(storageKey)
    if (!profile.accessToken || !profile.user) {
      await invoke('clear_backend_session')
      return
    }
    await invoke('save_backend_session', {
      endpoint: normalizeEndpoint(profile.endpoint),
      accessToken: profile.accessToken,
      refreshToken: profile.refreshToken,
      accessExpiresAt: profile.accessExpiresAt,
      userId: profile.user.id,
      email: profile.user.email,
      name: profile.user.name,
    })
  },
  async refresh(profile: BackendProfile, force = false) {
    if (!force && !dueForRefresh(profile)) return profile
    if (isDesktop()) {
      const { invoke } = await import('@tauri-apps/api/core')
      try {
        const session = await invoke<StoredSession>('refresh_backend_session', { force })
        const next = profileFromSession(session, profile.endpoint)
        profile.endpoint = next.endpoint
        profile.accessToken = next.accessToken
        profile.refreshToken = next.refreshToken
        profile.accessExpiresAt = next.accessExpiresAt
        if (next.user) profile.user = { ...profile.user, ...next.user, createdAt: profile.user?.createdAt || '' }
        return profile
      } catch (error) {
        const message = error instanceof Error ? error.message : '登录已失效，请重新登录'
        if (message.includes('登录已失效') || message.includes('尚未登录')) {
          throw new BackendRequestError(message, 401)
        }
        return profile
      }
    }
    if (!profile.refreshToken) return profile
    const response = await fetch(`${normalizeEndpoint(profile.endpoint)}/api/v1/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ refreshToken: profile.refreshToken }),
    })
    if (response.status === 401 || response.status === 403) {
      throw new BackendRequestError('登录已失效，请重新登录', response.status)
    }
    if (!response.ok) return profile
    const body = await response.json() as AuthResponse
    profile.accessToken = body.accessToken
    profile.refreshToken = body.refreshToken || profile.refreshToken
    profile.accessExpiresAt = body.accessExpiresAt || profile.accessExpiresAt
    if (body.user) profile.user = body.user
    this.saveProfile(profile)
    return profile
  },
  clearProfile(endpoint = defaultBackendEndpoint) {
    const profile = { ...initialProfile(), endpoint: normalizeEndpoint(endpoint) }
    if (!isDesktop()) this.saveProfile(profile)
    else localStorage.removeItem(storageKey)
    return profile
  },
  async health(endpoint: string): Promise<BackendHealth> {
    let response: Response
    let body: BackendHealth | null
    try { ({ response, body } = await fetchBackendJsonWithTimeout<BackendHealth>(`${normalizeEndpoint(endpoint)}/health`)) }
    catch (reason) {
      if (reason instanceof BackendRequestError) throw reason
      throw new Error('无法连接后台，请检查地址和服务是否已启动')
    }
    if (!response.ok) throw new Error('后台健康检查失败')
    if (!body) throw new Error('后台健康检查返回了空响应')
    return body
  },
  async register(endpoint: string, email: string, password: string, name: string) {
    const profile = { ...initialProfile(), endpoint: normalizeEndpoint(endpoint) }
    return request<AuthResponse>(profile, '/api/v1/auth/register', { method: 'POST', body: JSON.stringify({ email, password, name }) })
  },
  async login(endpoint: string, email: string, password: string) {
    const profile = { ...initialProfile(), endpoint: normalizeEndpoint(endpoint) }
    return request<AuthResponse>(profile, '/api/v1/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) })
  },
  async me(profile: BackendProfile) { return request<BackendUser>(profile, '/api/v1/me') },
  async listMcpTokens(profile: BackendProfile) {
    return request<BackendMcpToken[]>(profile, '/api/v1/me/mcp-tokens', { cache: 'no-store' })
  },
  async createMcpToken(profile: BackendProfile, input: { name: string; workspaceId: string }) {
    const created = await request<{ record: BackendMcpToken }>(profile, '/api/v1/me/mcp-tokens', {
      method: 'POST', body: JSON.stringify({ ...input, reveal: false }),
    })
    return created.record
  },
  async revokeMcpToken(profile: BackendProfile, tokenId: string) {
    await request<null>(profile, `/api/v1/me/mcp-tokens/${encodeURIComponent(tokenId)}`, { method: 'DELETE' })
  },
  async listWorkspaces(profile: BackendProfile) { return request<BackendWorkspace[]>(profile, '/api/v1/workspaces') },
  async createWorkspace(profile: BackendProfile, name: string) {
    return request<BackendWorkspace>(profile, '/api/v1/workspaces', { method: 'POST', body: JSON.stringify({ name }) })
  },
  async renameWorkspace(profile: BackendProfile, workspaceId: string, name: string) {
    return request<BackendWorkspace>(profile, `/api/v1/workspaces/${workspaceId}`, { method: 'PATCH', body: JSON.stringify({ name }) })
  },
  async updateWorkspace(
    profile: BackendProfile,
    workspaceId: string,
    input: { name?: string; storageProviderId?: string | null },
  ) {
    return request<BackendWorkspace>(profile, `/api/v1/workspaces/${workspaceId}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    })
  },
  async deleteWorkspace(profile: BackendProfile, workspaceId: string) {
    await request<null>(profile, `/api/v1/workspaces/${workspaceId}`, { method: 'DELETE' })
  },
  async checkProviderHealth(profile: BackendProfile, providerId: string) {
    await request<{ ok: boolean }>(profile, `/api/v1/providers/${providerId}/health`)
    return true
  },
  async createProvider(profile: BackendProfile, source: { name: string; kind: BackendStorageSource['kind']; publicConfig: Record<string, unknown>; credentials?: Record<string, string> }) {
    return request<BackendStorageSource>(profile, '/api/v1/providers', { method: 'POST', body: JSON.stringify(source) })
  },
  async renameProvider(profile: BackendProfile, providerId: string, name: string) {
    return request<BackendStorageSource>(profile, `/api/v1/providers/${providerId}`, { method: 'PATCH', body: JSON.stringify({ name }) })
  },
  async updateProvider(profile: BackendProfile, providerId: string, input: { name?: string; publicConfig?: Record<string, unknown>; credentials?: Record<string, string> }) {
    return request<BackendStorageSource>(profile, `/api/v1/providers/${providerId}`, { method: 'PATCH', body: JSON.stringify(input) })
  },
  async deleteProvider(profile: BackendProfile, providerId: string) {
    await request<null>(profile, `/api/v1/providers/${providerId}`, { method: 'DELETE' })
  },
  async listProviders(profile: BackendProfile) {
    return request<BackendStorageSource[]>(profile, '/api/v1/providers')
  },
  async listProviderPages(profile: BackendProfile, providerId: string) {
    return request<BackendPagePayload[]>(profile, `/api/v1/providers/${providerId}/pages`)
  },
  async getProviderPage(profile: BackendProfile, providerId: string, pageId: string) {
    return request<BackendPagePayload>(profile, `/api/v1/providers/${providerId}/pages/${pageId}`)
  },
  async saveProviderPage(profile: BackendProfile, providerId: string, page: Page, expectedUpdatedAt?: string) {
    const saved = await request<BackendPagePayload>(profile, `/api/v1/providers/${providerId}/pages/${page.id}`, {
      method: 'PUT',
      headers: expectedUpdatedAt ? { 'if-unmodified-since': expectedUpdatedAt } : undefined,
      body: JSON.stringify({ ...page, storageSourceId: page.storageSourceId }),
    })
    return { ...saved, storageSourceId: page.storageSourceId }
  },
  async deleteProviderPages(profile: BackendProfile, providerId: string, pageIds: string[]) {
    await request<null>(profile, `/api/v1/providers/${providerId}/pages`, {
      method: 'POST',
      body: JSON.stringify({ pageIds }),
    })
  },
  async listProviderPageRevisions(profile: BackendProfile, providerId: string, pageId: string) {
    return request<PageRevision[]>(profile, `/api/v1/providers/${providerId}/pages/${pageId}/revisions`)
  },
  async readProviderPageRevision(profile: BackendProfile, providerId: string, pageId: string, revisionId: string) {
    return request<BackendPagePayload>(profile, `/api/v1/providers/${providerId}/pages/${pageId}/revisions/${revisionId}`)
  },
  async loadAllProviderPages(profile: BackendProfile, sourceIdFor: (providerId: string) => string) {
    if (!profile.accessToken) return [] as Page[]
    const providers = await this.listProviders(profile).catch(() => [])
    const pages: Page[] = []
    for (const provider of providers.filter((item) => item.kind === 's3')) {
      const sourceId = sourceIdFor(provider.id)
      const providerPages = await this.listProviderPages(profile, provider.id).catch(() => [])
      pages.push(...providerPages.map((page) => ({ ...page, storageSourceId: sourceId })))
    }
    return pages
  },
  async listLegacyStorageSources(profile: BackendProfile, workspaceId: string) {
    return request<BackendStorageSource[]>(profile, `/api/v1/workspaces/${workspaceId}/sources`)
  },
  async listPages(profile: BackendProfile, workspaceId: string) {
    return request<BackendPagePayload[]>(profile, `/api/v1/workspaces/${workspaceId}/pages`)
  },
  async syncManifest(profile: BackendProfile, workspaceId: string, revision?: string) {
    const query = revision ? `?revision=${encodeURIComponent(revision)}` : ''
    const manifest = await request<BackendSyncManifest | null>(profile, `/api/v1/workspaces/${workspaceId}/sync/manifest${query}`, { cache: 'no-store' }).catch((reason) => {
      if (reason instanceof BackendRequestError && reason.status === 404) reason.message = '后台不支持增量同步，请先更新后台'
      throw reason
    })
    if (manifest === null) return null
    if (manifest.version !== 1 || typeof manifest.revision !== 'string'
      || ![manifest.pages, manifest.reviews, manifest.assets, manifest.files].every((entries) => Array.isArray(entries)
        && entries.every((entry) => typeof entry?.id === 'string' && typeof entry?.version === 'string'))) {
      throw new BackendRequestError('服务器返回的增量同步清单无效，请更新后台', 502)
    }
    return manifest
  },
  async getPage(profile: BackendProfile, workspaceId: string, pageId: string) {
    return request<BackendPagePayload>(profile, `/api/v1/workspaces/${workspaceId}/pages/${pageId}`)
  },
  async savePage(profile: BackendProfile, workspaceId: string, page: Page, expectedUpdatedAt?: string) {
    const saved = await request<BackendPagePayload>(profile, `/api/v1/workspaces/${workspaceId}/pages/${page.id}`, {
      method: 'PUT',
      headers: expectedUpdatedAt ? { 'if-unmodified-since': expectedUpdatedAt } : undefined,
      body: JSON.stringify({ ...page, storageSourceId: page.storageSourceId }),
    })
    return { ...saved, storageSourceId: page.storageSourceId }
  },
  async deletePages(profile: BackendProfile, workspaceId: string, pageIds: string[]) {
    await request<null>(profile, `/api/v1/workspaces/${workspaceId}/pages`, {
      method: 'POST',
      body: JSON.stringify({ pageIds }),
    })
  },
  async listPageRevisions(profile: BackendProfile, workspaceId: string, pageId: string) {
    return request<PageRevision[]>(profile, `/api/v1/workspaces/${workspaceId}/pages/${pageId}/revisions`)
  },
  async readPageProtection(profile: BackendProfile, workspaceId: string, pageId: string) {
    return request<PageProtectionBundle>(profile, `/api/v1/workspaces/${workspaceId}/pages/${pageId}/protection`)
  },
  async replacePageProtection(profile: BackendProfile, workspaceId: string, bundle: PageProtectionBundle, expectedUpdatedAt: string) {
    return request<Page>(profile, `/api/v1/workspaces/${workspaceId}/pages/${bundle.page.id}/protection`, {
      method: 'PUT', body: JSON.stringify({ bundle, expectedUpdatedAt }),
    })
  },
  async listPageReviews(profile: BackendProfile, workspaceId: string, pageId: string) {
    return request<ReviewFile>(profile, `/api/v1/workspaces/${workspaceId}/pages/${pageId}/reviews`)
  },
  async savePageReviews(profile: BackendProfile, workspaceId: string, pageId: string, entries: ReviewEntry[]) {
    return request<ReviewFile>(profile, `/api/v1/workspaces/${workspaceId}/pages/${pageId}/reviews`, {
      method: 'PUT', body: JSON.stringify({ entries }),
    })
  },
  async addPageSignal(profile: BackendProfile, workspaceId: string, pageId: string, input: {
    id?: string; actor?: string; opinionKind: string; quote?: string; body: string; baseUpdatedAt?: string; replyTo?: string | null
  }) {
    return request<ReviewFile>(profile, `/api/v1/workspaces/${workspaceId}/pages/${pageId}/signals`, { method: 'POST', body: JSON.stringify(input) })
  },
  async resolvePageSignal(profile: BackendProfile, workspaceId: string, pageId: string, id: string, input: {
    status: 'resolved' | 'adopted' | 'withdrawn'; resolutionNote?: string; appliedUpdatedAt?: string
  }) {
    return request<ReviewFile>(profile, `/api/v1/workspaces/${workspaceId}/pages/${pageId}/signals/${encodeURIComponent(id)}/resolve`, { method: 'POST', body: JSON.stringify(input) })
  },
  async readPageRevision(profile: BackendProfile, workspaceId: string, pageId: string, revisionId: string) {
    return request<BackendPagePayload>(profile, `/api/v1/workspaces/${workspaceId}/pages/${pageId}/revisions/${revisionId}`)
  },
  async uploadWorkspacePageAsset(profile: BackendProfile, workspaceId: string, pageId: string, assetName: string, data: Uint8Array) {
    await uploadBinary(profile, `/api/v1/workspaces/${workspaceId}/pages/${pageId}/assets/${encodeURIComponent(assetName)}`, data)
    return assetName
  },
  async readWorkspacePageAsset(profile: BackendProfile, workspaceId: string, pageId: string, assetName: string) {
    return readBinary(profile, `/api/v1/workspaces/${workspaceId}/pages/${pageId}/assets/${encodeURIComponent(assetName)}`)
  },
  async listWorkspacePageAssets(profile: BackendProfile, workspaceId: string, pageId: string) {
    const result = await request<{ assets: string[] }>(profile, `/api/v1/workspaces/${workspaceId}/pages/${pageId}/assets`)
    return result.assets ?? []
  },
  async listWorkspaceFiles(profile: BackendProfile, workspaceId: string) {
    const result = await request<{ files: BackendFileResource[] }>(profile, `/api/v1/workspaces/${workspaceId}/files`)
    return result.files ?? []
  },
  async getWorkspaceFile(profile: BackendProfile, workspaceId: string, fileId: string) {
    return request<BackendFileResource>(profile, `/api/v1/workspaces/${workspaceId}/files/${encodeURIComponent(fileId)}`)
  },
  async upsertWorkspaceFile(profile: BackendProfile, workspaceId: string, file: BackendFileResource) {
    return request<BackendFileResource>(profile, `/api/v1/workspaces/${workspaceId}/files/${encodeURIComponent(file.id)}`, {
      method: 'PUT',
      body: JSON.stringify(file),
    })
  },
  async uploadWorkspaceFileBlob(profile: BackendProfile, workspaceId: string, fileId: string, blobName: string, data: Uint8Array) {
    await uploadBinary(profile, `/api/v1/workspaces/${workspaceId}/files/${encodeURIComponent(fileId)}/blob/${encodeURIComponent(blobName)}`, data)
    return blobName
  },
  async readWorkspaceFileBlob(profile: BackendProfile, workspaceId: string, fileId: string) {
    return readBinary(profile, `/api/v1/workspaces/${workspaceId}/files/${encodeURIComponent(fileId)}/blob`)
  },
  async listProviderFiles(profile: BackendProfile, providerId: string) {
    const result = await request<{ files: BackendFileResource[] }>(profile, `/api/v1/providers/${providerId}/files`)
    return result.files ?? []
  },
  async getProviderFile(profile: BackendProfile, providerId: string, fileId: string) {
    return request<BackendFileResource>(profile, `/api/v1/providers/${providerId}/files/${encodeURIComponent(fileId)}`)
  },
  async upsertProviderFile(profile: BackendProfile, providerId: string, file: BackendFileResource) {
    return request<BackendFileResource>(profile, `/api/v1/providers/${providerId}/files/${encodeURIComponent(file.id)}`, {
      method: 'PUT',
      body: JSON.stringify(file),
    })
  },
  async uploadProviderFileBlob(profile: BackendProfile, providerId: string, fileId: string, blobName: string, data: Uint8Array) {
    const signed = await request<{ url: string }>(profile, `/api/v1/providers/${providerId}/files/${encodeURIComponent(fileId)}/blob-url/${encodeURIComponent(blobName)}`)
    const response = await fetch(signed.url, { method: 'PUT', body: new Blob([new Uint8Array(data)]) })
    if (!response.ok) throw new Error(`S3 上传失败（${response.status}）`)
    return blobName
  },
  async readProviderFileBlob(profile: BackendProfile, providerId: string, fileId: string) {
    const signed = await request<{ url: string }>(profile, `/api/v1/providers/${providerId}/files/${encodeURIComponent(fileId)}/blob-url`)
    const response = await fetch(signed.url)
    if (!response.ok) throw new Error(`S3 读取失败（${response.status}）`)
    return response.arrayBuffer()
  },
  async uploadProviderPageAsset(profile: BackendProfile, providerId: string, pageId: string, assetName: string, data: Uint8Array) {
    await uploadBinary(profile, `/api/v1/providers/${providerId}/pages/${pageId}/assets/${encodeURIComponent(assetName)}`, data)
    return assetName
  },
  async readProviderPageAsset(profile: BackendProfile, providerId: string, pageId: string, assetName: string) {
    return readBinary(profile, `/api/v1/providers/${providerId}/pages/${pageId}/assets/${encodeURIComponent(assetName)}`)
  },
  async listProviderPageAssets(profile: BackendProfile, providerId: string, pageId: string) {
    const result = await request<{ assets: string[] }>(profile, `/api/v1/providers/${providerId}/pages/${pageId}/assets`)
    return result.assets ?? []
  },
  async loadAllPages(profile: BackendProfile, sourceIdFor: (workspaceId: string) => string) {
    if (!profile.accessToken) return [] as Page[]
    const workspaces = await this.listWorkspaces(profile).catch(() => [])
    const pages: Page[] = []
    for (const workspace of workspaces) {
      const sourceId = sourceIdFor(workspace.id)
      const workspacePages = await this.listPages(profile, workspace.id).catch(() => [])
      pages.push(...workspacePages.map((page) => ({ ...page, storageSourceId: sourceId })))
    }
    return pages
  },
}
