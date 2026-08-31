<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import TiptapEditor from '@/components/TiptapEditor.vue'
import {
  addSkillScanRoot,
  listExtraSkillScanRoots,
  listSkillScanRoots,
  pickSkillScanDirectory,
  readSkillFile,
  removeSkillScanRoot,
  scanSkills,
  writeSkillFile,
  type ScannedSkill,
} from '@/services/codex-mcp'
import { useWorkspaceStore } from '@/stores/workspace'
import type { Page } from '@/types'

const store = useWorkspaceStore()
const isDesktop = '__TAURI_INTERNALS__' in window
const fullMarkdown = ref('')
const bodyMarkdown = ref('')
const frontmatter = ref('')
const skillName = ref('')
const skillDescription = ref('')
const loadedPath = ref<string | null>(null)
const hasUnsavedChanges = ref(false)
const saveError = ref<string | null>(null)
const busy = ref(false)
const notice = ref('')
const scanBusy = ref(false)
const scanError = ref('')
const scanned = ref<ScannedSkill[]>([])
const scanRoots = ref<string[]>([])
const customRoots = ref<string[]>([])
const rootsOpen = ref(false)
const sourceEditor = ref<HTMLTextAreaElement | null>(null)
const richEditor = ref<{ undo: () => void; redo: () => void } | null>(null)
let autoSaveTimer: number | undefined
let changeRevision = 0

const active = computed(() => store.activeSkill)
const status = computed(() => (
  busy.value ? '保存中…' : saveError.value ? '保存失败' : hasUnsavedChanges.value ? '未保存' : '已保存'
))
const wordCount = computed(() => bodyMarkdown.value.replace(/\s+/g, '').length)
const fakePageId = computed(() => `skill_${active.value?.id ?? 'none'}`)
const pendingScan = computed(() => scanned.value.filter((item) => !item.connected))

function shortenPath(path: string) {
  return path
    .replace(/^\/home\/[^/]+/, '~')
    .replace(/^\/Users\/[^/]+/, '~')
}

function normalizeNewlines(content: string) {
  return content.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

function splitSkillMarkdown(content: string) {
  const text = normalizeNewlines(content)
  if (!text.startsWith('---\n') && text !== '---') {
    return { frontmatter: '', body: text, name: '', description: '' }
  }
  const end = text.indexOf('\n---\n', 4)
  const endAtEof = text.indexOf('\n---', 4)
  const closeAt = end !== -1 ? end : (endAtEof !== -1 && endAtEof + 4 === text.length ? endAtEof : -1)
  if (closeAt === -1) {
    return { frontmatter: '', body: text, name: '', description: '' }
  }
  const frontmatter = text.slice(0, closeAt + 4) // include closing ---
  const body = text.slice(closeAt + 4).replace(/^\n+/, '')
  return {
    frontmatter,
    body,
    name: parseFrontmatterField(frontmatter, 'name'),
    description: parseFrontmatterField(frontmatter, 'description'),
  }
}

function parseFrontmatterField(frontmatter: string, key: string): string {
  const lines = normalizeNewlines(frontmatter).split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    const prefix = `${key}:`
    if (!line.startsWith(prefix)) continue
    const rest = line.slice(prefix.length).trim()
    if (rest === '>' || rest === '>-' || rest === '|' || rest === '|-') {
      const parts: string[] = []
      for (let j = i + 1; j < lines.length; j += 1) {
        const next = lines[j]
        if (!next.startsWith(' ') && !next.startsWith('\t')) break
        parts.push(next.trim())
      }
      return parts.join(' ').trim()
    }
    return rest.replace(/^["']|["']$/g, '').trim()
  }
  return ''
}

function yamlQuote(value: string) {
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  return `"${escaped}"`
}

function buildFrontmatter(name: string, description: string) {
  const lines = ['---', `name: ${name.trim() || 'skill'}`]
  if (description.trim()) lines.push(`description: ${yamlQuote(description.trim())}`)
  lines.push('---')
  return lines.join('\n')
}

function composeMarkdown() {
  if (store.sourceMode) return fullMarkdown.value
  const fm = buildFrontmatter(skillName.value, skillDescription.value)
  frontmatter.value = fm
  return `${fm}\n\n${bodyMarkdown.value.replace(/^\n+/, '')}`
}

async function loadActive() {
  if (!active.value?.skillPath) {
    fullMarkdown.value = ''
    bodyMarkdown.value = ''
    frontmatter.value = ''
    skillName.value = ''
    skillDescription.value = ''
    loadedPath.value = null
    hasUnsavedChanges.value = false
    return
  }
  busy.value = true
  saveError.value = null
  try {
    const file = await readSkillFile(active.value.skillPath)
    const parts = splitSkillMarkdown(file.content)
    frontmatter.value = parts.frontmatter
    bodyMarkdown.value = parts.body
    skillName.value = parts.name || active.value.name
    skillDescription.value = parts.description
    fullMarkdown.value = normalizeNewlines(file.content)
    loadedPath.value = file.path
    hasUnsavedChanges.value = false
    changeRevision += 1
  } catch (error) {
    saveError.value = error instanceof Error ? error.message : String(error)
  } finally {
    busy.value = false
  }
}

function scheduleSave() {
  if (autoSaveTimer) window.clearTimeout(autoSaveTimer)
  const revision = changeRevision
  autoSaveTimer = window.setTimeout(() => {
    if (revision === changeRevision) void saveNow()
  }, 700)
}

function onBodyChange(value: string) {
  bodyMarkdown.value = value
  fullMarkdown.value = composeMarkdown()
  hasUnsavedChanges.value = true
  changeRevision += 1
  scheduleSave()
}

function onMetaChange() {
  fullMarkdown.value = composeMarkdown()
  hasUnsavedChanges.value = true
  changeRevision += 1
  scheduleSave()
}

function onSourceChange(value: string) {
  fullMarkdown.value = value
  const parts = splitSkillMarkdown(value)
  frontmatter.value = parts.frontmatter
  bodyMarkdown.value = parts.body
  skillName.value = parts.name || skillName.value
  skillDescription.value = parts.description
  hasUnsavedChanges.value = true
  changeRevision += 1
  scheduleSave()
}

async function saveNow() {
  if (!loadedPath.value || !hasUnsavedChanges.value) return
  busy.value = true
  saveError.value = null
  try {
    const content = store.sourceMode ? fullMarkdown.value : composeMarkdown()
    await writeSkillFile(loadedPath.value, content)
    fullMarkdown.value = content
    hasUnsavedChanges.value = false
  } catch (error) {
    saveError.value = error instanceof Error ? error.message : String(error)
  } finally {
    busy.value = false
  }
}

async function refreshScan() {
  scanBusy.value = true
  scanError.value = ''
  try {
    const workspacePath = store.skillsWorkspaceSource?.path ?? null
    scanRoots.value = await listSkillScanRoots(workspacePath)
    customRoots.value = await listExtraSkillScanRoots()
    scanned.value = await scanSkills(workspacePath)
  } catch (error) {
    scanError.value = error instanceof Error ? error.message : String(error)
  } finally {
    scanBusy.value = false
  }
}

async function addScanPath() {
  const path = await pickSkillScanDirectory()
  if (!path) return
  scanBusy.value = true
  try {
    await addSkillScanRoot(path)
    await refreshScan()
  } catch (error) {
    scanError.value = error instanceof Error ? error.message : String(error)
  } finally {
    scanBusy.value = false
  }
}

async function removeScanPath(path: string) {
  scanBusy.value = true
  try {
    await removeSkillScanRoot(path)
    await refreshScan()
  } catch (error) {
    scanError.value = error instanceof Error ? error.message : String(error)
  } finally {
    scanBusy.value = false
  }
}

async function connect(skillPath: string) {
  scanBusy.value = true
  scanError.value = ''
  try {
    await store.connectScannedSkill(skillPath)
    notice.value = '已接入'
    window.setTimeout(() => { notice.value = '' }, 2000)
    await refreshScan()
  } catch (error) {
    scanError.value = error instanceof Error ? error.message : String(error)
  } finally {
    scanBusy.value = false
  }
}

async function disconnect(connectionId: string) {
  if (!window.confirm('仅断开连接，不删除本地文件。继续？')) return
  try {
    await store.disconnectManagedSkill(connectionId)
    notice.value = '已断开（本地文件保留）'
    window.setTimeout(() => { notice.value = '' }, 2000)
    if (store.showingSkillManager) await refreshScan()
  } catch (error) {
    scanError.value = error instanceof Error ? error.message : String(error)
  }
}

async function createLinkedPage(title: string): Promise<Page> {
  return store.createLinkedPage(title)
}

function toggleSourceMode() {
  if (!store.sourceMode) {
    fullMarkdown.value = composeMarkdown()
  } else {
    const parts = splitSkillMarkdown(fullMarkdown.value)
    frontmatter.value = parts.frontmatter
    bodyMarkdown.value = parts.body
    skillName.value = parts.name || skillName.value
    skillDescription.value = parts.description
  }
  store.toggleSourceMode()
  void nextTick(() => sourceEditor.value?.focus())
}

onMounted(() => {
  void store.refreshSkills()
  if (store.showingSkillManager || !store.activeSkillId) void refreshScan()
  else void loadActive()
})

watch(() => store.activeSkillId, () => {
  if (!store.showingSkillManager) void loadActive()
})

watch(() => store.showingSkillManager, (open) => {
  if (open) void refreshScan()
})

onBeforeUnmount(() => {
  if (autoSaveTimer) window.clearTimeout(autoSaveTimer)
  if (hasUnsavedChanges.value) void saveNow()
})
</script>

<template>
  <main class="editor-pane skills-view">
    <header class="editor-header">
      <nav class="breadcrumbs" aria-label="Skill 层级">
        <span>{{ store.workspace?.name ?? '我的知识库' }}</span>
        <span>›</span>
        <button type="button" :class="{ current: store.showingSkillManager || !active }" @click="store.openSkillManager()">Agent Skills</button>
        <template v-if="active && !store.showingSkillManager">
          <span>›</span>
          <button type="button" class="current">{{ active.name }}</button>
        </template>
      </nav>
      <div class="save-state">
        <template v-if="!store.showingSkillManager && active">
          <span class="save-dot" :class="{ saving: busy, error: Boolean(saveError) }"></span>
          <span :title="saveError ?? undefined">{{ status }}</span>
          <button type="button" class="history-button" title="断开连接（不删除本地文件）" @click="disconnect(active.id)">断开</button>
        </template>
        <button type="button" class="history-button" title="扫描并接入" @click="store.openSkillManager()">⌕ 接入</button>
      </div>
    </header>

    <section v-if="store.showingSkillManager || !active" class="skills-manager library-content">
      <p class="eyebrow">Codex 连接</p>
      <h1>Agent Skills</h1>
      <p class="library-description">侧栏只显示已接入的 Skill。扫描本地路径后接入；断开不会删除文件。</p>

      <div class="skills-manager-toolbar">
        <button type="button" :disabled="scanBusy || !isDesktop" @click="refreshScan">{{ scanBusy ? '扫描中…' : '重新扫描' }}</button>
        <button type="button" :disabled="scanBusy || !isDesktop" @click="addScanPath">添加路径</button>
        <button type="button" class="ghost" :disabled="!scanRoots.length" @click="rootsOpen = !rootsOpen">
          {{ rootsOpen ? '收起路径' : `扫描路径 (${scanRoots.length})` }}
        </button>
      </div>

      <p v-if="!isDesktop" class="library-empty">仅桌面端可用。</p>
      <p v-if="scanError" class="backend-error">{{ scanError }}</p>
      <p v-if="notice" class="minio-config-notice">{{ notice }}</p>

      <div v-if="rootsOpen && scanRoots.length" class="skills-panel">
        <div class="skills-panel-title">扫描路径</div>
        <ul class="skills-path-list">
          <li v-for="root in scanRoots" :key="root">
            <code :title="root">{{ shortenPath(root) }}</code>
            <button
              v-if="customRoots.includes(root)"
              type="button"
              class="skills-text-btn"
              @click="removeScanPath(root)"
            >移除</button>
          </li>
        </ul>
      </div>

      <div v-if="store.skillConnections.length" class="skills-panel">
        <div class="skills-panel-title">已接入 · {{ store.skillConnections.length }}</div>
        <div class="skills-card-list">
          <div v-for="item in store.skillConnections" :key="item.id" class="skills-card">
            <button type="button" class="skills-card-main" @click="store.selectSkill(item.id)">
              <strong>{{ item.name }}</strong>
              <small :title="item.skillPath">{{ shortenPath(item.skillPath) }}</small>
            </button>
            <button type="button" class="skills-text-btn" @click="disconnect(item.id)">断开</button>
          </div>
        </div>
      </div>

      <div class="skills-panel">
        <div class="skills-panel-title">待接入 · {{ pendingScan.length }}</div>
        <p v-if="scanBusy" class="library-empty">正在扫描…</p>
        <p v-else-if="!pendingScan.length" class="library-empty">没有新的 Skill。可添加扫描路径后重试。</p>
        <div v-else class="skills-card-list">
          <div v-for="item in pendingScan" :key="item.skillPath" class="skills-card">
            <div class="skills-card-main">
              <strong>{{ item.name }}</strong>
              <small>{{ item.description || '无描述' }}</small>
              <small :title="item.skillPath">{{ shortenPath(item.skillPath) }}</small>
            </div>
            <button type="button" class="skills-action-btn" :disabled="scanBusy" @click="connect(item.skillPath)">接入</button>
          </div>
        </div>
      </div>
    </section>

    <template v-else-if="active">
      <div class="editor-scroll">
        <article class="document">
          <div v-if="store.sourceMode" class="source-editor-panel">
            <div class="skills-doc-meta skills-doc-meta-compact">
              <strong>{{ skillName || active.name }}</strong>
              <small :title="active.skillPath">{{ shortenPath(active.skillPath) }}</small>
            </div>
            <textarea
              ref="sourceEditor"
              class="source-editor"
              aria-label="Skill Markdown 源码"
              :value="fullMarkdown"
              :spellcheck="store.spellcheckEnabled"
              @input="onSourceChange(($event.target as HTMLTextAreaElement).value)"
            />
          </div>
          <TiptapEditor
            v-else
            ref="richEditor"
            :model-value="bodyMarkdown"
            :pages="store.pages"
            :sources="store.allSources"
            :page-id="fakePageId"
            :spellcheck="store.spellcheckEnabled"
            :create-linked-page="createLinkedPage"
            @update:model-value="onBodyChange"
            @navigate="store.openPage($event)"
          >
            <template #meta>
              <div class="skills-doc-meta">
                <label class="skills-meta-field">
                  <span>名称</span>
                  <input v-model="skillName" @input="onMetaChange" />
                </label>
                <label class="skills-meta-field">
                  <span>描述（给 Agent 判断何时启用）</span>
                  <textarea v-model="skillDescription" rows="3" @input="onMetaChange" />
                </label>
                <small class="skills-path-hint" :title="active.skillPath">{{ shortenPath(active.skillPath) }}</small>
              </div>
            </template>
          </TiptapEditor>
        </article>
      </div>
      <footer class="editor-statusbar">
        <template v-if="!store.sourceMode">
          <button type="button" title="撤销" @click="richEditor?.undo()">↶ 撤销</button>
          <button type="button" title="重做" @click="richEditor?.redo()">↷ 重做</button>
        </template>
        <button type="button" :class="{ active: store.sourceMode }" title="切换 Markdown 源码模式" @click="toggleSourceMode">&lt;/&gt; 源码</button>
        <span class="status-divider"></span>
        <button type="button" :class="{ active: store.spellcheckEnabled }" @click="store.toggleSpellcheck">✓ 拼写检查</button>
        <span class="word-count">字数 {{ wordCount }}</span>
      </footer>
    </template>
  </main>
</template>
