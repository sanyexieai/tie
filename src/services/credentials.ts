import { backendRequest, type BackendMcpToken } from '@/services/backend'
import { currentBackendProfile } from '@/services/backend-profile'

export interface CredentialTarget {
  url: string
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD'
  authType: 'bearer' | 'header' | 'basic'
  headerName?: string
  username?: string
  body?: string
  responseFields?: string[]
}

export interface CredentialMetadata {
  id: string
  secretRef: string
  workspaceId: string
  ownerId?: string
  name: string
  description: string
  service: string
  environment: string
  tags: string[]
  version: number
  createdAt: string
  updatedAt: string
  action: { method: string; origin: string } | null
}

export interface CredentialDetail extends CredentialMetadata { target: CredentialTarget | null }
export interface CredentialInput {
  workspaceId?: string
  name: string
  value?: string
  description?: string
  service?: string
  environment?: string
  tags?: string[]
  target?: CredentialTarget | null
}
export interface CredentialPrincipal { type: 'session' | 'mcp-token'; id: string }
export interface CredentialGrant {
  id: string
  secretRef: string
  workspaceId: string
  principal: CredentialPrincipal
  version: number
  expiresAt: string
  maxUses: 1 | null
  useCount: number
  revokedAt: string | null
  createdAt: string
}
export interface CredentialUsage {
  id: string
  at: string
  status: 'started' | 'succeeded' | 'failed' | 'denied'
  principal: CredentialPrincipal | null
  secretRef: string | null
  httpStatus?: number
  reason?: string
  action?: { method: string; origin: string } | null
  version?: number
  grantId?: string
}
export interface CredentialSession { id: string; expiresAt: string; current: boolean }

export function credentialAccountKey() {
  const profile = currentBackendProfile()
  return JSON.stringify([profile.endpoint.replace(/\/$/, ''), profile.user?.id ?? '', Boolean(profile.accessToken)])
}

function request<T>(path: string, options: RequestInit = {}) {
  const profile = currentBackendProfile()
  if (!profile.accessToken || !profile.user) throw new Error('请先登录服务器后使用凭据页面')
  return backendRequest<T>(profile, `/api/v1/me${path}`, { ...options, cache: 'no-store' })
}

export const credentialsService = {
  list(workspaceId: string, query = '') {
    return request<CredentialMetadata[]>(`/secrets?${new URLSearchParams({ workspaceId, query, limit: '100' })}`)
  },
  get(id: string) { return request<CredentialDetail>(`/secrets/${encodeURIComponent(id)}`) },
  create(input: CredentialInput & { workspaceId: string; value: string }) {
    return request<CredentialMetadata>('/secrets', { method: 'POST', body: JSON.stringify(input) })
  },
  update(id: string, input: CredentialInput) {
    return request<CredentialMetadata>(`/secrets/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(input) })
  },
  remove(id: string) { return request<null>(`/secrets/${encodeURIComponent(id)}`, { method: 'DELETE' }) },
  async reveal(id: string) { return (await request<{ value: string }>(`/secrets/${encodeURIComponent(id)}/value`)).value },
  listGrants(workspaceId: string, secretRef: string) {
    return request<CredentialGrant[]>(`/secret-grants?${new URLSearchParams({ workspaceId, secretRef })}`)
  },
  listUsage(workspaceId: string, secretRef: string) {
    return request<CredentialUsage[]>(`/secret-usage?${new URLSearchParams({ workspaceId, secretRef, limit: '50' })}`)
  },
  listSessions() { return request<CredentialSession[]>('/secret-sessions') },
  listTokens(workspaceId: string) {
    return request<BackendMcpToken[]>('/mcp-tokens').then((tokens) => tokens.filter((token) => token.workspaceId === workspaceId))
  },
  createGrant(id: string, input: { principal: CredentialPrincipal; maxUses: 1 | null; expiresAt: string }) {
    return request<CredentialGrant>(`/secrets/${encodeURIComponent(id)}/grants`, { method: 'POST', body: JSON.stringify(input) })
  },
  revokeGrant(id: string) { return request<null>(`/secret-grants/${encodeURIComponent(id)}`, { method: 'DELETE' }) },
}
