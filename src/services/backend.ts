import type { Page, StorageSource } from '@/types'

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
    throw new Error(error?.message ?? error?.error ?? `后台请求失败（${response.status}）`)
  }
  if (response.status === 204 || body === null) return null as T
  return body as T
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
  async listPages(profile: BackendProfile, workspaceId: string) {
    return request<BackendPagePayload[]>(profile, `/api/v1/workspaces/${workspaceId}/pages`)
  },
  async savePage(profile: BackendProfile, workspaceId: string, page: Page) {
    const saved = await request<BackendPagePayload>(profile, `/api/v1/workspaces/${workspaceId}/pages/${page.id}`, {
      method: 'PUT',
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
