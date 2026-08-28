import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { backendService, type BackendProfile, type BackendStorageSource, type BackendWorkspace } from '@/services/backend'

export const useBackendStore = defineStore('backend', () => {
  const profile = ref<BackendProfile>(backendService.loadProfile())
  const workspaces = ref<BackendWorkspace[]>([])
  const providers = ref<BackendStorageSource[]>([])
  const loading = ref(false)
  const error = ref('')
  const initialized = ref(false)
  const syncing = ref(false)
  const lastSyncedAt = ref<string | null>(null)
  const connected = computed(() => Boolean(profile.value.accessToken && profile.value.user))

  function saveProfile() { backendService.saveProfile(profile.value) }
  async function refreshWorkspaces() {
    if (!connected.value) { workspaces.value = []; providers.value = []; return }
    workspaces.value = await backendService.listWorkspaces(profile.value)
    providers.value = await backendService.listProviders(profile.value)
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
      workspaces.value = []; providers.value = []
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
  function logout() {
    profile.value = backendService.clearProfile(profile.value.endpoint)
    workspaces.value = []; providers.value = []
    error.value = ''
  }

  return { profile, workspaces, providers, loading, error, initialized, syncing, lastSyncedAt, connected, initialize, authenticate, checkHealth, refreshWorkspaces, createWorkspace, renameWorkspace, sync, logout }
})
