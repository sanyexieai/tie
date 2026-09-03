<script setup lang="ts">
import { computed, ref } from 'vue'
import { useWorkspaceStore } from '@/stores/workspace'
import LocalGraphPanel from '@/components/LocalGraphPanel.vue'

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
const storageLabel = computed(() => {
  const source = store.allSources.find((item) => item.id === store.activePage?.storageSourceId)
  if (!source) return '未知存储源'
  if (source.kind === 'backend') return `后台 · ${source.name}`
  if (source.kind === 's3') return `S3 · ${source.name}`
  return source.kind === 'smb' ? `SMB · ${source.name}` : `本地 · ${source.name}`
})

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
