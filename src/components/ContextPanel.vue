<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useWorkspaceStore } from '@/stores/workspace'
import LocalGraphPanel from '@/components/LocalGraphPanel.vue'
import {
  buildFileUrl,
  canRebindRegisteredFile,
  collectFileRefsFromMarkdown,
  collectPathRefsFromMarkdown,
  fileLinkLabel,
  fileLinkTitle,
  listRegisteredFiles,
  openRegisteredFile,
  probeRelativePath,
  resolveLinkForm,
  resourceAvailability,
  type WorkspaceFileResource,
} from '@/services/files'
import { buildPathUrl, classifyLocalLink, fileRootForSource, sourceById, type LinkContext } from '@/services/link-runtime'
import { isCrossSourceLink, rebindLinkedResource, sourceChipLabel } from '@/services/link-actions'
import { openLocalLink } from '@/services/local-links'

const store = useWorkspaceStore()
const tab = ref<'outline' | 'properties' | 'links' | 'graph'>('outline')
const emit = defineEmits<{ close: [] }>()
const headings = computed(() => (store.activePage?.markdown.match(/^#{2,6} .+$/gm) ?? []).map((line, index) => ({ index, level: line.indexOf(' '), text: line.replace(/^#+ /, '') })))
const outgoing = computed(() => store.activePage ? store.outgoingLinks(store.activePage.id) : [])
const incoming = computed(() => store.activePage ? store.backlinks(store.activePage.id) : [])
const mentions = computed(() => store.activePage ? store.unlinkedMentions(store.activePage.id) : [])
const childPages = computed(() => {
  const parentId = store.activePage?.id
  if (!parentId) return []
  return store.pages
    .filter((page) => page.parentId === parentId && !page.deletedAt)
    .sort((a, b) => a.sortKey - b.sortKey || a.title.localeCompare(b.title, 'zh-CN'))
})
const linkingMentionId = ref<string | null>(null)
const fileResources = ref<WorkspaceFileResource[]>([])
const openingFileId = ref<string | null>(null)
const storageLabel = computed(() => {
  const source = store.allSources.find((item) => item.id === store.activePage?.storageSourceId)
  if (!source) return '未知存储源'
  if (source.kind === 'backend') return `后台 · ${source.name}`
  if (source.kind === 's3') return `S3 · ${source.name}`
  return source.kind === 'smb' ? `SMB · ${source.name}` : `本地 · ${source.name}`
})

const linkContext = computed<LinkContext>(() => ({
  pageSourceId: store.activePage?.storageSourceId ?? null,
  sources: store.allSources,
}))

const filesWorkspaceRoot = computed(() => {
  return fileRootForSource(sourceById(store.allSources, store.activePage?.storageSourceId))
})

const outgoingFiles = computed(() => {
  const page = store.activePage
  if (!page) return []
  const files = collectFileRefsFromMarkdown(page.markdown).map((ref) => {
    const sourceId = ref.sourceId || page.storageSourceId
    const href = buildFileUrl(ref.fileId, sourceId)
    const link = classifyLocalLink(href)
    const resource = fileResources.value.find((item) => item.id === ref.fileId)
    const source = sourceById(store.allSources, sourceId)
    const availability = link ? resourceAvailability(link, linkContext.value) : 'unknown'
    return {
      type: 'file' as const,
      id: ref.fileId,
      sourceId,
      href,
      title: resource?.title ?? ref.fileId,
      kind: resource?.kind ?? null,
      mode: resource?.mode ?? 'link',
      exists: resource?.exists ?? false,
      availability,
      canRebind: canRebindRegisteredFile(resource),
      sourceLabel: sourceChipLabel(source),
      crossSource: isCrossSourceLink(sourceId, page.storageSourceId),
    }
  })
  const paths = collectPathRefsFromMarkdown(page.markdown).map((ref) => {
    const sourceId = ref.sourceId || page.storageSourceId
    const href = buildPathUrl(ref.relativePath, sourceId)
    const link = classifyLocalLink(href)
    const source = sourceById(store.allSources, sourceId)
    const availability = link ? resourceAvailability(link, linkContext.value) : 'unknown'
    const name = ref.relativePath.split('/').filter(Boolean).pop() || ref.relativePath
    return {
      type: 'path' as const,
      id: ref.relativePath,
      sourceId,
      href,
      title: name,
      kind: null as string | null,
      mode: 'relative',
      exists: availability === 'ready',
      availability,
      canRebind: false,
      sourceLabel: sourceChipLabel(source),
      crossSource: isCrossSourceLink(sourceId, page.storageSourceId),
    }
  })
  return [...files, ...paths]
})

async function refreshFileResources() {
  const page = store.activePage
  if (!page) {
    fileResources.value = []
    return
  }
  const fileRefs = collectFileRefsFromMarkdown(page.markdown)
  const pathRefs = collectPathRefsFromMarkdown(page.markdown)
  const sourceIds = new Set(
    [...fileRefs.map((ref) => ref.sourceId || page.storageSourceId), ...pathRefs.map((ref) => ref.sourceId || page.storageSourceId)],
  )
  const sources = [...sourceIds]
    .map((sourceId) => sourceById(store.allSources, sourceId))
    .filter((source): source is NonNullable<typeof source> => Boolean(source))
  if (!sources.length) {
    fileResources.value = []
    return
  }
  try {
    const lists = await Promise.all(sources.map((source) => listRegisteredFiles(source)))
    fileResources.value = lists.flat()
    await Promise.all(pathRefs.map(async (ref) => {
      const source = sourceById(store.allSources, ref.sourceId || page.storageSourceId)
      if (!source) return
      try {
        await probeRelativePath(source, ref.relativePath)
      } catch {
        // ignore
      }
    }))
  } catch {
    fileResources.value = []
  }
}

watch(
  [() => store.activePage?.id, () => store.activePage?.markdown, filesWorkspaceRoot],
  () => { void refreshFileResources() },
  { immediate: true },
)

async function openOutgoingFile(file: { type: 'file' | 'path'; id: string; sourceId: string; href: string; kind?: string | null }) {
  const source = sourceById(store.allSources, file.sourceId)
  if (!source) {
    window.alert('当前链接所属存储源不可用，无法打开文件资源。')
    return
  }
  openingFileId.value = file.id
  try {
    if (file.type === 'path') {
      await openLocalLink(file.href, linkContext.value)
      return
    }
    await openRegisteredFile(source, file.id)
  } catch (error) {
    window.alert(error instanceof Error ? error.message : '无法打开文件资源')
  } finally {
    openingFileId.value = null
  }
}

const rebindingId = ref<string | null>(null)

async function rebindOutgoingFile(file: { id: string; sourceId: string; kind?: string | null }) {
  const source = sourceById(store.allSources, file.sourceId)
  if (!source) {
    window.alert('当前链接所属存储源不可用。')
    return
  }
  rebindingId.value = file.id
  try {
    const rebound = await rebindLinkedResource(source, file.id, file.kind === 'directory' ? 'directory' : 'file')
    if (rebound) await refreshFileResources()
  } catch (error) {
    window.alert(error instanceof Error ? error.message : '无法重新绑定')
  } finally {
    rebindingId.value = null
  }
}

async function linkMention(sourcePageId: string) {
  const target = store.activePage
  if (!target) return
  linkingMentionId.value = sourcePageId
  try {
    await store.linkUnlinkedMention(sourcePageId, target.id)
  } finally {
    linkingMentionId.value = null
  }
}

async function unlinkPage(pageId: string) {
  const source = store.activePage
  if (!source) return
  await store.unlinkPageReference(source.id, pageId)
}
</script>

<template>
  <aside class="context-panel">
    <div class="context-tabs">
      <button :class="{ active: tab === 'outline' }" @click="tab = 'outline'">大纲</button>
      <button :class="{ active: tab === 'properties' }" @click="tab = 'properties'">属性</button>
      <button :class="{ active: tab === 'links' }" @click="tab = 'links'">链接</button>
      <button :class="{ active: tab === 'graph' }" @click="tab = 'graph'">图谱</button>
      <button class="context-collapse-button" type="button" title="收起右侧栏" aria-label="收起右侧栏" @click="emit('close')">‹</button>
    </div>
    <div v-if="tab === 'outline'" class="context-content outline-list">
      <p v-if="!headings.length" class="muted">添加标题后将在这里生成大纲。</p>
      <button v-for="heading in headings" :key="`${heading.index}-${heading.text}`" :style="{ paddingLeft: `${(heading.level - 1) * 10}px` }" @click="store.scrollToOutlineHeading(heading.index)">{{ heading.text }}</button>
    </div>
    <div v-else-if="tab === 'properties'" class="context-content property-list">
      <div><span>更新</span><strong>{{ store.activePage?.updatedAt.slice(0, 19).replace('T', ' ') }}</strong></div>
      <div><span>标签</span><strong>{{ store.activePage?.tags.length ? store.activePage.tags.map((tag) => `#${tag}`).join(' ') : '无' }}</strong></div>
      <div><span>存储</span><strong>{{ storageLabel }}</strong></div>
      <div><span>出链</span><strong>{{ outgoing.length }}</strong></div>
      <div><span>文件</span><strong>{{ outgoingFiles.length }}</strong></div>
      <div><span>回链</span><strong>{{ incoming.length }}</strong></div>
    </div>
    <div v-else-if="tab === 'links'" class="context-content link-panel">
      <section>
        <h3>子页面</h3>
        <p v-if="!childPages.length" class="muted">无子页面。侧栏或「新建子页面」会按 parent_id 挂接，不写入正文。</p>
        <button v-for="page in childPages" :key="`child-${page.id}`" @click="store.openPage(page.id)"><span>↳</span>{{ page.title }}</button>
      </section>
      <section>
        <h3>出链</h3>
        <p v-if="!outgoing.length" class="muted">还没有出链。输入 [[ 可创建页面链接。</p>
        <div v-for="page in outgoing" :key="`out-${page.id}`" class="mention-row">
          <button @click="store.openPage(page.id)"><span>↗</span>{{ page.title }}</button>
          <button class="unlink-action" title="移除正文中的链接" @click="unlinkPage(page.id)">×</button>
        </div>
      </section>
      <section>
        <h3>文件资源</h3>
        <p v-if="!outgoingFiles.length" class="muted">正文中的 tie://file/… 与 tie://path/… 会显示在这里（实心=库内，空心=本机；找不到会单独标出）。</p>
        <div v-for="file in outgoingFiles" :key="`file-${file.type}-${file.sourceId}-${file.id}`" class="mention-row file-link-row">
          <button
            class="file-resource-open"
            :class="{ directory: file.kind === 'directory', missing: file.availability === 'missing' || file.availability === 'offline' }"
            :disabled="openingFileId === file.id"
            :title="file.availability === 'missing' ? '路径不可用' : (file.kind === 'directory' ? '打开目录' : file.id)"
            @click="openOutgoingFile(file)"
          >{{ file.title }}</button>
          <em
            class="file-mode-badge"
            :class="[resolveLinkForm(file.mode) || undefined, file.availability]"
            :title="fileLinkTitle(file.mode, file.kind, file.availability)"
          >{{ fileLinkLabel(file.mode, file.kind, file.availability) }}</em>
          <small v-if="file.crossSource && file.sourceLabel" class="file-source-badge" :title="file.sourceLabel">{{ file.sourceLabel }}</small>
          <button
            v-if="file.canRebind"
            class="mention-link-action"
            type="button"
            :disabled="rebindingId === file.id"
            title="选择新的本机路径，保持原来的链接 id"
            @click="rebindOutgoingFile(file)"
          >{{ rebindingId === file.id ? '绑定中…' : '重新绑定' }}</button>
        </div>
      </section>
      <section>
        <h3>回链</h3>
        <p v-if="!incoming.length" class="muted">还没有其他页面指向这里。</p>
        <button v-for="page in incoming" :key="`in-${page.id}`" @click="store.openPage(page.id)"><span>↙</span>{{ page.title }}</button>
      </section>
      <section>
        <h3>未链接提及</h3>
        <p v-if="!mentions.length" class="muted">没有检测到未链接的标题提及。</p>
        <div v-for="page in mentions" :key="`mention-${page.id}`" class="mention-row">
          <button title="正文中出现了该页面标题，但尚未建立页面链接" @click="store.openPage(page.id)"><span>⌁</span>{{ page.title }}</button>
          <button class="mention-link-action" :disabled="linkingMentionId === page.id" :title="`将“${page.title}”中首次提及当前页的文字转换为页面链接`" @click="linkMention(page.id)">{{ linkingMentionId === page.id ? '关联中…' : '关联' }}</button>
        </div>
        <p class="mention-hint">正文中出现标题但未建立链接；可在编辑器中输入 [[ 进行关联。</p>
      </section>
    </div>
    <div v-else class="context-content graph-panel graph-panel-obsidian">
      <LocalGraphPanel v-if="store.activePage" />
      <p v-else class="muted">打开页面后显示局部图谱。</p>
    </div>
  </aside>
</template>
