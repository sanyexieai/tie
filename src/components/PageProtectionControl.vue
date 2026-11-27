<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import type { Page } from '@/types'
import { useWorkspaceStore } from '@/stores/workspace'
import { useBackendStore } from '@/stores/backend'
import { BackendRequestError, backendService, isBackendSourceId } from '@/services/backend'
import { pageSourceIds } from '@/services/page-sources'
import { pickAccountWorkspace } from '@/services/browser-backend'
import { decryptMarkdown, importEncryptionPassword, isEncryptedMarkdown, lockWorkspaceEncryption, setWorkspaceEncryptionKey } from '@/services/encrypted-markdown'
import { cacheProtectedPage, lockProtectedPage, protectedPageAuthorization } from '@/services/protected-pages'
import { deviceUnlockAvailable, forgetDevicePagePassword, saveDevicePagePassword } from '@/services/page-device-unlock'
import { readPageProtection, replacePageProtection, transformPageProtection } from '@/services/page-protection'
import { reviewPageKey, reviewState } from '@/services/review-service'
import { syncQueue } from '@/services/storage/sync-queue'
import type { PageProtectionBundle } from '@/services/page-protection-types'

const props = defineProps<{ page: Page; prepare: () => Promise<boolean>; locked?: boolean }>()
const emit = defineEmits<{ busy: [busy: boolean] }>()
const store = useWorkspaceStore()
const backend = useBackendStore()
const opened = ref(false)
const unlockRequired = ref(false)
const password = ref('')
const confirmation = ref('')
const remember = ref(false)
const busy = ref(false)
const error = ref('')
const encrypted = computed(() => isEncryptedMarkdown(props.page.markdown))
const label = computed(() => encrypted.value ? '转为普通页面' : '转为加密页面')
const scope = computed(() => JSON.stringify([backend.profile.endpoint, backend.profile.user?.id ?? '', props.page.storageSourceId, props.page.id]))
const deviceAvailable = deviceUnlockAvailable()
let disposed = false
let generation = 0
let releasePageHold: (() => void) | undefined

function close() {
  opened.value = false
  unlockRequired.value = false
  password.value = ''; confirmation.value = ''; error.value = ''
  generation += 1
  releasePageHold?.()
  releasePageHold = undefined
}

async function open() {
  if (busy.value) return
  if (props.locked) {
    unlockRequired.value = true
    await nextTick()
    document.querySelector<HTMLInputElement>('.editor-pane input[aria-label="解锁密码"]')?.focus()
    return
  }
  unlockRequired.value = false
  error.value = ''
  const expectedScope = scope.value
  if (await props.prepare() && !disposed && scope.value === expectedScope) {
    releasePageHold ??= store.holdPageForProtectionChange(props.page.id)
    opened.value = true
  }
}

async function targets(page: Page) {
  const ids = new Set(pageSourceIds(page))
  if (!isBackendSourceId(page.storageSourceId) && page.storageSourceId !== 'source-demo-local' && backend.connected) {
    const target = pickAccountWorkspace(await backendService.listWorkspaces(backend.profile))
    if (target) ids.add(`backend:${target.id}`)
  }
  const result: PageProtectionBundle[] = []
  for (const sourceId of ids) {
    try { result.push(await readPageProtection({ ...page, storageSourceId: sourceId })) }
    catch (reason) {
      if (isBackendSourceId(sourceId) && reason instanceof BackendRequestError && reason.status === 404) continue
      throw reason
    }
  }
  return result.sort((left, right) => Number(left.sourceId === page.storageSourceId) - Number(right.sourceId === page.storageSourceId))
}

async function convert() {
  error.value = ''
  const toEncrypted = !encrypted.value
  if (toEncrypted && password.value !== confirmation.value) { error.value = '两次密码不一致'; return }
  const expectedScope = scope.value
  const currentGeneration = ++generation
  const current = () => !disposed && scope.value === expectedScope && generation === currentGeneration
  const page = props.page
  const permission = encrypted.value ? protectedPageAuthorization(page) : undefined
  const entered = password.value
  busy.value = true; emit('busy', true)
  let completed = 0
  try {
    if (!await props.prepare() || !current()) return
    const key = toEncrypted ? await importEncryptionPassword(entered) : permission?.key
    if (!key) throw new Error('请先解锁页面再转换')
    const bundles = await targets(props.page)
    const sealed = new Map<string, Promise<string>>()
    const changes: { before: PageProtectionBundle; after: PageProtectionBundle }[] = []
    let primary: Page | undefined
    let plaintext = ''
    for (const bundle of bundles) {
      if (isEncryptedMarkdown(bundle.page.markdown) === toEncrypted) {
        const markdown = toEncrypted ? await decryptMarkdown(bundle.page.markdown, key) : bundle.page.markdown
        if (bundle.sourceId === page.storageSourceId) {
          primary = { ...bundle.page, storageSourceId: page.storageSourceId, storageSourceIds: page.storageSourceIds }
          plaintext = markdown
        }
        continue
      }
      changes.push({ before: bundle, after: await transformPageProtection(bundle, key, toEncrypted, sealed) })
    }
    for (const { before, after } of changes) {
      if (!current()) return
      if (permission) {
        const active = protectedPageAuthorization(props.page)
        if (!active || active.key !== permission.key || active.generation !== permission.generation || active.epoch !== permission.epoch) throw new Error('页面已重新锁定，请解锁后再转换')
      }
      const saved = await replacePageProtection(after, before.page.updatedAt)
      completed += 1
      if (before.sourceId === page.storageSourceId) {
        primary = { ...saved, storageSourceId: page.storageSourceId, storageSourceIds: page.storageSourceIds }
        plaintext = toEncrypted ? await decryptMarkdown(after.page.markdown, key) : after.page.markdown
      }
    }
    if (!current() || !primary) return
    if (deviceAvailable) {
      try {
        if (toEncrypted && remember.value) await saveDevicePagePassword(expectedScope, entered)
        else if (!toEncrypted) await forgetDevicePagePassword(expectedScope)
      } catch { window.alert('页面已转换，但本机解锁记录未能更新。加密页面仍可使用密码解锁。') }
    }
    if (!current()) return
    for (const sourceId of pageSourceIds(page)) {
      lockProtectedPage({ ...page, storageSourceId: sourceId })
      delete reviewState.byPage[reviewPageKey(page.id, sourceId)]
    }
    syncQueue.removeForPage(page.id)
    if (toEncrypted) {
      cacheProtectedPage(primary, { ...primary, markdown: plaintext }, key)
      setWorkspaceEncryptionKey(page.storageSourceId, key)
    } else lockWorkspaceEncryption(page.storageSourceId)
    store.pages = store.pages.map((item) => item.id === primary!.id ? primary! : item)
    store.scheduleBackendSync()
    window.dispatchEvent(new CustomEvent('tie:reviews-changed', { detail: { sourceId: page.storageSourceId, pageId: page.id } }))
    close()
  } catch (reason) {
    if (current()) error.value = `${reason instanceof Error ? reason.message : '页面转换失败'}${completed ? '；部分工作区已转换，请重新尝试完成其余工作区' : ''}`
  } finally { password.value = ''; confirmation.value = ''; busy.value = false; emit('busy', false) }
}

watch(scope, close)
watch(() => props.locked, (locked) => { if (!locked) unlockRequired.value = false })
onBeforeUnmount(() => { disposed = true; close() })
defineExpose({ open })
</script>
<template>
  <Teleport to="body">
    <div v-if="unlockRequired" class="protection-unlock-notice" role="status">
      <span>请先解锁页面，再从页面菜单转为普通页面。</span><button type="button" aria-label="关闭解锁提示" @click="unlockRequired = false">×</button>
    </div>
    <div v-if="opened" class="backend-dialog-backdrop" @mousedown.self="!busy && close()" @keydown.stop @keydown.esc="!busy && close()">
      <section class="protection-conversion" role="dialog" aria-modal="true" :aria-label="label">
        <header><strong>{{ label }}</strong><button type="button" aria-label="关闭" :disabled="busy" @click="close">×</button></header>
        <form @submit.prevent="convert"><fieldset :disabled="busy">
          <p>当前页面：{{ page.title || '无标题' }}</p>
          <template v-if="!encrypted">
            <label>密码<input v-model="password" type="password" aria-label="加密密码" autocomplete="new-password" required /></label>
            <label>确认密码<input v-model="confirmation" type="password" aria-label="确认加密密码" autocomplete="new-password" required /></label>
            <label v-if="deviceAvailable" class="remember"><input v-model="remember" type="checkbox" /> 在此设备记住</label>
            <p>当前正文、历史和讨论一起加密。解锁后的用法与普通页面相同；标题和标签保持可见。</p>
          </template>
          <p v-else>转换后，正文、历史和讨论将以普通页面保存，查看和搜索不再需要解锁。</p>
          <p>已连接服务器中的同一页面会一起转换。转换期间请稍候。</p>
          <p v-if="error" class="error" role="alert">{{ error }}</p>
          <button type="submit">{{ busy ? '正在转换…' : label }}</button>
        </fieldset></form>
      </section>
    </div>
  </Teleport>
</template>
<style scoped>
.protection-unlock-notice { position: fixed; z-index: 125; left: 50%; bottom: calc(44px + var(--safe-bottom, 0px)); transform: translateX(-50%); display: flex; gap: 12px; align-items: center; max-width: calc(100vw - 28px); padding: 10px 14px; border: 1px solid var(--border); border-radius: 6px; color: var(--text); background: var(--bg-elevated); box-shadow: 0 5px 18px #0003; font-size: 12px; }
.protection-unlock-notice button { border: 0; background: transparent; color: var(--text-muted); cursor: pointer; }
.protection-conversion { width: min(420px, calc(100vw - 28px)); border: 1px solid var(--border); border-radius: 10px; padding: 20px; background: var(--bg-elevated); color: var(--text); }
header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 18px; }
header button { border: 0; padding: 2px 6px; color: var(--text-subtle); background: transparent; font-size: 20px; }
fieldset { display: grid; gap: 15px; min-width: 0; margin: 0; border: 0; padding: 0; }
label { display: grid; gap: 7px; color: var(--text-muted); font-size: 12px; }
input:not([type=checkbox]) { width: 100%; min-width: 0; border: 1px solid var(--border-strong); border-radius: 5px; padding: 8px 10px; color: var(--text); background: var(--bg-main); font: inherit; }
.remember { display: flex; align-items: center; }
p { margin: 0; color: var(--text-subtle); font-size: 12px; line-height: 1.7; }
button[type=submit] { justify-self: start; border: 0; border-radius: 5px; padding: 8px 15px; color: var(--accent-strong); background: var(--accent-soft); }
.error { color: var(--danger); }
</style>
