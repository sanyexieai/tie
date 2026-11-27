<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import DocumentEditor from '@/components/DocumentEditor.vue'
import { useWorkspaceStore } from '@/stores/workspace'
import { useBackendStore } from '@/stores/backend'
import { decryptMarkdown, encryptMarkdown, isEncryptedMarkdown, getWorkspaceEncryptionKey, importEncryptionPassword, lockWorkspaceEncryption, setWorkspaceEncryptionKey } from '@/services/encrypted-markdown'
import { cacheProtectedPage, decryptProtectedSnapshot, lockProtectedPage, protectedPageAuthorization, protectedPageKey, protectedPageView } from '@/services/protected-pages'
import { deviceUnlockAvailable, forgetDevicePagePassword, loadDevicePagePassword, saveDevicePagePassword } from '@/services/page-device-unlock'
import { workspaceService } from '@/services/workspace'
import type { DocumentSession } from '@/services/document-session'
import type { Page } from '@/types'
import { pageContentEqual } from '@/services/page-sources'

const props = defineProps<{ page: Page; mobileLayout?: boolean }>()
const emit = defineEmits<{ 'toggle-sidebar': []; 'toggle-focus': []; 'toggle-context': []; 'mobile-back': [] }>()
const store = useWorkspaceStore()
const backend = useBackendStore()
const editor = ref<InstanceType<typeof DocumentEditor> | null>(null)
const view = shallowRef<Page | null>(protectedPageView(props.page))
const password = ref('')
const remember = ref(false)
const remembered = ref(false)
const opening = ref(false)
const busy = ref(false)
const error = ref('')
const dirty = ref(false)
const deviceAvailable = deviceUnlockAvailable()
const scope = computed(() => JSON.stringify([backend.profile.endpoint, backend.profile.user?.id ?? '', props.page.storageSourceId, props.page.id]))
let generation = 0
let disposed = false
let key: CryptoKey | undefined = protectedPageKey(props.page)
let savedCipher = props.page.markdown
let savingCipher = ''
let refreshing = false

function currentContext(expectedScope: string, expectedGeneration: number) {
  return !disposed && scope.value === expectedScope && generation === expectedGeneration
}

function authorized(page: Page, permission: NonNullable<ReturnType<typeof protectedPageAuthorization>>, expectedScope: string) {
  const current = protectedPageAuthorization(page)
  return scope.value === expectedScope && current?.key === permission.key && current.ciphertext === permission.ciphertext
    && current.generation === permission.generation && current.epoch === permission.epoch
}

async function open(candidate: CryptoKey, expectedScope = scope.value, expectedGeneration = generation) {
  if (!currentContext(expectedScope, expectedGeneration)) return
  const current = ++generation
  const snapshot = props.page
  const markdown = await decryptMarkdown(snapshot.markdown, candidate)
  if (!currentContext(expectedScope, current) || props.page.markdown !== snapshot.markdown) return
  const plain = { ...snapshot, markdown }
  cacheProtectedPage(snapshot, plain, candidate)
  key = candidate
  view.value = plain
  savedCipher = snapshot.markdown
  error.value = ''
  setWorkspaceEncryptionKey(snapshot.storageSourceId, candidate)
}

async function unlock() {
  opening.value = true; error.value = ''
  const currentScope = scope.value
  const current = generation
  const entered = password.value
  try {
    const candidate = await importEncryptionPassword(entered)
    await open(candidate, currentScope, current)
    if (!disposed && view.value && remember.value && currentScope === scope.value) {
      await saveDevicePagePassword(currentScope, entered)
      if (!disposed) remembered.value = true
    }
  } catch (reason) { if (!disposed) error.value = reason instanceof Error ? reason.message : '无法解锁页面' }
  finally { password.value = ''; opening.value = false }
}

async function forgetDevice() {
  error.value = ''; opening.value = true
  const currentScope = scope.value
  const current = ++generation
  try { await forgetDevicePagePassword(currentScope); if (currentContext(currentScope, current)) { remembered.value = false; remember.value = false } }
  catch (reason) { if (currentContext(currentScope, current)) error.value = reason instanceof Error ? reason.message : '无法清除本机解锁凭据' }
  finally { if (currentContext(currentScope, current)) opening.value = false }
}

async function save(page: Page, force = false) {
  const candidate = key
  const current = generation
  const raw = props.page
  const accountScope = scope.value
  if (!candidate || !view.value) throw new Error('请先解锁页面')
  const permittedView = { ...view.value }
  const permission = protectedPageAuthorization(permittedView)
  if (!permission || permission.key !== candidate) throw new Error('请先解锁页面')
  if (!force && (raw.markdown !== savedCipher || !pageContentEqual({ ...raw, markdown: view.value.markdown }, view.value))) throw new Error('页面已在其他设备更新，请重新载入后再保存')
  busy.value = true
  try {
    const ciphertext = raw.markdown === savedCipher && page.markdown === view.value.markdown ? raw.markdown : await encryptMarkdown(page.markdown, candidate)
    if (!authorized(permittedView, permission, accountScope)) throw new Error('页面已锁定，请重新解锁后保存')
    const latest = store.pages.find((item) => item.id === raw.id && item.storageSourceId === raw.storageSourceId)
    if (!force && (!latest || latest.markdown !== raw.markdown || !pageContentEqual(latest, raw))) throw new Error('页面已在其他设备更新，请重新载入后再保存')
    savingCipher = ciphertext
    await store.persist({ ...raw, title: page.title, tags: page.tags, markdown: ciphertext }, { force })
    const stored = store.pages.find((item) => item.id === page.id && item.storageSourceId === page.storageSourceId)
    if (stored && stored.markdown === ciphertext && authorized(permittedView, permission, accountScope)) {
      const plain = { ...stored, markdown: page.markdown }
      cacheProtectedPage(stored, plain, candidate)
      if (!disposed && current === generation) { savedCipher = ciphertext; view.value = plain; error.value = '' }
    }
  } finally { busy.value = false; savingCipher = '' }
}

async function refresh(isCurrent = () => true) {
  const candidate = key
  const current = ++generation
  const currentScope = scope.value
  if (!candidate) throw new Error('请先解锁页面')
  refreshing = true
  try {
    const latest = await store.refreshPage(props.page.id)
    if (!currentContext(currentScope, current) || !isCurrent()) return
    const raw = latest ?? store.pages.find((item) => item.id === props.page.id)
    if (!raw) throw new Error('页面不存在')
    const markdown = await decryptMarkdown(raw.markdown, candidate)
    if (!currentContext(currentScope, current) || !isCurrent() || props.page.markdown !== raw.markdown) return
    const plain = { ...raw, markdown }
    cacheProtectedPage(raw, plain, candidate)
    view.value = plain; savedCipher = raw.markdown; error.value = ''
  } finally { refreshing = false }
}

async function createPage(title: string, parentId: string | null) {
  const candidate = key
  const current = generation
  if (!candidate || !view.value) throw new Error('请先解锁页面')
  const permittedView = { ...view.value }
  const permission = protectedPageAuthorization(permittedView)
  const accountScope = scope.value
  const sourceId = props.page.storageSourceId
  if (!permission || permission.key !== candidate) throw new Error('请先解锁页面')
  const cleanTitle = title.trim() || '无标题'
  const markdown = `# ${cleanTitle}\n\n`
  const ciphertext = await encryptMarkdown(markdown, candidate)
  if (!authorized(permittedView, permission, accountScope)) throw new Error('页面已锁定，请重新解锁后创建')
  const created = await workspaceService.createPage(parentId, sourceId, { title: cleanTitle, markdown: ciphertext })
  if (!authorized(permittedView, permission, accountScope)) throw new Error('解锁状态已变化，请重新打开页面')
  store.pages.push(created)
  store.expandPage(props.page.id)
  store.scheduleBackendSync()
  const plain = { ...created, markdown }
  if (!disposed && current === generation) cacheProtectedPage(created, plain, candidate)
  return plain
}

function lock() {
  generation += 1
  lockProtectedPage(props.page)
  lockWorkspaceEncryption(props.page.storageSourceId)
  view.value = null; key = undefined; password.value = ''; error.value = ''
}

const session: DocumentSession = {
  get page() { return view.value ?? { ...props.page, markdown: '' } },
  get locked() { return !view.value },
  get busy() { return busy.value },
  get error() { return error.value },
  save,
  refresh,
  async latest() {
    const latest = await store.readLatestPage(props.page.id)
    return latest ? decryptProtectedSnapshot(latest) : null
  },
  async readRevision(id) {
    const snapshot = await store.readPageRevision(props.page.id, id)
    if (!snapshot || !isEncryptedMarkdown(snapshot.markdown)) throw new Error('无法读取未加密的历史版本')
    return decryptProtectedSnapshot(snapshot)
  },
  async restoreRevision(id) {
    const snapshot = await store.readPageRevision(props.page.id, id)
    if (!snapshot || !isEncryptedMarkdown(snapshot.markdown)) throw new Error('无法恢复未加密的历史版本')
    const plain = await decryptProtectedSnapshot(snapshot)
    await save({ ...props.page, title: plain.title, tags: plain.tags, markdown: plain.markdown })
  },
  createPage,
  lock,
}

watch(() => props.page, async (next) => {
  if (!key || refreshing || next.markdown === savingCipher) return
  const cached = protectedPageView(next)
  if (cached) { if (!busy.value && !dirty.value) view.value = cached; return }
  if (dirty.value || busy.value) { error.value = '页面已在其他设备更新，请重新载入后再保存'; return }
  const current = ++generation
  const candidate = key
  try {
    const plain = await decryptProtectedSnapshot(next)
    if (disposed || current !== generation) return
    if (dirty.value) { error.value = '页面已在其他设备更新，请重新载入后再保存'; return }
    cacheProtectedPage(next, plain, candidate)
    view.value = plain; savedCipher = next.markdown
  } catch (reason) { if (!disposed) error.value = reason instanceof Error ? reason.message : '无法解锁更新后的页面' }
})

onMounted(async () => {
  if (view.value) return
  opening.value = true
  const currentScope = scope.value
  try {
    const cached = getWorkspaceEncryptionKey(props.page.storageSourceId)
    if (cached) { try { await open(cached, currentScope); return } catch { /* A page may use a different password. */ } }
    if (deviceAvailable) {
      const current = generation
      const stored = await loadDevicePagePassword(currentScope)
      if (currentContext(currentScope, current) && stored) {
        const candidate = await importEncryptionPassword(stored)
        if (currentContext(currentScope, current)) { remembered.value = true; await open(candidate, currentScope, current) }
      }
    }
  } catch (reason) { if (!disposed) error.value = reason instanceof Error ? reason.message : '请输入解锁密码' }
  finally { opening.value = false }
})
onBeforeUnmount(() => {
  const flushed = editor.value?.saveNow() ?? Promise.resolve(true)
  disposed = true; generation += 1
  void flushed.finally(() => {
    view.value = null; key = undefined; password.value = ''
  })
})
</script>

<template>
  <DocumentEditor ref="editor" :session="session" :mobile-layout="mobileLayout"
    @toggle-sidebar="emit('toggle-sidebar')" @toggle-focus="emit('toggle-focus')" @toggle-context="emit('toggle-context')" @mobile-back="emit('mobile-back')" @dirty-change="dirty = $event">
    <template #unlock>
      <form class="page-unlock" aria-label="解锁页面" @submit.prevent="unlock">
        <h1>{{ page.title }}</h1>
        <p>此页面已加密，解锁后即可正常查看、搜索和编辑。</p>
        <label>密码<input v-model="password" type="password" aria-label="解锁密码" autocomplete="current-password" required :disabled="opening" autofocus /></label>
        <label v-if="deviceAvailable" class="page-unlock-remember"><input v-model="remember" type="checkbox" /> 在此设备记住</label>
        <div><button type="submit" :disabled="opening">{{ opening ? '正在解锁…' : '解锁页面' }}</button><button v-if="deviceAvailable" type="button" :disabled="opening" @click="forgetDevice">忘记本机解锁</button></div>
        <p v-if="error" class="page-unlock-error" role="alert">{{ error }}</p>
      </form>
    </template>
  </DocumentEditor>
</template>

<style scoped>
.page-unlock { display: grid; gap: 16px; width: min(100%, 360px); margin: 20px 0; }
.page-unlock h1 { margin: 0; color: var(--text); font-size: 30px; line-height: 1.3; }
.page-unlock p { margin: 0; color: var(--text-subtle); font-size: 13px; line-height: 1.7; }
.page-unlock label { display: grid; gap: 8px; color: var(--text-muted); font-size: 12px; }
.page-unlock input[type=password] { width: 100%; min-width: 0; border: 1px solid var(--border-strong); border-radius: 5px; padding: 9px 10px; color: var(--text); background: var(--bg-elevated); font: inherit; outline: none; }
.page-unlock input:focus { border-color: var(--accent); }
.page-unlock .page-unlock-remember { display: flex; align-items: center; }
.page-unlock > div { display: flex; gap: 10px; }
.page-unlock button { border: 0; border-radius: 5px; padding: 8px 14px; color: var(--accent-strong); background: var(--accent-soft); font-size: 12px; }
.page-unlock .page-unlock-error { color: var(--danger); }
</style>
