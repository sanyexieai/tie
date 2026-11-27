<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { useWorkspaceStore } from '@/stores/workspace'
import { useBackendStore } from '@/stores/backend'
import { encryptMarkdown, importEncryptionPassword, setWorkspaceEncryptionKey } from '@/services/encrypted-markdown'
import { cacheProtectedPage } from '@/services/protected-pages'
import { deviceUnlockAvailable, saveDevicePagePassword } from '@/services/page-device-unlock'

const emit = defineEmits<{ close: [] }>()
const store = useWorkspaceStore()
const backend = useBackendStore()
const title = ref('')
const sourceId = ref(store.encryptedDraftSourceId)
const password = ref('')
const confirmation = ref('')
const remember = ref(false)
const busy = ref(false)
const error = ref('')
const deviceAvailable = deviceUnlockAvailable()
let disposed = false
onBeforeUnmount(() => { disposed = true; password.value = ''; confirmation.value = '' })
const sources = computed(() => store.allSources.filter((source) => !source.temporary && source.available !== false))
async function create() {
  if (password.value !== confirmation.value) { error.value = '两次密码不一致'; return }
  busy.value = true; error.value = ''
  const entered = password.value
  const selectedSource = sourceId.value
  const shouldRemember = remember.value
  const name = title.value.trim() || '无标题'
  const account = JSON.stringify([backend.profile.endpoint, backend.profile.user?.id ?? ''])
  const current = () => !disposed && account === JSON.stringify([backend.profile.endpoint, backend.profile.user?.id ?? ''])
  try {
    const key = await importEncryptionPassword(entered)
    const markdown = `# ${name}\n\n`
    const ciphertext = await encryptMarkdown(markdown, key)
    if (!current()) return
    const created = await store.createEncryptedPage(name, ciphertext, selectedSource)
    if (!current()) return
    if (shouldRemember && deviceAvailable) {
      const scope = JSON.stringify([backend.profile.endpoint, backend.profile.user?.id ?? '', created.storageSourceId, created.id])
      try { await saveDevicePagePassword(scope, entered) }
      catch { window.alert('页面已创建，但系统凭据库未能记住密码。请保管密码，下次仍可用密码解锁。') }
    }
    if (!current()) return
    setWorkspaceEncryptionKey(created.storageSourceId, key)
    cacheProtectedPage(created, { ...created, markdown }, key)
    password.value = ''; confirmation.value = ''
    store.showingEncryptedDraft = false
    store.openPage(created.id)
    emit('close')
  } catch (reason) { error.value = reason instanceof Error ? reason.message : '无法创建页面' }
  finally { busy.value = false }
}
</script>
<template>
  <div class="backend-dialog-backdrop" @mousedown.self="!busy && emit('close')">
    <section class="page-protection-dialog" role="dialog" aria-modal="true" aria-label="新建加密页面">
      <header><strong>新建加密页面</strong><button type="button" aria-label="关闭" :disabled="busy" @click="emit('close')">×</button></header>
      <form @submit.prevent="create"><fieldset :disabled="busy">
        <label>页面标题<input v-model="title" aria-label="页面标题" placeholder="无标题" /></label>
        <label v-if="sources.length > 1">工作区<select v-model="sourceId" aria-label="加密页面工作区"><option v-for="source in sources" :key="source.id" :value="source.id">{{ source.name }}</option></select></label>
        <label>密码<input v-model="password" aria-label="解锁密码" type="password" autocomplete="new-password" required /></label>
        <label>确认密码<input v-model="confirmation" aria-label="确认密码" type="password" autocomplete="new-password" required /></label>
        <label v-if="deviceAvailable" class="page-protection-remember"><input v-model="remember" type="checkbox" /> 在此设备记住</label>
        <p>页面内容加密保存，解锁后用法与普通页面相同。请保管好密码，其他设备也用它解锁；标题和标签仍用于目录搜索。</p>
        <p v-if="error" class="page-protection-error" role="alert">{{ error }}</p>
        <button type="submit" :disabled="busy || !sourceId">{{ busy ? '正在创建…' : '创建页面' }}</button>
        </fieldset>
      </form>
    </section>
  </div>
</template>
<style scoped>
.page-protection-dialog { width: min(420px, calc(100vw - 28px)); border: 1px solid var(--border); border-radius: 10px; padding: 20px; background: var(--bg-elevated); color: var(--text); }
.page-protection-dialog header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 20px; }
.page-protection-dialog header button { border: 0; padding: 2px 6px; color: var(--text-subtle); background: transparent; font-size: 20px; }
.page-protection-dialog form { display: grid; gap: 15px; }
.page-protection-dialog fieldset { display: grid; gap: 15px; min-width: 0; margin: 0; border: 0; padding: 0; }
.page-protection-dialog label { display: grid; gap: 7px; color: var(--text-muted); font-size: 12px; }
.page-protection-dialog input:not([type=checkbox]), .page-protection-dialog select { width: 100%; min-width: 0; border: 1px solid var(--border-strong); border-radius: 5px; padding: 8px 10px; color: var(--text); background: var(--bg-main); font: inherit; }
.page-protection-dialog .page-protection-remember { display: flex; align-items: center; }
.page-protection-dialog p { margin: 0; color: var(--text-subtle); font-size: 11px; line-height: 1.7; }
.page-protection-dialog button[type=submit] { justify-self: start; border: 0; border-radius: 5px; padding: 8px 15px; color: var(--accent-strong); background: var(--accent-soft); }
.page-protection-dialog .page-protection-error { color: var(--danger); }
</style>
