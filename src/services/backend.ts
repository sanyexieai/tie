import type { Page, PageRevision, StorageSource } from '@/types'

export interface BackendUser {
  id: string
  email: string
  name: string
  createdAt: string
}

export interface BackendWorkspace {
  id: string
  name: string
  ownerId: string
  createdAt: string
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

export interface BackendProfile {
  endpoint: string
  accessToken: string | null
  user: BackendUser | null
}

interface AuthResponse {
  accessToken: string
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

const storageKey = 'tie-backend-profile-v1'
export const defaultBackendEndpoint = 'http://127.0.0.1:8787'

function normalizeEndpoint(value: string) {
  const endpoint = value.trim().replace(/\/+$/, '') || defaultBackendEndpoint
  const url = new URL(endpoint)
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('后台地址必须以 http:// 或 https:// 开头')
  return url.toString().replace(/\/$/, '')
}

async function request<T>(profile: BackendProfile, path: string, options: RequestInit = {}) {
  const headers = new Headers(options.headers)
  headers.set('accept', 'application/json')
  if (options.body) headers.set('content-type', 'application/json')
  if (profile.accessToken) headers.set('authorization', `Bearer ${profile.accessToken}`)
  let response: Response
  try {
    response = await fetch(`${normalizeEndpoint(profile.endpoint)}${path}`, { ...options, headers })
  } catch {
    throw new Error('无法连接后台，请检查地址和服务是否已启动')
  }
  const body = await response.json().catch(() => null) as { message?: string; error?: string } | T | null
  if (!response.ok) {
    const error = body as { message?: string; error?: string } | null
    if (response.status === 409) throw new Error('页面已在其他设备更新，请重新载入后再保存')
    throw new Error(error?.message ?? error?.error ?? `后台请求失败（${response.status}）`)
  }
  if (response.status === 204 || body === null) return null as T
  return body as T
}

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
  return { endpoint: defaultBackendEndpoint, accessToken: null, user: null }
}

export const backendService = {
  loadProfile(): BackendProfile {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) ?? '') as Partial<BackendProfile>
      return {
        endpoint: normalizeEndpoint(typeof saved.endpoint === 'string' ? saved.endpoint : defaultBackendEndpoint),
        accessToken: typeof saved.accessToken === 'string' ? saved.accessToken : null,
        user: saved.user && typeof saved.user.id === 'string' ? saved.user as BackendUser : null,
      }
    } catch { return initialProfile() }
  },
  saveProfile(profile: BackendProfile) {
    localStorage.setItem(storageKey, JSON.stringify({ ...profile, endpoint: normalizeEndpoint(profile.endpoint) }))
  },
  clearProfile(endpoint = defaultBackendEndpoint) {
    const profile = { endpoint: normalizeEndpoint(endpoint), accessToken: null, user: null }
    this.saveProfile(profile)
    return profile
  },
  async health(endpoint: string) {
    let response: Response
    try { response = await fetch(`${normalizeEndpoint(endpoint)}/health`) }
    catch { throw new Error('无法连接后台，请检查地址和服务是否已启动') }
    if (!response.ok) throw new Error('后台健康检查失败')
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
  async listWorkspaces(profile: BackendProfile) { return request<BackendWorkspace[]>(profile, '/api/v1/workspaces') },
  async createWorkspace(profile: BackendProfile, name: string) {
    return request<BackendWorkspace>(profile, '/api/v1/workspaces', { method: 'POST', body: JSON.stringify({ name }) })
  },
  async renameWorkspace(profile: BackendProfile, workspaceId: string, name: string) {
    return request<BackendWorkspace>(profile, `/api/v1/workspaces/${workspaceId}`, { method: 'PATCH', body: JSON.stringify({ name }) })
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
