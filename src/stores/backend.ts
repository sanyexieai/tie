import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { backendService, type BackendProfile, type BackendStorageSource, type BackendWorkspace } from '@/services/backend'

export const useBackendStore = defineStore('backend', () => {
  const profile = ref<BackendProfile>(backendService.loadProfile())
  const workspaces = ref<BackendWorkspace[]>([])
  const providers = ref<BackendStorageSource[]>([])
  const providerAvailability = ref<Record<string, boolean>>({})
  const loading = ref(false)
  const error = ref('')
  const initialized = ref(false)
  const syncing = ref(false)
  const lastSyncedAt = ref<string | null>(null)
  const connected = computed(() => Boolean(profile.value.accessToken && profile.value.user))

  function saveProfile() { backendService.saveProfile(profile.value) }
  async function refreshWorkspaces() {
    if (!connected.value) { workspaces.value = []; providers.value = []; providerAvailability.value = {}; return }
    workspaces.value = await backendService.listWorkspaces(profile.value)
    providers.value = await backendService.listProviders(profile.value)
    const availability: Record<string, boolean> = {}
    await Promise.all(providers.value.filter((provider) => provider.kind === 's3').map(async (provider) => {
      availability[provider.id] = await backendService.checkProviderHealth(profile.value, provider.id).then(() => true).catch(() => false)
    }))
    providerAvailability.value = availability
  }
  async function initialize() {
    if (initialized.value) return
    initialized.value = true
    if (!profile.value.accessToken) return
    loading.value = true
    try {
      profile.value.user = await backendService.me(profile.value)
      saveProfile()
      await refreshWorkspaces()
      lastSyncedAt.value = new Date().toISOString()
    } catch {
      profile.value = backendService.clearProfile(profile.value.endpoint)
      workspaces.value = []; providers.value = []; providerAvailability.value = {}
    } finally { loading.value = false }
  }
  async function authenticate(mode: 'login' | 'register', endpoint: string, email: string, password: string, name = '') {
    loading.value = true
    error.value = ''
    try {
      const result = mode === 'login'
        ? await backendService.login(endpoint, email, password)
        : await backendService.register(endpoint, email, password, name)
      profile.value = { endpoint, accessToken: result.accessToken, user: result.user }
      saveProfile()
      await refreshWorkspaces()
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
  function logout() {
    profile.value = backendService.clearProfile(profile.value.endpoint)
    workspaces.value = []; providers.value = []; providerAvailability.value = {}
    error.value = ''
  }

  return { profile, workspaces, providers, providerAvailability, loading, error, initialized, syncing, lastSyncedAt, connected, initialize, authenticate, checkHealth, refreshWorkspaces, createWorkspace, renameWorkspace, deleteWorkspace, createProvider, renameProvider, deleteProvider, sync, logout }
})
