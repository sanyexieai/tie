<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { KeyRound } from '@lucide/vue'
import { credentialAccountKey, credentialsService, type CredentialDetail, type CredentialGrant, type CredentialInput, type CredentialMetadata, type CredentialSession, type CredentialTarget, type CredentialUsage } from '@/services/credentials'
import type { BackendMcpToken } from '@/services/backend'

const props = defineProps<{ workspaceId: string; credentialId?: string | null; workspaceName?: string }>()
const emit = defineEmits<{ saved: [credential: CredentialMetadata]; deleted: [id: string]; close: [] }>()
const record = ref<CredentialDetail | null>(null)
const form = reactive({ name: '', description: '', service: '', environment: '', tags: '', actionEnabled: false,
  url: '', method: 'GET' as CredentialTarget['method'], authType: 'bearer' as CredentialTarget['authType'],
  headerName: '', username: '', body: '', responseFields: '' })
const value = ref('')
const showInput = ref(false)
const multiline = ref(false)
const revealedValue = ref('')
const revealed = ref(false)
const loading = ref(false)
const busy = ref(false)
const valueBusy = ref(false)
const notice = ref('')
const error = ref('')
const baseline = ref('')
const agentOpen = ref(false)
const usageOpen = ref(false)
const grantLoading = ref(false)
const grants = ref<CredentialGrant[]>([])
const usage = ref<CredentialUsage[]>([])
const sessions = ref<CredentialSession[]>([])
const tokens = ref<BackendMcpToken[]>([])
const principal = ref('session:current')
const grantHours = ref(1)
const grantUses = ref<'once' | 'repeated'>('once')
let epoch = 0
let disposed = false

function metadataInput(): CredentialInput {
  return { name: form.name.trim(), description: form.description, service: form.service, environment: form.environment,
    tags: form.tags.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean),
    target: form.actionEnabled ? { url: form.url, method: form.method, authType: form.authType,
      headerName: form.authType === 'header' ? form.headerName : undefined,
      username: form.authType === 'basic' ? form.username : undefined,
      body: ['GET', 'HEAD'].includes(form.method) ? undefined : form.body,
      responseFields: form.responseFields.split('\n').map((field) => field.trim()).filter(Boolean),
    } : null,
  }
}
const dirty = computed(() => Boolean(value.value) || JSON.stringify(metadataInput()) !== baseline.value)
const saveDisabled = computed(() => loading.value || busy.value || !form.name.trim()
  || (!props.credentialId && !value.value) || (Boolean(props.credentialId) && !dirty.value))
const grantDisabled = computed(() => busy.value || loading.value || dirty.value || !record.value?.target)

function context() {
  const current = { epoch, account: credentialAccountKey(), workspaceId: props.workspaceId, id: props.credentialId }
  return () => !disposed && current.epoch === epoch && current.account === credentialAccountKey()
    && current.workspaceId === props.workspaceId && current.id === props.credentialId
}
function clearValues() {
  value.value = ''
  revealedValue.value = ''
  revealed.value = false
  showInput.value = false
}
function reset() {
  clearValues()
  record.value = null
  Object.assign(form, { name: '', description: '', service: '', environment: '', tags: '', actionEnabled: false,
    url: '', method: 'GET', authType: 'bearer', headerName: '', username: '', body: '', responseFields: '' })
  baseline.value = JSON.stringify(metadataInput())
  multiline.value = false
  notice.value = ''; error.value = ''
  loading.value = false; busy.value = false; valueBusy.value = false; grantLoading.value = false
  grants.value = []; usage.value = []; sessions.value = []; tokens.value = []
  principal.value = 'session:current'; grantHours.value = 1; grantUses.value = 'once'
  agentOpen.value = false; usageOpen.value = false
}
function applyDetail(detail: CredentialDetail) {
  record.value = detail
  const target = detail.target
  Object.assign(form, { name: detail.name, description: detail.description, service: detail.service, environment: detail.environment,
    tags: detail.tags.join(', '), actionEnabled: Boolean(target), url: target?.url || '', method: target?.method || 'GET',
    authType: target?.authType || 'bearer', headerName: target?.headerName || '', username: target?.username || '',
    body: target?.body || '', responseFields: target?.responseFields?.join('\n') || '' })
  baseline.value = JSON.stringify(metadataInput())
}
async function load() {
  epoch += 1
  reset()
  if (!props.credentialId) return
  const active = context()
  loading.value = true
  try {
    const detail = await credentialsService.get(props.credentialId)
    if (!active()) return
    if (detail.workspaceId !== props.workspaceId) throw new Error('凭据不属于当前工作区')
    applyDetail(detail)
  } catch (reason) { if (active()) error.value = message(reason) }
  finally { if (active()) loading.value = false }
}
async function save() {
  if (saveDisabled.value) return
  const active = context()
  const id = props.credentialId
  const input = metadataInput()
  if (value.value) input.value = value.value
  revealed.value = false; revealedValue.value = ''
  busy.value = true; error.value = ''; notice.value = ''
  try {
    const saved = id ? await credentialsService.update(id, input)
      : await credentialsService.create({ ...input, workspaceId: props.workspaceId, value: value.value })
    if (!active()) return
    clearValues()
    record.value = { ...saved, target: input.target ?? null }
    baseline.value = JSON.stringify(metadataInput())
    notice.value = id ? '已保存，原有授权已失效；需要使用时请重新授权。' : '已保存凭据。'
    grants.value = []
    emit('saved', saved)
  } catch (reason) { if (active()) error.value = message(reason) }
  finally { if (active()) busy.value = false }
}
async function reveal(mode: 'show' | 'copy') {
  if (!props.credentialId || valueBusy.value) return
  if (mode === 'show' && revealed.value) { revealed.value = false; revealedValue.value = ''; return }
  const active = context()
  valueBusy.value = true; error.value = ''; notice.value = ''
  try {
    const plaintext = await credentialsService.reveal(props.credentialId)
    if (!active()) return
    if (mode === 'show') { revealedValue.value = plaintext; revealed.value = true }
    else {
      if ('__TAURI_INTERNALS__' in window || '__TAURI__' in window) {
        const { writeText } = await import('@tauri-apps/plugin-clipboard-manager')
        if (!active()) return
        await writeText(plaintext)
      } else await navigator.clipboard.writeText(plaintext)
      if (active()) notice.value = '密钥已复制。'
    }
  } catch (reason) { if (active()) error.value = message(reason) }
  finally { if (active()) valueBusy.value = false }
}
async function remove() {
  if (!props.credentialId || busy.value || !window.confirm(`删除凭据“${form.name}”？相关授权也会失效。`)) return
  const active = context()
  const id = props.credentialId
  busy.value = true; error.value = ''
  clearValues()
  try {
    await credentialsService.remove(id)
    if (active()) emit('deleted', id)
  } catch (reason) { if (active()) error.value = message(reason) }
  finally { if (active()) busy.value = false }
}
async function loadGrants() {
  if (!record.value || grantLoading.value) return
  const active = context()
  const secret = record.value
  grantLoading.value = true; error.value = ''
  try {
    const result = await Promise.all([credentialsService.listGrants(props.workspaceId, secret.secretRef), credentialsService.listSessions(), credentialsService.listTokens(props.workspaceId)])
    if (!active()) return
    ;[grants.value, sessions.value, tokens.value] = result
  } catch (reason) { if (active()) error.value = message(reason) }
  finally { if (active()) grantLoading.value = false }
}
async function loadUsage() {
  if (!record.value) return
  const active = context()
  try {
    const result = await credentialsService.listUsage(props.workspaceId, record.value.secretRef)
    if (active()) usage.value = result
  } catch (reason) { if (active()) error.value = message(reason) }
}
async function createGrant() {
  if (!props.credentialId || grantDisabled.value) return
  const active = context()
  const split = principal.value.indexOf(':')
  const type = principal.value.slice(0, split) as 'session' | 'mcp-token'
  const id = principal.value.slice(split + 1)
  busy.value = true; error.value = ''
  try {
    await credentialsService.createGrant(props.credentialId, { principal: { type, id }, maxUses: grantUses.value === 'once' ? 1 : null,
      expiresAt: new Date(Date.now() + grantHours.value * 60 * 60 * 1000).toISOString() })
    if (!active()) return
    notice.value = '已授权此操作。'
    await loadGrants()
  } catch (reason) { if (active()) error.value = message(reason) }
  finally { if (active()) busy.value = false }
}
async function revokeGrant(id: string) {
  const active = context()
  busy.value = true; error.value = ''
  try {
    await credentialsService.revokeGrant(id)
    if (!active()) return
    notice.value = '已撤销授权。'
    await loadGrants()
  } catch (reason) { if (active()) error.value = message(reason) }
  finally { if (active()) busy.value = false }
}
function principalLabel(item: CredentialGrant['principal'] | null) {
  if (!item) return '未知调用者'
  if (item.type === 'mcp-token') return tokens.value.find((token) => token.id === item.id)?.name || `MCP 令牌 · ${item.id.slice(0, 10)}`
  const session = sessions.value.find((session) => session.id === item.id)
  return session?.current ? '当前登录会话' : `登录会话 · ${item.id.slice(0, 10)}`
}
function grantStatus(item: CredentialGrant) {
  if (item.revokedAt) return '已撤销'
  if (item.version !== record.value?.version) return '凭据已更新'
  if (Date.parse(item.expiresAt) <= Date.now()) return '已过期'
  if (item.maxUses !== null && item.useCount >= item.maxUses) return '已用尽'
  return '已授权'
}
function message(reason: unknown) { return reason instanceof Error ? reason.message : '凭据操作失败，请重试' }
function formatTime(at: string) { return new Date(at).toLocaleString() }
function onKey(event: KeyboardEvent) {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
    event.preventDefault(); event.stopImmediatePropagation()
    void save()
  }
}
function beforeUnload(event: BeforeUnloadEvent) { if (dirty.value) { event.preventDefault(); event.returnValue = '' } }

watch([() => props.workspaceId, () => props.credentialId, credentialAccountKey], () => { void load() }, { immediate: true, flush: 'sync' })
watch(agentOpen, (open) => { if (open && record.value) void loadGrants() })
watch(usageOpen, (open) => { if (open && record.value) void loadUsage() })
onMounted(() => { window.addEventListener('keydown', onKey, true); window.addEventListener('beforeunload', beforeUnload) })
onBeforeUnmount(() => {
  disposed = true; epoch += 1; reset()
  window.removeEventListener('keydown', onKey, true); window.removeEventListener('beforeunload', beforeUnload)
})
</script>

<template>
  <main class="credential-page" aria-label="凭据页面">
    <div class="credential-page-topline">
      <span class="credential-page-caption"><KeyRound :size="14" aria-hidden="true" /> 凭据页面 <span v-if="workspaceName" class="credential-workspace">· {{ workspaceName }}</span></span>
      <button type="button" @click="emit('close')">关闭</button>
    </div>
    <div class="credential-page-content">
      <div class="credential-page-status" aria-live="polite">{{ loading ? '正在打开凭据…' : dirty ? '未保存' : credentialId ? '已保存' : '新建凭据' }}</div>
      <form class="credential-form" @submit.prevent="save">
        <fieldset :disabled="loading || busy">
        <input v-model="form.name" class="credential-title" aria-label="凭据名称" placeholder="凭据名称" maxlength="120" required :disabled="loading || busy" />
        <p class="credential-hint">密钥独立加密保存，不进入普通文档、页面历史或导出。</p>
        <label class="credential-label" for="credential-value">密钥 <small v-if="credentialId">填写新值可替换；留空保留原值</small></label>
        <textarea v-if="multiline" id="credential-value" v-model="value" aria-label="密钥" rows="6" autocomplete="off" spellcheck="false" :disabled="loading || busy" placeholder="粘贴多行敏感内容"></textarea>
        <input v-else id="credential-value" v-model="value" aria-label="密钥" :type="showInput ? 'text' : 'password'" autocomplete="new-password" :disabled="loading || busy" :required="!credentialId" :placeholder="credentialId ? '已保存 · 留空保留' : '输入或粘贴密钥'" />
        <div class="credential-value-actions">
          <button v-if="!multiline" type="button" @click="showInput = !showInput">{{ showInput ? '隐藏输入' : '显示输入' }}</button>
          <label><input v-model="multiline" type="checkbox" /> 多行输入</label>
          <template v-if="credentialId">
            <button type="button" :disabled="valueBusy || loading" @click="reveal('show')">{{ revealed ? '隐藏密钥' : '查看密钥' }}</button>
            <button type="button" :disabled="valueBusy || loading" @click="reveal('copy')">复制密钥</button>
          </template>
        </div>
        <pre v-if="revealed" class="credential-revealed" data-credential-value>{{ revealedValue }}</pre>
        <details class="credential-details">
          <summary>分类与说明</summary>
          <div class="credential-details-body">
            <div class="credential-split"><label>服务<input v-model="form.service" placeholder="例如 GitHub" maxlength="100" /></label><label>环境<input v-model="form.environment" placeholder="例如 production" maxlength="100" /></label></div>
            <label>标签<input v-model="form.tags" placeholder="用逗号分隔" /></label>
            <label>说明<textarea v-model="form.description" rows="3" placeholder="用途、归属或使用提示" maxlength="2000"></textarea></label>
            <small class="credential-hint">说明可被 Agent 搜索，敏感值请只填在密钥区。</small>
          </div>
        </details>
        <details class="credential-details" :open="agentOpen" @toggle="agentOpen = ($event.target as HTMLDetailsElement).open">
          <summary>Agent 使用与授权</summary>
          <div class="credential-details-body">
            <label class="credential-action-toggle"><input v-model="form.actionEnabled" type="checkbox" /> 配置固定 HTTP 操作</label>
            <p v-if="!form.actionEnabled" class="credential-hint">只保存凭据无需配置。需要 Agent 调用服务时，再设置操作和授权。</p>
            <template v-else>
              <label>固定 HTTPS 地址<input v-model="form.url" type="url" required pattern="https://.+" placeholder="https://api.example.com/status" /></label>
              <div class="credential-split">
                <label>请求方法<select v-model="form.method"><option v-for="method in ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']" :key="method">{{ method }}</option></select></label>
                <label>认证方式<select v-model="form.authType"><option value="bearer">Bearer</option><option value="header">自定义请求头</option><option value="basic">Basic</option></select></label>
              </div>
              <label v-if="form.authType === 'header'">请求头名称<input v-model="form.headerName" required placeholder="X-API-Key" /></label>
              <label v-if="form.authType === 'basic'">用户名<input v-model="form.username" autocomplete="off" /></label>
              <label v-if="!['GET', 'HEAD'].includes(form.method)">固定请求内容<textarea v-model="form.body" rows="3"></textarea></label>
              <label>允许返回的字段<textarea v-model="form.responseFields" rows="2" placeholder="每行一个 JSON 字段路径；留空仅返回 HTTP 状态"></textarea></label>
              <p class="credential-hint">Agent 使用已授权的固定操作，不读取密钥原文。</p>
            </template>
            <section v-if="credentialId" class="credential-grants" aria-label="凭据授权">
              <p v-if="dirty || !record?.target" class="credential-hint">保存固定 HTTP 操作后即可授权。</p>
              <div class="credential-split">
                <label>授权给<select v-model="principal" :disabled="grantDisabled"><option value="session:current">当前登录会话</option><option v-for="session in sessions.filter((item) => !item.current)" :key="session.id" :value="`session:${session.id}`">登录会话 · {{ session.id.slice(0, 10) }}</option><option v-for="token in tokens" :key="token.id" :value="`mcp-token:${token.id}`">MCP 令牌 · {{ token.name }}</option></select></label>
                <label>使用次数<select v-model="grantUses" :disabled="grantDisabled"><option value="once">仅一次</option><option value="repeated">有效期内持续</option></select></label>
                <label>有效期<select v-model="grantHours" :disabled="grantDisabled"><option :value="1">1 小时</option><option :value="24">24 小时</option><option :value="168">7 天</option></select></label>
              </div>
              <small class="credential-principal-id">{{ principal }}</small>
              <button type="button" class="credential-secondary" :disabled="grantDisabled || grantLoading" @click="createGrant">授权此操作</button>
              <p v-if="grantLoading" class="credential-hint">正在读取授权…</p>
              <p v-else-if="!grants.length" class="credential-hint">还没有操作授权。</p>
              <div v-for="grant in grants" :key="grant.id" class="credential-record">
                <div><strong>{{ principalLabel(grant.principal) }}</strong><small>{{ grantStatus(grant) }} · {{ grant.useCount }} / {{ grant.maxUses === null ? '持续' : grant.maxUses }} · {{ formatTime(grant.expiresAt) }} 到期</small></div>
                <button v-if="!grant.revokedAt" type="button" :disabled="busy" @click="revokeGrant(grant.id)">撤销授权</button>
              </div>
            </section>
          </div>
        </details>
        <div class="credential-save-row"><button type="submit" class="credential-primary" :disabled="saveDisabled">{{ busy ? '保存中…' : '保存凭据' }}</button><small>Ctrl / ⌘ + S</small></div>
        </fieldset>
      </form>
      <p v-if="error" class="credential-error" role="alert">{{ error }}</p>
      <p v-if="notice" class="credential-notice" role="status">{{ notice }}</p>
      <details v-if="credentialId" class="credential-details" :open="usageOpen" @toggle="usageOpen = ($event.target as HTMLDetailsElement).open">
        <summary>使用记录</summary>
        <div class="credential-details-body">
          <button type="button" class="credential-secondary" @click="loadUsage">刷新记录</button>
          <p v-if="!usage.length" class="credential-hint">还没有使用记录。</p>
          <div v-for="entry in usage" :key="entry.id" class="credential-record"><div><strong>{{ ({ started: '执行中', succeeded: '成功', failed: '失败', denied: '拒绝' })[entry.status] }}{{ entry.httpStatus ? ` · HTTP ${entry.httpStatus}` : '' }}</strong><small>{{ formatTime(entry.at) }} · {{ principalLabel(entry.principal) }}</small><small v-if="entry.reason">{{ entry.reason }}</small></div></div>
        </div>
      </details>
      <footer v-if="record" class="credential-page-footer"><small>版本 {{ record.version }} · {{ formatTime(record.updatedAt) }}</small><button type="button" class="credential-delete" :disabled="busy" @click="remove">删除凭据</button></footer>
    </div>
  </main>
</template>

<style scoped>
.credential-page { grid-area: main; flex: 1; min-width: 0; height: 100%; overflow-y: auto; color: var(--text); background: var(--bg-main); }
.credential-page-topline { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 14px 24px; border-bottom: 1px solid var(--border); color: var(--text-muted); font-size: 12px; }
.credential-page-caption { display: flex; align-items: center; gap: 6px; }
.credential-page-topline button, .credential-value-actions button, .credential-record button, .credential-delete { border: 0; padding: 4px 6px; background: transparent; color: var(--text-muted); cursor: pointer; }
.credential-workspace { color: var(--text-faint); }
.credential-page-content { max-width: 760px; margin: 0 auto; padding: 38px 42px 48px; }
.credential-page-status { color: var(--text-faint); font-size: 11px; margin-bottom: 8px; }
.credential-hint { color: var(--text-muted); font-size: 12px; line-height: 1.6; }
.credential-form fieldset { border: 0; padding: 0; margin: 0; min-width: 0; }
.credential-form > fieldset > .credential-hint { margin: 10px 0 28px; }
.credential-label, .credential-details-body > label, .credential-split > label { display: flex; flex-direction: column; gap: 7px; font-size: 13px; }
.credential-label { margin-bottom: 9px; }
.credential-label small { color: var(--text-faint); font-size: 11px; }
.credential-page input:not([type="checkbox"]), .credential-page textarea, .credential-page select { box-sizing: border-box; width: 100%; min-width: 0; padding: 9px 11px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg-elevated); color: var(--text); font: inherit; outline: none; }
.credential-page input.credential-title { width: 100%; font-size: 30px; font-weight: 650; padding: 4px 0; border: 0; background: transparent; }
.credential-page input:focus, .credential-page textarea:focus, .credential-page select:focus { border-color: var(--accent); }
.credential-page textarea { resize: vertical; line-height: 1.6; }
.credential-value-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; font-size: 11px; margin: 9px 0 22px; color: var(--text-muted); }
.credential-value-actions label { display: flex; align-items: center; gap: 4px; }
.credential-revealed { padding: 13px; border: 1px solid var(--border); border-radius: 6px; font: 12px/1.7 monospace; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 240px; overflow: auto; }
.credential-details { border-top: 1px solid var(--border); margin-top: 13px; }
.credential-details summary { padding: 15px 0; color: var(--text-muted); cursor: pointer; font-size: 13px; }
.credential-details-body { display: flex; flex-direction: column; gap: 15px; padding-bottom: 18px; }
.credential-split { display: flex; gap: 12px; }
.credential-split > label { flex: 1; min-width: 0; }
.credential-action-toggle { flex-direction: row !important; align-items: center; }
.credential-grants { display: flex; flex-direction: column; gap: 13px; }
.credential-save-row { display: flex; align-items: center; gap: 13px; margin: 25px 0 8px; }
.credential-primary, .credential-secondary { align-self: flex-start; padding: 8px 15px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg-elevated); color: var(--text); cursor: pointer; }
.credential-primary { background: var(--accent); color: var(--bg-main); border-color: var(--accent); }
.credential-page button:disabled { opacity: .45; cursor: default; }
.credential-save-row small, .credential-principal-id { color: var(--text-faint); font-size: 10px; overflow-wrap: anywhere; }
.credential-error { color: #c46b5a; font-size: 12px; }
.credential-notice { color: var(--text-muted); font-size: 12px; }
.credential-record { display: flex; align-items: center; justify-content: space-between; gap: 14px; border-top: 1px solid var(--border); padding: 10px 0; font-size: 12px; }
.credential-record > div { display: flex; flex-direction: column; gap: 5px; }
.credential-record small, .credential-page-footer small { color: var(--text-faint); font-size: 11px; }
.credential-page-footer { display: flex; justify-content: space-between; align-items: center; margin-top: 30px; }
.credential-delete { color: #c46b5a; font-size: 11px; }
@media (max-width: 720px) { .credential-page-content { padding: 24px 18px; } .credential-page-topline { padding: 12px 18px; } .credential-split { flex-wrap: wrap; } .credential-split > label { flex-basis: 120px; } }
</style>
