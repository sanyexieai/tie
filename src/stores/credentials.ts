import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import { useBackendStore } from '@/stores/backend'
import { credentialsService, type CredentialMetadata } from '@/services/credentials'

/** Navigation and metadata only. Secret values stay inside the mounted editor. */
export const useCredentialsStore = defineStore('credentials', () => {
  const backend = useBackendStore()
  const workspaceId = ref('')
  const entries = ref<CredentialMetadata[]>([])
  const query = ref('')
  const activeCredentialId = ref<string | null>(null)
  const draft = ref(0)
  const loading = ref(false)
  const error = ref('')
  let request = 0
  const accountKey = computed(() => backend.connected ? `${backend.profile.endpoint}\n${backend.profile.user?.id}` : '')
  const workspaces = computed(() => backend.workspaces.filter((item) => item.ownerId === backend.profile.user?.id))
  const workspace = computed(() => workspaces.value.find((item) => item.id === workspaceId.value))
  const selectionKey = computed(() => JSON.stringify([accountKey.value, workspaceId.value, activeCredentialId.value, draft.value]))

  function ensureWorkspace(preferred?: string) {
    const next = workspaces.value.find((item) => item.id === preferred)
      ?? workspaces.value.find((item) => item.id === workspaceId.value)
      ?? workspaces.value.find((item) => item.default)
      ?? workspaces.value[0]
    if (workspaceId.value !== (next?.id ?? '')) {
      request += 1
      workspaceId.value = next?.id ?? ''
      entries.value = []
      query.value = ''
      activeCredentialId.value = null
      error.value = ''
      loading.value = false
    }
    return workspaceId.value
  }

  async function refresh() {
    const id = ensureWorkspace()
    const account = accountKey.value
    const pending = ++request
    if (!id || !account) return
    loading.value = true
    error.value = ''
    try {
      const result = await credentialsService.list(id, query.value)
      if (pending === request && account === accountKey.value && id === workspaceId.value) entries.value = result
    } catch (reason) {
      if (pending === request && account === accountKey.value) error.value = reason instanceof Error ? reason.message : '凭据页面读取失败'
    } finally {
      if (pending === request) loading.value = false
    }
  }

  function open(id: string | null = null, preferredWorkspace?: string) {
    ensureWorkspace(preferredWorkspace)
    activeCredentialId.value = id
    if (!id) draft.value += 1
  }

  async function selectWorkspace(id: string) {
    ensureWorkspace(id)
    await refresh()
  }

  function saved(item: CredentialMetadata) {
    if (item.workspaceId !== workspaceId.value) return
    request += 1
    loading.value = false
    entries.value = [item, ...entries.value.filter((entry) => entry.id !== item.id)]
    activeCredentialId.value = item.id
  }

  function removed(id: string) {
    request += 1
    loading.value = false
    entries.value = entries.value.filter((item) => item.id !== id)
    if (activeCredentialId.value === id) open()
  }

  watch(accountKey, () => {
    request += 1
    workspaceId.value = ''
    entries.value = []
    query.value = ''
    activeCredentialId.value = null
    draft.value += 1
    loading.value = false
    error.value = ''
  }, { flush: 'sync' })
  watch(() => backend.workspaces.map((item) => item.id).join('\n'), () => { ensureWorkspace() })

  return { workspaceId, workspace, workspaces, entries, query, activeCredentialId, selectionKey, loading, error, ensureWorkspace, refresh, open, selectWorkspace, saved, removed }
})
