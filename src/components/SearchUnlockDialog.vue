<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useWorkspaceStore } from '@/stores/workspace'
import { useBackendStore } from '@/stores/backend'
import { decryptMarkdown, importEncryptionPassword } from '@/services/encrypted-markdown'
import { cacheProtectedPage, protectedPagesRevision } from '@/services/protected-pages'
import { deviceUnlockAvailable, loadDevicePagePassword } from '@/services/page-device-unlock'
import { pageBoundToSource } from '@/services/page-sources'
import type { Page } from '@/types'

const props = defineProps<{ pages: Page[]; sourceId: string | null }>()
const emit = defineEmits<{ close: []; unlocked: [count: number] }>()
const store = useWorkspaceStore()
const backend = useBackendStore()
const password = ref('')
const passwordInput = ref<HTMLInputElement | null>(null)
const busy = ref(false)
const completed = ref(0)
const total = ref(0)
const error = ref('')
const deviceAvailable = deviceUnlockAvailable()
const account = computed(() => JSON.stringify([backend.profile.endpoint, backend.profile.user?.id ?? '', Boolean(backend.profile.accessToken)]))
const context = computed(() => JSON.stringify([account.value, props.sourceId, store.searchStorageSourceId]))
let disposed = false
let generation = 0

function cancel() {
  generation += 1
  password.value = ''
  emit('close')
}

async function unlock(mode: 'password' | 'device') {
  if (busy.value) return
  const entered = password.value
  if (mode === 'password' && !entered) { error.value = '请输入密码'; return }
  const current = ++generation
  const scope = context.value
  const revision = protectedPagesRevision.value
  const snapshots = props.pages.map((page) => ({ ...page, tags: [...page.tags] }))
  const currentAccount = [backend.profile.endpoint, backend.profile.user?.id ?? '']
  const valid = () => !disposed && generation === current && context.value === scope && store.showingSearch
  const decoded: Array<{ stored: Page; markdown: string; key: CryptoKey }> = []
  busy.value = true; completed.value = 0; total.value = snapshots.length; error.value = ''
  try {
    const sharedKey = mode === 'password' ? await importEncryptionPassword(entered) : null
    if (!valid()) return
    for (const snapshot of snapshots) {
      try {
        let key = sharedKey
        if (mode === 'device') {
          const deviceScope = JSON.stringify([...currentAccount, snapshot.storageSourceId, snapshot.id])
          const storedPassword = await loadDevicePagePassword(deviceScope)
          if (!valid()) return
          if (!storedPassword) { completed.value += 1; continue }
          key = await importEncryptionPassword(storedPassword)
          if (!valid()) return
        }
        const markdown = await decryptMarkdown(snapshot.markdown, key!)
        if (!valid()) return
        decoded.push({ stored: snapshot, markdown, key: key! })
      } catch { if (!valid()) return }
      completed.value += 1
    }
    if (!valid()) return
    if (protectedPagesRevision.value !== revision) { error.value = '解锁状态已变化，请重新尝试'; return }
    let count = 0
    for (const item of decoded) {
      const latest = store.pages.find((page) => page.id === item.stored.id && page.storageSourceId === item.stored.storageSourceId)
      if (!latest || latest.deletedAt || latest.markdown !== item.stored.markdown || (props.sourceId && !pageBoundToSource(latest, props.sourceId))) continue
      cacheProtectedPage(latest, { ...latest, markdown: item.markdown }, item.key)
      count += 1
    }
    if (!count) {
      error.value = mode === 'device' ? '本机凭据未能解锁，请输入密码' : '未能解锁页面，请检查密码或稍后重试'
      return
    }
    emit('unlocked', count)
    emit('close')
  } catch {
    if (valid()) error.value = '暂时无法解锁，请检查密码或稍后重试'
  } finally {
    password.value = ''
    if (valid()) busy.value = false
  }
}

watch(context, cancel, { flush: 'sync' })
watch(() => store.showingSearch, (showing) => { if (!showing) cancel() }, { flush: 'sync' })
onMounted(() => { void nextTick(() => passwordInput.value?.focus()) })
onBeforeUnmount(() => { disposed = true; generation += 1; password.value = '' })
</script>

<template>
  <div class="backend-dialog-backdrop" @mousedown.self="cancel" @keydown.esc.stop.prevent="cancel">
    <section class="search-unlock-dialog" role="dialog" aria-modal="true" aria-label="解锁搜索">
      <header><strong>解锁正文搜索</strong><button type="button" aria-label="关闭" @click="cancel">×</button></header>
      <form @submit.prevent="unlock('password')">
        <p>在当前工作区范围内解锁 {{ pages.length }} 页正文，继续使用原来的搜索。</p>
        <label>密码<input ref="passwordInput" v-model="password" aria-label="解锁密码" type="password" autocomplete="current-password" required :disabled="busy" /></label>
        <p v-if="busy" role="status">正在解锁 {{ completed }} / {{ total }}…</p>
        <p v-if="error" class="search-unlock-error" role="alert">{{ error }}</p>
        <footer><button type="button" @click="cancel">取消</button><button v-if="deviceAvailable" type="button" :disabled="busy" @click="unlock('device')">使用本机解锁</button><button type="submit" :disabled="busy">解锁搜索</button></footer>
      </form>
    </section>
  </div>
</template>

<style scoped>
.search-unlock-dialog { width: min(420px, calc(100vw - 28px)); border: 1px solid var(--border); border-radius: 10px; padding: 20px; color: var(--text); background: var(--bg-elevated); }
.search-unlock-dialog header { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 18px; }
.search-unlock-dialog header button { border: 0; padding: 2px 6px; color: var(--text-subtle); background: transparent; font-size: 20px; }
.search-unlock-dialog form { display: grid; gap: 16px; }
.search-unlock-dialog p { margin: 0; color: var(--text-subtle); font-size: 12px; line-height: 1.7; }
.search-unlock-dialog label { display: grid; gap: 7px; color: var(--text-muted); font-size: 12px; }
.search-unlock-dialog input { width: 100%; min-width: 0; border: 1px solid var(--border-strong); border-radius: 5px; padding: 9px 10px; outline: none; color: var(--text); background: var(--bg-main); font: inherit; }
.search-unlock-dialog input:focus { border-color: var(--accent); }
.search-unlock-dialog footer { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
.search-unlock-dialog footer button { border: 0; border-radius: 5px; padding: 8px 11px; color: var(--text-muted); background: transparent; font-size: 12px; }
.search-unlock-dialog footer button:last-child { color: var(--accent-strong); background: var(--accent-soft); }
.search-unlock-dialog button:disabled { opacity: .5; cursor: default; }
.search-unlock-dialog .search-unlock-error { color: var(--danger); }
</style>
