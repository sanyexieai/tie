<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { LockKeyhole } from '@lucide/vue'
import TiptapEditor from '@/components/TiptapEditor.vue'
import { useWorkspaceStore } from '@/stores/workspace'
import { decryptMarkdown, encryptMarkdown, getWorkspaceEncryptionKey, importEncryptionPassword, isEncryptedMarkdown, lockWorkspaceEncryption, setWorkspaceEncryptionKey } from '@/services/encrypted-markdown'
import type { Page, PageRevision } from '@/types'

const props = defineProps<{ page?: Page | null; sourceId: string; mobileLayout?: boolean }>()
const emit = defineEmits<{ 'toggle-sidebar': []; 'toggle-focus': []; 'mobile-back': [] }>()
const store = useWorkspaceStore()
const title = ref(props.page?.title ?? '')
const markdown = ref('')
const password = ref('')
const confirmation = ref('')
const selectedSourceId = ref(props.page?.storageSourceId || props.sourceId)
const sourceMode = ref(false)
const unlocked = ref(false)
const opening = ref(false)
const saving = ref(false)
const error = ref('')
const baseline = ref('')
const richEditor = ref<InstanceType<typeof TiptapEditor> | null>(null)
const historyOpen = ref(false)
const revisions = ref<PageRevision[]>([])
const preview = ref<{ revision: PageRevision; markdown: string } | null>(null)
const historyLoading = ref(false)
const remoteChanged = ref(false)
const sources = computed(() => store.allSources.filter((source) => !source.temporary && source.available !== false))
const source = computed(() => sources.value.find((item) => item.id === selectedSourceId.value))
const isNew = computed(() => !props.page)
const dirty = computed(() => unlocked.value && JSON.stringify([title.value, markdown.value]) !== baseline.value)
const status = computed(() => opening.value ? '正在解锁…' : saving.value ? '保存中…' : error.value ? '操作失败' : !unlocked.value ? '已锁定' : dirty.value ? '未保存' : props.page ? '已保存' : '新建页面')
const wordCount = computed(() => markdown.value.replace(/\s/g, '').length)
let key: CryptoKey | undefined
let lastCiphertext = props.page?.markdown ?? ''
let disposed = false
let generation = 0
let saveTimer: ReturnType<typeof setTimeout> | undefined
type Draft = { title: string; markdown: string; key: CryptoKey; page: Page | null; sourceId: string }
let pendingDraft: Draft | null = null
let saveTask: Promise<boolean> | null = null
let savingFingerprint = ''
let savingTitle = ''
let remoteDecrypting = 0

async function openWithKey(candidate: CryptoKey) {
  const current = ++generation
  const wasUnlocked = unlocked.value
  const previousDraft = JSON.stringify([title.value, markdown.value])
  const body = props.page ? await decryptMarkdown(props.page.markdown, candidate) : ''
  if (disposed || current !== generation) return
  if (wasUnlocked && previousDraft !== JSON.stringify([title.value, markdown.value])) {
    remoteChanged.value = true
    error.value = '页面已更新，重新载入后再编辑；当前草稿尚未覆盖新版本。'
    return
  }
  key = candidate
  title.value = props.page?.title ?? title.value
  markdown.value = body
  baseline.value = JSON.stringify([title.value, body])
  unlocked.value = true
  remoteChanged.value = false
  setWorkspaceEncryptionKey(selectedSourceId.value, candidate)
}

async function unlock() {
  error.value = ''
  if (!selectedSourceId.value) { error.value = '请先选择一个工作区'; return }
  if (isNew.value && password.value !== confirmation.value) { error.value = '两次密码不一致'; return }
  opening.value = true
  try { await openWithKey(await importEncryptionPassword(password.value)) }
  catch (reason) { if (!disposed) error.value = reason instanceof Error ? reason.message : '无法解锁页面' }
  finally { password.value = ''; confirmation.value = ''; opening.value = false }
}

function changed() {
  if (saveTimer) clearTimeout(saveTimer)
  if (remoteDecrypting) {
    remoteChanged.value = true
    error.value = '页面已更新，重新载入后再编辑；当前草稿尚未覆盖新版本。'
    return
  }
  if (props.page) saveTimer = setTimeout(() => { void save() }, 650)
}

function save(): Promise<boolean> {
  if (saveTimer) clearTimeout(saveTimer)
  if (!unlocked.value || !key || (!dirty.value && props.page)) return saveTask ?? Promise.resolve(true)
  if (remoteChanged.value) return Promise.resolve(false)
  const name = title.value.trim() || '无标题'
  if (saveTask && JSON.stringify([name, markdown.value]) === savingFingerprint && !pendingDraft) return saveTask
  pendingDraft = { title: name, markdown: markdown.value, key, page: props.page ?? null, sourceId: selectedSourceId.value }
  if (!saveTask) saveTask = flushSaves().finally(() => { saveTask = null })
  return saveTask
}

async function flushSaves() {
  saving.value = true
  error.value = ''
  try {
    while (pendingDraft) {
      const draft: Draft = pendingDraft
      pendingDraft = null
      savingFingerprint = JSON.stringify([draft.title, draft.markdown])
      savingTitle = draft.title
      const ciphertext = await encryptMarkdown(draft.markdown, draft.key)
      lastCiphertext = ciphertext
      if (draft.page) await store.persist({ ...draft.page, title: draft.title, markdown: ciphertext })
      else {
        title.value = draft.title
        baseline.value = savingFingerprint
        const created = await store.createEncryptedPage(draft.title, ciphertext, draft.sourceId)
        if (!disposed) { unregisterSave(); store.openPage(created.id) }
      }
      if (!disposed) baseline.value = JSON.stringify([draft.title, draft.markdown])
    }
    return true
  } catch (reason) {
    pendingDraft = null
    if (!disposed) error.value = reason instanceof Error ? reason.message : '加密页面保存失败'
    return false
  } finally { saving.value = false; savingFingerprint = ''; savingTitle = '' }
}

async function lock() {
  if (!await save()) return
  lockWorkspaceEncryption(selectedSourceId.value)
  clearPlaintext()
}

function clearPlaintext() {
  generation += 1
  unlocked.value = false
  key = undefined
  markdown.value = ''; password.value = ''; confirmation.value = ''; baseline.value = ''
  preview.value = null; historyOpen.value = false
}

async function openHistory() {
  if (!props.page) return
  historyOpen.value = !historyOpen.value
  if (!historyOpen.value) { preview.value = null; return }
  historyLoading.value = true; error.value = ''
  try { const result = await store.listPageRevisions(props.page.id); if (!disposed) revisions.value = result }
  catch (reason) { if (!disposed) error.value = reason instanceof Error ? reason.message : '无法读取历史' }
  finally { historyLoading.value = false }
}

async function previewRevision(revision: PageRevision) {
  if (!props.page || !key) return
  const current = generation
  error.value = ''
  try {
    const snapshot = await store.readPageRevision(props.page.id, revision.id)
    if (!snapshot || !isEncryptedMarkdown(snapshot.markdown)) throw new Error('该版本不是加密页面，无法在这里恢复')
    const body = await decryptMarkdown(snapshot.markdown, key)
    if (!disposed && unlocked.value && current === generation) preview.value = { revision, markdown: body }
  } catch (reason) { if (!disposed) error.value = reason instanceof Error ? reason.message : '无法读取历史' }
}

async function restoreRevision() {
  if (!props.page || !preview.value || !await save()) return
  const current = generation
  error.value = ''
  try {
    const snapshot = await store.readPageRevision(props.page.id, preview.value.revision.id)
    if (!snapshot || !isEncryptedMarkdown(snapshot.markdown)) throw new Error('无法恢复未加密的版本')
    const body = await decryptMarkdown(snapshot.markdown, key!)
    if (disposed || !unlocked.value || current !== generation) return
    lastCiphertext = snapshot.markdown
    await store.persist({ ...props.page, markdown: snapshot.markdown, title: snapshot.title, tags: snapshot.tags })
    if (!disposed && unlocked.value && current === generation) {
      title.value = snapshot.title; markdown.value = body; lastCiphertext = snapshot.markdown
      baseline.value = JSON.stringify([snapshot.title, body]); preview.value = null; historyOpen.value = false
    }
  } catch (reason) { if (!disposed) error.value = reason instanceof Error ? reason.message : '恢复失败' }
}

function onKey(event: KeyboardEvent) {
  if (!(event.ctrlKey || event.metaKey)) return
  if (event.key.toLowerCase() === 's') { event.preventDefault(); event.stopImmediatePropagation(); void save() }
  if (event.key === '/') { event.preventDefault(); event.stopImmediatePropagation(); if (unlocked.value) sourceMode.value = !sourceMode.value }
}
function beforeUnload(event: BeforeUnloadEvent) { if (dirty.value || saving.value) { event.preventDefault(); event.returnValue = '' } }
const unregisterSave = store.registerEditorSaveHandler(save)
watch(() => props.page?.title, (name) => {
  if (name === undefined || name === title.value) return
  if (saving.value && name === savingTitle && props.page?.markdown === lastCiphertext) return
  if (dirty.value || saving.value) {
    remoteChanged.value = true
    error.value = '页面标题已更新，请重新载入后继续编辑。'
  } else {
    title.value = name
    if (unlocked.value) baseline.value = JSON.stringify([name, markdown.value])
  }
})
watch(() => props.page?.markdown, (ciphertext) => {
  if (!ciphertext || ciphertext === lastCiphertext || !unlocked.value) return
  if (dirty.value || saving.value) {
    remoteChanged.value = true
    error.value = '页面已更新，重新载入后再编辑；当前草稿尚未覆盖新版本。'
  } else if (key) {
    remoteDecrypting += 1
    void openWithKey(key).catch((reason) => {
      if (disposed) return
      if (dirty.value) remoteChanged.value = true
      else clearPlaintext()
      error.value = reason instanceof Error ? reason.message : '无法解锁更新后的页面'
    }).finally(() => { remoteDecrypting -= 1 })
  }
})
onMounted(async () => {
  window.addEventListener('keydown', onKey, true)
  window.addEventListener('beforeunload', beforeUnload)
  const candidate = getWorkspaceEncryptionKey(selectedSourceId.value)
  if (candidate) {
    opening.value = true
    try { await openWithKey(candidate) }
    catch { if (!disposed) error.value = '请输入此页面的解锁密码' }
    finally { opening.value = false }
  }
})
onBeforeUnmount(() => {
  if (dirty.value && JSON.stringify([title.value.trim() || '无标题', markdown.value]) !== savingFingerprint) void save()
  disposed = true
  if (saveTimer) clearTimeout(saveTimer)
  unregisterSave()
  clearPlaintext()
  window.removeEventListener('keydown', onKey, true)
  window.removeEventListener('beforeunload', beforeUnload)
})
</script>

<template>
  <main class="editor-pane encrypted-document-pane" :class="{ 'mobile-editor-pane': mobileLayout }" aria-label="加密 Markdown 页面">
    <header class="editor-header">
      <button v-if="mobileLayout" type="button" class="mobile-editor-back" aria-label="返回列表" @click="emit('mobile-back')">←</button>
      <nav v-if="!mobileLayout" class="breadcrumbs" aria-label="页面层级"><span>{{ source?.name || '我的知识库' }}</span><span>›</span><span>{{ title || '新建凭据页面' }}</span></nav>
      <h1 v-else class="mobile-editor-title">{{ title || '新建凭据页面' }}</h1>
      <div class="save-state">
        <span class="save-dot" :class="{ synced: unlocked && !dirty, pending: dirty, saving: saving || opening, error: Boolean(error) }"></span>
        <span aria-live="polite">{{ status }}</span>
        <button v-if="unlocked" type="button" class="history-button" title="锁定加密页面" aria-label="锁定页面" @click="lock"><LockKeyhole :size="14" /></button>
        <button v-if="page && unlocked" type="button" class="history-button" title="页面版本历史" aria-label="页面版本历史" @click="openHistory">◷</button>
        <button v-if="unlocked" type="button" class="encrypted-save" :disabled="saving || (!dirty && !isNew)" @click="save">保存</button>
      </div>
    </header>
    <aside v-if="historyOpen" class="encrypted-history" aria-label="加密页面历史">
      <header><strong>页面历史</strong><button type="button" aria-label="关闭历史" @click="historyOpen = false; preview = null">×</button></header>
      <p v-if="historyLoading">正在读取…</p><p v-else-if="!revisions.length">尚无历史版本</p>
      <button v-for="revision in revisions" :key="revision.id" type="button" @click="previewRevision(revision)">{{ revision.title }} · {{ new Date(revision.savedAt).toLocaleString() }}</button>
      <template v-if="preview"><pre>{{ preview.markdown }}</pre><button type="button" @click="restoreRevision">恢复此版本</button></template>
    </aside>
    <div class="editor-scroll">
      <article class="document" :inert="isNew && saving">
        <div class="document-title-row"><span class="document-page-icon" aria-hidden="true"><LockKeyhole :size="27" /></span><input v-model="title" class="document-title" aria-label="页面标题" placeholder="无标题" :disabled="!unlocked && !isNew" @input="changed" /></div>
        <p class="encrypted-caption">加密 Markdown <span>· 标题用于目录搜索，正文加密保存</span></p>
        <form v-if="!unlocked" class="encrypted-unlock" @submit.prevent="unlock">
          <label v-if="isNew">工作区<select v-model="selectedSourceId" aria-label="加密页面工作区"><option v-for="item in sources" :key="item.id" :value="item.id">{{ item.name }}</option></select></label>
          <p>{{ isNew ? '设置解锁密码后，就可以像普通页面一样编写正文。' : '输入密码，打开这篇加密文档。' }}</p>
          <label>解锁密码<input v-model="password" aria-label="解锁密码" type="password" :autocomplete="isNew ? 'new-password' : 'current-password'" required :disabled="opening" /></label>
          <label v-if="isNew">确认密码<input v-model="confirmation" aria-label="确认密码" type="password" autocomplete="new-password" required :disabled="opening" /></label>
          <small v-if="isNew">其他设备使用相同密码解锁。密码不会随工作区保存，遗失后无法恢复正文。</small>
          <button type="submit" :disabled="opening || !selectedSourceId">{{ opening ? '正在解锁…' : isNew ? '开始编写' : '解锁页面' }}</button>
        </form>
        <template v-else>
          <textarea v-if="sourceMode" v-model="markdown" class="source-editor" aria-label="Markdown 源码" spellcheck="false" @input="changed"></textarea>
          <TiptapEditor v-else ref="richEditor" :model-value="markdown" :pages="store.pages" :sources="[]" :page-id="page?.id || 'encrypted-draft'" :spellcheck="false" private-document :background-started="false" @update:model-value="markdown = $event; changed()" @navigate="store.openPage($event)" />
        </template>
        <p v-if="error" class="encrypted-error" role="alert">{{ error }} <button v-if="remoteChanged && key" type="button" @click="openWithKey(key)">放弃草稿并重新载入</button></p>
      </article>
    </div>
    <footer class="editor-statusbar">
      <button v-if="!mobileLayout" type="button" @click="emit('toggle-sidebar')">▤ 侧栏</button>
      <button v-if="!mobileLayout" type="button" @click="emit('toggle-focus')">⛶ 专注</button>
      <template v-if="unlocked"><button type="button" :disabled="sourceMode" @click="richEditor?.undo()">↶ 撤销</button><button type="button" :disabled="sourceMode" @click="richEditor?.redo()">↷ 重做</button><button type="button" :class="{ active: sourceMode }" @click="sourceMode = !sourceMode">&lt;/&gt; 源码</button><span class="word-count">字数 {{ wordCount }}</span></template>
      <span class="encrypted-status-label"><LockKeyhole :size="11" /> {{ unlocked ? '加密保存' : '已锁定' }}</span>
    </footer>
  </main>
</template>

<style scoped>
.document-page-icon { display: flex; align-items: center; justify-content: center; }
.encrypted-caption { display: flex; flex-wrap: wrap; gap: 6px; margin: 14px 0 32px 49px; color: var(--text-faint); font-size: 11px; line-height: 1.6; }
.encrypted-caption span { color: var(--text-subtle); }
.encrypted-unlock { display: flex; flex-direction: column; align-items: flex-start; gap: 16px; width: min(100%, 360px); margin: 12px 0 0 49px; }
.encrypted-unlock p { margin: 0; color: var(--text-muted); font-size: 13px; line-height: 1.7; }
.encrypted-unlock label { display: grid; gap: 7px; width: 100%; color: var(--text-muted); font-size: 12px; }
.encrypted-unlock input, .encrypted-unlock select { min-width: 0; width: 100%; border: 1px solid var(--border-strong); border-radius: 6px; padding: 9px 10px; color: var(--text); background: var(--bg-elevated); font: inherit; outline: none; }
.encrypted-unlock input:focus { border-color: var(--accent); }
.encrypted-unlock small { color: var(--text-faint); font-size: 11px; line-height: 1.6; }
.encrypted-unlock button { border: 0; border-radius: 5px; padding: 8px 14px; color: var(--accent-strong); background: var(--accent-soft); font-size: 12px; }
.save-state .encrypted-save { border-radius: 4px; padding: 4px 9px; color: var(--accent-strong); background: var(--accent-soft); font-size: 11px; }
.encrypted-document-pane button:disabled { opacity: .45; cursor: default; }
.encrypted-status-label { display: flex; align-items: center; gap: 5px; margin-left: auto; padding: 0 5px; white-space: nowrap; }
.encrypted-error { color: var(--danger); font-size: 12px; line-height: 1.6; }
.encrypted-history { position: absolute; z-index: 10; top: 52px; right: 20px; display: grid; gap: 8px; width: min(440px, calc(100% - 32px)); max-height: 70%; overflow: auto; padding: 12px; border: 1px solid var(--border); border-radius: 7px; background: var(--bg-elevated); box-shadow: 0 8px 24px var(--shadow); font-size: 12px; }
.encrypted-history header { display: flex; align-items: center; justify-content: space-between; }
.encrypted-history button { border: 0; border-radius: 4px; padding: 7px; color: var(--text-muted); background: transparent; text-align: left; }
.encrypted-history button:hover { background: var(--bg-hover); }
.encrypted-history pre { max-height: 260px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; }
@media (max-width: 720px) { .encrypted-caption, .encrypted-unlock { margin-left: 0; } .encrypted-history { top: 90px; } .encrypted-caption { margin-bottom: 22px; } }
</style>
