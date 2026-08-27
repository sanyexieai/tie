<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { EditorContent, useEditor } from '@tiptap/vue-3'
import type { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
import { Table } from '@tiptap/extension-table'
import TableCell from '@tiptap/extension-table-cell'
import TableHeader from '@tiptap/extension-table-header'
import TableRow from '@tiptap/extension-table-row'
import TaskItem from '@tiptap/extension-task-item'
import TaskList from '@tiptap/extension-task-list'
import { Markdown } from '@tiptap/markdown'
import type { Page } from '@/types'

const props = defineProps<{ modelValue: string; pages: Page[]; pageId: string; spellcheck: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [markdown: string]; navigate: [pageId: string]; 'create-child': [] }>()
const showPagePicker = ref(false)
const pagePickerMode = ref<'slash' | 'wiki'>('slash')
const pageQuery = ref('')
const wikiQuery = ref('')
const wikiStart = ref<number | null>(null)
const selectedPageIndex = ref(0)
const slashQuery = ref<string | null>(null)
const slashStart = ref<number | null>(null)
const selectedCommandIndex = ref(0)
const matchingPages = computed(() => {
  const query = (pagePickerMode.value === 'wiki' ? wikiQuery.value : pageQuery.value).trim().toLocaleLowerCase()
  return props.pages.filter((page) => !page.deletedAt && (!query || page.title.toLocaleLowerCase().includes(query))).slice(0, 8)
})
const childPageIds = computed(() => new Set(props.pages.filter((page) => page.parentId === props.pageId && !page.deletedAt).map((page) => page.id)))

interface SlashCommand {
  id: string
  label: string
  hint: string
  keywords: string[]
  run: (editor: Editor) => void
}

const slashCommands: SlashCommand[] = [
  { id: 'text', label: '正文', hint: '普通段落', keywords: ['paragraph', '文字', '文本'], run: (editor) => editor.chain().focus().setParagraph().run() },
  { id: 'heading-2', label: '二级标题', hint: '章节标题', keywords: ['heading', '标题', 'h2'], run: (editor) => editor.chain().focus().toggleHeading({ level: 2 }).run() },
  { id: 'heading-3', label: '三级标题', hint: '小节标题', keywords: ['heading', '标题', 'h3'], run: (editor) => editor.chain().focus().toggleHeading({ level: 3 }).run() },
  { id: 'bullet-list', label: '无序列表', hint: '项目符号列表', keywords: ['list', '列表', 'bullet'], run: (editor) => editor.chain().focus().toggleBulletList().run() },
  { id: 'task-list', label: '待办事项', hint: '可勾选的任务', keywords: ['task', 'todo', '待办', '任务'], run: (editor) => editor.chain().focus().toggleTaskList().run() },
  { id: 'quote', label: '引用', hint: '突出一段内容', keywords: ['quote', '引用'], run: (editor) => editor.chain().focus().toggleBlockquote().run() },
  { id: 'code', label: '代码块', hint: '带语法标记的代码', keywords: ['code', '代码'], run: (editor) => editor.chain().focus().toggleCodeBlock().run() },
  { id: 'table', label: '表格', hint: '插入 3 × 3 表格', keywords: ['table', '表格'], run: (editor) => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
  { id: 'divider', label: '分割线', hint: '分隔内容区域', keywords: ['divider', '分割', 'horizontal'], run: (editor) => editor.chain().focus().setHorizontalRule().run() },
  { id: 'page-link', label: '链接页面', hint: '关联知识库中的页面', keywords: ['link', 'page', '链接', '关联', '页面'], run: () => openSlashPagePicker() },
  { id: 'child-page', label: '子页面', hint: '在当前页面下创建页面', keywords: ['page', 'child', '页面', '子页面'], run: () => emit('create-child') },
]

const filteredCommands = computed(() => {
  const query = slashQuery.value?.trim().toLocaleLowerCase() ?? ''
  if (!query) return slashCommands
  return slashCommands.filter((command) => [command.label, command.hint, ...command.keywords].some((value) => value.toLocaleLowerCase().includes(query)))
})

function openInternalLink(event: MouseEvent) {
  const target = event.target
  if (!(target instanceof Element)) return false
  const href = target.closest('a')?.getAttribute('href')
  const prefix = 'tie://page/'
  if (!href?.startsWith(prefix)) return false
  event.preventDefault()
  emit('navigate', href.slice(prefix.length))
  return true
}

function focusNextWritingLine(event: MouseEvent) {
  const current = editor.value
  const root = current?.view.dom
  if (!current || !root || event.target !== root) return false
  const blocks = [...root.children]
  const lastBlock = blocks.at(-1)
  if (lastBlock && event.clientY <= lastBlock.getBoundingClientRect().bottom) return false
  event.preventDefault()
  const lastNode = current.state.doc.lastChild
  if (lastNode?.type.name === 'paragraph' && lastNode.content.size === 0) current.chain().focus('end').run()
  else current.chain().insertContentAt(current.state.doc.content.size, { type: 'paragraph' }).focus('end').run()
  return true
}

function handleEditorClick(event: MouseEvent) {
  return openInternalLink(event) || focusNextWritingLine(event)
}

let syncingExternalValue = false
const editor = useEditor({
  content: props.modelValue,
  contentType: 'markdown',
  extensions: [
    StarterKit.configure({
      link: {
        openOnClick: false,
        autolink: true,
        linkOnPaste: true,
        protocols: ['tie'],
        isAllowedUri: (url, { defaultValidate }) => url.startsWith('tie://page/') || defaultValidate(url),
      },
    }),
    Markdown,
    Placeholder.configure({ placeholder: '开始写作，支持 Markdown 快捷输入…' }),
    TaskList,
    TaskItem.configure({ nested: true }),
    Table.configure({ resizable: true }),
    TableRow,
    TableHeader,
    TableCell,
  ],
  editorProps: {
    attributes: { class: 'tiptap-content', spellcheck: String(props.spellcheck) },
    handleDOMEvents: { click: (_view, event) => handleEditorClick(event) },
    handleKeyDown: (_view, event) => {
      if (showPagePicker.value && pagePickerMode.value === 'wiki') {
        if (!matchingPages.value.length && ['ArrowDown', 'ArrowUp', 'Enter'].includes(event.key)) {
          event.preventDefault()
          return true
        }
        if (event.key === 'ArrowDown') {
          event.preventDefault()
          selectedPageIndex.value = (selectedPageIndex.value + 1) % matchingPages.value.length
          return true
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault()
          selectedPageIndex.value = (selectedPageIndex.value - 1 + matchingPages.value.length) % matchingPages.value.length
          return true
        }
        if (event.key === 'Enter') {
          event.preventDefault()
          insertPageLink(matchingPages.value[selectedPageIndex.value])
          return true
        }
        if (event.key === 'Escape') {
          event.preventDefault()
          closePagePicker()
          return true
        }
      }
      if (slashQuery.value === null) return false
      if (!filteredCommands.value.length && ['ArrowDown', 'ArrowUp', 'Enter'].includes(event.key)) {
        event.preventDefault()
        return true
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        selectedCommandIndex.value = (selectedCommandIndex.value + 1) % filteredCommands.value.length
        return true
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        selectedCommandIndex.value = (selectedCommandIndex.value - 1 + filteredCommands.value.length) % filteredCommands.value.length
        return true
      }
      if (event.key === 'Enter') {
        event.preventDefault()
        executeSlashCommand(selectedCommandIndex.value)
        return true
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        closeSlashMenu()
        return true
      }
      return false
    },
  },
  onCreate: () => void nextTick(decorateChildPageLinks),
  onUpdate: ({ editor: currentEditor }) => {
    if (!syncingExternalValue) emit('update:modelValue', currentEditor.getMarkdown())
    updateMenus(currentEditor)
    void nextTick(decorateChildPageLinks)
  },
  onSelectionUpdate: ({ editor: currentEditor }) => updateMenus(currentEditor),
})

watch(() => props.modelValue, (markdown) => {
  if (!editor.value || editor.value.getMarkdown() === markdown) return
  syncingExternalValue = true
  editor.value.commands.setContent(markdown, { contentType: 'markdown', emitUpdate: false })
  syncingExternalValue = false
  void nextTick(decorateChildPageLinks)
})

watch(childPageIds, () => void nextTick(decorateChildPageLinks), { deep: true })
watch(() => props.spellcheck, (enabled) => editor.value?.view.dom.setAttribute('spellcheck', String(enabled)))

function decorateChildPageLinks() {
  const root = editor.value?.view.dom
  if (!root) return
  root.querySelectorAll<HTMLAnchorElement>('a[href^="tie://page/"]').forEach((link) => {
    const targetId = link.getAttribute('href')?.slice('tie://page/'.length)
    link.classList.toggle('child-page-link', Boolean(targetId && childPageIds.value.has(targetId)))
  })
}

function insertPageLink(page: Page) {
  const current = editor.value
  if (!current || !page) return
  const href = `tie://page/${page.id}`
  if (pagePickerMode.value === 'wiki' && wikiStart.value !== null) {
    current.chain().focus().deleteRange({ from: wikiStart.value, to: current.state.selection.from }).insertContent({ type: 'text', text: page.title, marks: [{ type: 'link', attrs: { href } }] }).run()
  } else if (current.state.selection.empty) {
    current.chain().focus().insertContent({ type: 'text', text: page.title, marks: [{ type: 'link', attrs: { href } }] }).run()
  } else {
    current.chain().focus().extendMarkRange('link').setLink({ href }).run()
  }
  closePagePicker()
}

function updateMenus(currentEditor: Editor) {
  const { $from } = currentEditor.state.selection
  const beforeCursor = $from.parent.textContent.slice(0, $from.parentOffset)
  const wikiMatch = beforeCursor.match(/\[\[([^\]]*)$/)
  if (wikiMatch) {
    pagePickerMode.value = 'wiki'
    showPagePicker.value = true
    wikiQuery.value = wikiMatch[1]
    wikiStart.value = currentEditor.state.selection.from - wikiMatch[1].length - 2
    selectedPageIndex.value = 0
    closeSlashMenu()
    return
  }
  if (pagePickerMode.value === 'wiki') closePagePicker()
  updateSlashState(currentEditor, beforeCursor)
}

function updateSlashState(currentEditor: Editor, textBeforeCursor?: string) {
  const { $from } = currentEditor.state.selection
  const beforeCursor = textBeforeCursor ?? $from.parent.textContent.slice(0, $from.parentOffset)
  const match = beforeCursor.match(/(?:^|\s)\/([^\s]*)$/)
  if (!match) return closeSlashMenu()
  slashQuery.value = match[1]
  slashStart.value = currentEditor.state.selection.from - match[1].length - 1
  selectedCommandIndex.value = 0
}

function closeSlashMenu() {
  slashQuery.value = null
  slashStart.value = null
  selectedCommandIndex.value = 0
}

function openSlashPagePicker() {
  pagePickerMode.value = 'slash'
  pageQuery.value = ''
  selectedPageIndex.value = 0
  showPagePicker.value = true
}

function closePagePicker() {
  showPagePicker.value = false
  pageQuery.value = ''
  wikiQuery.value = ''
  wikiStart.value = null
  selectedPageIndex.value = 0
}

function executeSlashCommand(index: number) {
  const command = filteredCommands.value[index]
  const current = editor.value
  if (!command || !current || slashStart.value === null) return
  const end = current.state.selection.from
  closeSlashMenu()
  current.chain().focus().deleteRange({ from: slashStart.value, to: end }).run()
  command.run(current)
}

onBeforeUnmount(() => editor.value?.destroy())
</script>

<template>
  <div class="tiptap-editor" v-if="editor">
    <slot name="meta"></slot>
    <div v-if="showPagePicker" class="page-picker">
      <input v-if="pagePickerMode === 'slash'" v-model="pageQuery" autofocus placeholder="搜索并关联页面…" />
      <p v-else class="wiki-picker-hint">正在关联：<strong>{{ wikiQuery || '全部页面' }}</strong><small>↑↓ 选择，Enter 插入，Esc 取消</small></p>
      <button v-for="(page, index) in matchingPages" :key="page.id" :class="{ selected: pagePickerMode === 'wiki' && selectedPageIndex === index }" @mousedown.prevent="insertPageLink(page)">
        <span>{{ page.title }}</span><small>{{ page.parentId ? '子页面' : '顶层页面' }}</small>
      </button>
      <p v-if="!matchingPages.length">没有匹配页面</p>
    </div>
    <div v-if="slashQuery !== null" class="slash-menu" role="listbox" aria-label="插入块">
      <button
        v-for="(command, index) in filteredCommands"
        :key="command.id"
        :class="{ selected: selectedCommandIndex === index }"
        @mousedown.prevent="executeSlashCommand(index)"
      >
        <span class="slash-command-icon">/{{ command.label.slice(0, 1) }}</span>
        <span><strong>{{ command.label }}</strong><small>{{ command.hint }}</small></span>
      </button>
      <p v-if="!filteredCommands.length">没有匹配的命令</p>
    </div>
    <EditorContent :editor="editor" />
  </div>
</template>
