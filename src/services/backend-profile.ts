import { getActivePinia } from 'pinia'
import { backendService, type BackendProfile } from '@/services/backend'
import { useBackendStore } from '@/stores/backend'

export function currentBackendProfile(): BackendProfile {
  const pinia = getActivePinia()
  return pinia ? useBackendStore(pinia).profile : backendService.loadProfile()
}
