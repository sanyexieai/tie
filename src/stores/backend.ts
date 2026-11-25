import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { backendService, BackendRequestError, type BackendHealth, type BackendMcpStatus, type BackendProfile, type BackendServer, type BackendStorageSource, type BackendWorkspace } from '@/services/backend'

export const useBackendStore = defineStore('backend', () => {
  const profile = ref<BackendProfile>(backendService.loadProfile())
  const servers = ref<BackendServer[]>(backendService.loadServers())
  const workspaces = ref<BackendWorkspace[]>([])
  const providers = ref<BackendStorageSource[]>([])
  const providerAvailability = ref<Record<string, boolean>>({})
  const loading = ref(false)
  const error = ref('')
  const initialized = ref(false)
  const syncing = ref(false)
  const lastSyncedAt = ref<string | null>(null)
  const mcp = ref<BackendMcpStatus | null>(null)
  const connected = computed(() => Boolean(profile.value.accessToken && profile.value.user))

  function applyHealth(health: BackendHealth) {
    mcp.value = health.mcp ?? null
  }

  function saveProfile() {
    backendService.saveProfile(profile.value)
    if (profile.value.accessToken && profile.value.user) void backendService.publishSession(profile.value)
  }
  function addServer(endpoint: string) {
    const created = backendService.addServer(endpoint)
    servers.value = backendService.loadServers()
    return servers.value.find((item) => item.id === created.id) ?? servers.value.find((item) => item.endpoint === created.endpoint) ?? created
  }
  async function updateServerEndpoint(id: string, endpoint: string) {
    loading.value = true
    error.value = ''
    try {
      await backendService.health(endpoint)
      const server = backendService.updateServer(id, endpoint)
      servers.value = backendService.loadServers()
      profile.value.endpoint = server.endpoint
      saveProfile()
      return server
    } catch (reason) {
      error.value = reason instanceof Error ? reason.message : '保存后台服务设置失败'
      throw reason
    } finally { loading.value = false }
  }
  function removeServer(id: string) { const target = servers.value.find((s) => s.id === id); backendService.removeServer(id); servers.value = backendService.loadServers(); if (target && profile.value.endpoint === target.endpoint) logout() }
  function setDefaultPrompt(id: string, enabled: boolean) { backendService.setDefaultPrompt(id, enabled); if (enabled) backendService.clearDefaultPromptDismissal(); servers.value = backendService.loadServers() }
  function dismissDefaultPrompt() { backendService.dismissDefaultPrompt() }
  async function refreshWorkspaces() {
    if (!connected.value) { workspaces.value = []; providers.value = []; providerAvailability.value = {}; return }
    workspaces.value = await backendService.listWorkspaces(profile.value)
    providers.value = await backendService.listProviders(profile.value)
    providerAvailability.value = {}
  }
  async function initialize() {
    if (initialized.value) return
    initialized.value = true
    profile.value = await backendService.readSession()
    if (!profile.value.accessToken) return
    loading.value = true
    try {
      await backendService.refresh(profile.value, false)
      profile.value.user = await backendService.me(profile.value)
      await backendService.publishSession(profile.value)
      applyHealth(await backendService.health(profile.value.endpoint))
      await refreshWorkspaces()
      lastSyncedAt.value = new Date().toISOString()
      armRefresh()
    } catch (reason) {
      if (reason instanceof BackendRequestError && (reason.status === 401 || reason.status === 403)) {
        profile.value = backendService.clearProfile(profile.value.endpoint)
        await backendService.publishSession(profile.value)
        workspaces.value = []; providers.value = []; providerAvailability.value = {}
      } else {
        error.value = '暂时无法确认登录，将自动重试'
      }
    } finally { loading.value = false }
  }
  async function authenticate(mode: 'login' | 'register', endpoint: string, email: string, password: string, name = '') {
    loading.value = true
    error.value = ''
    try {
      const result = mode === 'login'
        ? await backendService.login(endpoint, email, password)
        : await backendService.register(endpoint, email, password, name)
      profile.value = {
        endpoint,
        accessToken: result.accessToken,
        refreshToken: result.refreshToken ?? null,
        accessExpiresAt: result.accessExpiresAt ?? null,
        user: result.user,
      }
      await backendService.publishSession(profile.value)
      applyHealth(await backendService.health(endpoint))
      await refreshWorkspaces()
      armRefresh()
    } catch (reason) {
      error.value = reason instanceof Error ? reason.message : '后台登录失败'
      throw reason
    } finally { loading.value = false }
  }
  async function checkHealth(endpoint: string) {
    loading.value = true
    error.value = ''
    try { await backendService.health(endpoint) }
    catch (reason) { error.value = reason instanceof Error ? reason.message : '后台不可用'; throw reason }
    finally { loading.value = false }
  }
  async function createWorkspace(name: string) {
    loading.value = true
    error.value = ''
    try {
      await backendService.createWorkspace(profile.value, name)
      await refreshWorkspaces()
    } catch (reason) {
      error.value = reason instanceof Error ? reason.message : '创建工作区失败'
      throw reason
    } finally { loading.value = false }
  }
  async function renameWorkspace(workspaceId: string, name: string) {
    loading.value = true
    error.value = ''
    try {
      const workspace = await backendService.renameWorkspace(profile.value, workspaceId, name)
      workspaces.value = workspaces.value.map((item) => item.id === workspace.id ? workspace : item)
      return workspace
    } catch (reason) {
      error.value = reason instanceof Error ? reason.message : '重命名后台工作区失败'
      throw reason
    } finally { loading.value = false }
  }
  async function deleteWorkspace(workspaceId: string) {
    loading.value = true
    error.value = ''
    try {
      await backendService.deleteWorkspace(profile.value, workspaceId)
      await refreshWorkspaces()
    } catch (reason) {
      error.value = reason instanceof Error ? reason.message : '删除后台工作区失败'
      throw reason
    } finally { loading.value = false }
  }
  async function sync() {
    if (!connected.value || syncing.value) return false
    syncing.value = true
    error.value = ''
    try {
      await refreshWorkspaces()
      lastSyncedAt.value = new Date().toISOString()
      return true
    } catch (reason) {
      error.value = reason instanceof Error ? reason.message : '后台同步失败'
      return false
    } finally { syncing.value = false }
  }
  async function createProvider(input: {
    name: string
    kind: BackendStorageSource['kind']
    publicConfig: Record<string, unknown>
    credentials?: Record<string, string>
  }) {
    loading.value = true
    error.value = ''
    try {
      await backendService.createProvider(profile.value, input)
      await refreshWorkspaces()
    } catch (reason) {
      error.value = reason instanceof Error ? reason.message : '创建 Provider 失败'
      throw reason
    } finally { loading.value = false }
  }
  async function deleteProvider(providerId: string) {
    loading.value = true
    error.value = ''
    try {
      await backendService.deleteProvider(profile.value, providerId)
      await refreshWorkspaces()
    } catch (reason) {
      error.value = reason instanceof Error ? reason.message : '删除 Provider 失败'
      throw reason
    } finally { loading.value = false }
  }
  async function renameProvider(providerId: string, name: string) {
    loading.value = true
    error.value = ''
    try {
      const provider = await backendService.renameProvider(profile.value, providerId, name)
      providers.value = providers.value.map((item) => item.id === provider.id ? provider : item)
      return provider
    } catch (reason) {
      error.value = reason instanceof Error ? reason.message : '重命名 Provider 失败'
      throw reason
    } finally { loading.value = false }
  }
  async function refreshMcp() {
    if (!profile.value.endpoint) { mcp.value = null; return }
    try { applyHealth(await backendService.health(profile.value.endpoint)) }
    catch { mcp.value = null }
  }
  function logout() {
    const endpoint = profile.value.endpoint
    const refreshToken = profile.value.refreshToken
    if (refreshToken) {
      void fetch(`${endpoint.replace(/\/$/, '')}/api/v1/auth/logout`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      }).catch(() => undefined)
    }
    profile.value = backendService.clearProfile(endpoint)
    void backendService.publishSession(profile.value)
    if (refreshTimer) window.clearTimeout(refreshTimer)
    workspaces.value = []; providers.value = []; providerAvailability.value = {}
    mcp.value = null
    error.value = ''
  }

  let refreshTimer = 0
  function armRefresh() {
    if (refreshTimer) window.clearTimeout(refreshTimer)
    const at = profile.value.accessExpiresAt
    if (!at || !profile.value.refreshToken) return
    const delay = Math.max(Date.parse(at) - Date.now() - 120_000, 1_000)
    refreshTimer = window.setTimeout(() => {
      void backendService.refresh(profile.value, false).then(() => armRefresh()).catch((reason) => {
        if (reason instanceof BackendRequestError && reason.status === 401) logout()
      })
    }, delay)
  }

  return { profile, servers, workspaces, providers, providerAvailability, loading, error, initialized, syncing, lastSyncedAt, mcp, connected, initialize, addServer, updateServerEndpoint, removeServer, setDefaultPrompt, dismissDefaultPrompt, authenticate, checkHealth, refreshMcp, refreshWorkspaces, createWorkspace, renameWorkspace, deleteWorkspace, createProvider, renameProvider, deleteProvider, sync, logout }
})
