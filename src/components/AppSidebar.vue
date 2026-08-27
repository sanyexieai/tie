<script setup lang="ts">
import { computed, ref } from 'vue'
import PageTreeItem from '@/components/PageTreeItem.vue'
import { useWorkspaceStore } from '@/stores/workspace'

const store = useWorkspaceStore()
const rootPage = computed(() => store.tree.find((node) => node.title === '收集箱'))
const otherPages = computed(() => store.tree.filter((node) => node.id !== rootPage.value?.id))
const topLevelDragOver = ref(false)

async function createTopLevel() { await store.createPage(null) }
async function createChild(parentId: string) { await store.createChildPage(parentId) }
async function remove(pageId: string) {
  if (store.pages.length <= 1) return
  await store.trashPage(pageId)
}
async function move(pageId: string, parentId: string) { await store.movePage(pageId, parentId) }
async function reorder(pageId: string, targetId: string, position: 'before' | 'after') { await store.reorderPage(pageId, targetId, position) }
async function dropAtTopLevel(event: DragEvent) {
  const pageId = event.dataTransfer?.getData('text/plain')
  topLevelDragOver.value = false
  if (pageId) await store.movePage(pageId, null)
}
</script>

<template>
  <aside class="sidebar">
    <div class="workspace-heading">
      <span class="workspace-mark">T</span>
      <span>{{ store.workspace?.name ?? '加载中…' }}</span>
      <button class="ghost-button">⌄</button>
    </div>

    <button class="new-page-button" @click="createTopLevel"><span>+</span> 新建页面</button>

    <nav class="quick-nav" aria-label="快捷导航">
      <button :class="{ selected: !store.showingTrash && rootPage?.id === store.activePageId }" @click="rootPage && store.openPage(rootPage.id)"><span>⌑</span> 收集箱</button>
      <button disabled><span>◷</span> 最近打开</button>
      <button disabled><span>☆</span> 收藏</button>
      <button disabled><span>⌕</span> 搜索</button>
      <button :class="{ selected: store.showingTrash }" @click="store.openTrash()"><span>⌫</span> 回收站</button>
    </nav>

    <div class="sidebar-section-title"><span>我的页面</span><button @click="createTopLevel">+</button></div>
    <div class="page-tree">
      <div
        class="top-level-drop-zone"
        :class="{ visible: topLevelDragOver }"
        @dragenter.prevent="topLevelDragOver = true"
        @dragover.prevent
        @dragleave="topLevelDragOver = false"
        @drop.prevent="dropAtTopLevel"
      >拖到这里设为顶层页面</div>
      <PageTreeItem
        v-for="node in otherPages"
        :key="node.id"
        :node="node"
        :active-page-id="store.activePageId"
        @select="store.openPage($event)"
        @create="createChild"
        @remove="remove"
        @move="move"
        @reorder="reorder"
      />
      <PageTreeItem
        v-if="rootPage"
        :node="rootPage"
        :active-page-id="store.activePageId"
        @select="store.openPage($event)"
        @create="createChild"
        @remove="remove"
        @move="move"
        @reorder="reorder"
      />
    </div>

    <div class="storage-footer">
      <div class="sidebar-section-title"><span>存储源</span><button disabled>+</button></div>
      <div class="storage-row"><span class="storage-status"></span><span>本地工作区</span><small>已连接</small></div>
      <p>远程 MinIO、SMB 将在后续版本接入。</p>
    </div>
  </aside>
</template>
