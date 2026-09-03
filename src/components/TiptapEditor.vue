<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { EditorContent, useEditor } from '@tiptap/vue-3'
import type { Editor } from '@tiptap/core'
import { Extension } from '@tiptap/core'
import { Plugin } from '@tiptap/pm/state'
import { TextSelection } from '@tiptap/pm/state'
import StarterKit from '@tiptap/starter-kit'
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight'
import Placeholder from '@tiptap/extension-placeholder'
import Image from '@tiptap/extension-image'
import { Table } from '@tiptap/extension-table'
import TableCell from '@tiptap/extension-table-cell'
import TableHeader from '@tiptap/extension-table-header'
import TableRow from '@tiptap/extension-table-row'
import TaskItem from '@tiptap/extension-task-item'
import TaskList from '@tiptap/extension-task-list'
import { Markdown } from '@tiptap/markdown'
import { common, createLowlight } from 'lowlight'
import { openUrl } from '@tauri-apps/plugin-opener'
import type { Page, StorageSource } from '@/types'
import { DEFAULT_PAGE_ICON } from '@/constants/page'
import { canStorePageAssets, embedImageFile, inlineImageSrcToFile, isImageFile, normalizeImageFile, parseAssetUrl, resolveAssetDisplayUrl, shouldHandleImagePaste, uploadPastedImage } from '@/services/attachments'

const props = defineProps<{ modelValue: string; pages: Page[]; sources: StorageSource[]; pageId: string; spellcheck: boolean; createLinkedPage: (title: string) => Promise<Page> }>()
const emit = defineEmits<{ 'update:modelValue': [markdown: string]; navigate: [pageId: string]; 'create-child': [] }>()
const lowlight = createLowlight(common)
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
function sourceLabel(page: Page) {
  const source = props.sources.find((item) => item.id === page.storageSourceId)
  if (!source) return '未知来源'
  return `${source.kind === 'smb' ? 'SMB' : '本地'} · ${source.name}`
}

interface SlashCommand {
  id: string
  label: string
  hint: string
  keywords: string[]
  run: (editor: Editor) => void
}

function activePage() {
  return props.pages.find((page) => page.id === props.pageId) ?? null
}

function markdownForImageAttrs(attrs: { src?: string | null; alt?: string | null; title?: string | null }) {
  const src = String(attrs.src ?? '')
  const alt = String(attrs.alt ?? '')
  const title = attrs.title ? ` "${String(attrs.title)}"` : ''
  return `![${alt}](${src}${title})`
}

function createAssetImageExtension() {
  return Image.extend({
    parseHTML() {
      return [
        {
          tag: 'img[src]',
          getAttrs: (element) => {
            if (!(element instanceof HTMLElement)) return false
            const src = element.getAttribute('src') ?? ''
            if (!src || src.startsWith('blob:') || src.startsWith('data:')) return false
            return {
              src,
              alt: element.getAttribute('alt'),
              title: element.getAttribute('title'),
            }
          },
        },
      ]
    },
    addNodeView() {
      return ({ node, getPos, editor: viewEditor }) => {
        let currentNode = node
        const wrap = document.createElement('span')
        wrap.className = 'tie-image-wrap'
        wrap.contentEditable = 'false'
        const img = document.createElement('img')
        img.className = 'tiptap-image'
        img.draggable = false
        img.alt = String(currentNode.attrs.alt ?? '')
        const broken = document.createElement('span')
        broken.className = 'tie-image-broken'
        broken.hidden = true
        let displayObjectUrl: string | null = null
        let currentSrc = ''
        let appliedSrc = ''
        let loadToken = 0
        let demoting = false

        const setBroken = (assetSrc: string, message: string) => {
          wrap.classList.add('is-broken')
          img.removeAttribute('src')
          img.hidden = true
          broken.hidden = false
          broken.textContent = message
          broken.title = '点击编辑为 Markdown 文本'
          wrap.dataset.tieAsset = assetSrc
        }

        const setLoaded = () => {
          wrap.classList.remove('is-broken')
          delete wrap.dataset.tieAsset
          img.hidden = false
          broken.hidden = true
          broken.textContent = ''
        }

        const demoteToEditableText = () => {
          if (demoting) return
          const pos = getPos()
          if (typeof pos !== 'number') return
          const markdown = markdownForImageAttrs({
            src: currentSrc,
            alt: img.alt,
            title: currentNode.attrs.title,
          })
          const textNode = viewEditor.schema.text(markdown)
          demoting = true
          const from = pos
          const to = pos + currentNode.nodeSize
          const tr = viewEditor.state.tr.replaceWith(from, to, textNode)
          const caret = from + Math.min(Math.max(2, Math.floor(markdown.length / 2)), markdown.length)
          tr.setSelection(TextSelection.create(tr.doc, caret))
          viewEditor.view.dispatch(tr)
          viewEditor.view.focus()
        }

        const applySrc = (nextSrc: string) => {
          currentSrc = nextSrc
          // 同一 src 已显示或正在加载时不要重置成「加载中」（NodeView update 很频繁）。
          if (nextSrc && nextSrc === appliedSrc) return
          appliedSrc = nextSrc
          const token = ++loadToken
          if (displayObjectUrl) {
            URL.revokeObjectURL(displayObjectUrl)
            displayObjectUrl = null
          }
          if (parseAssetUrl(nextSrc)) {
            img.dataset.tieAsset = nextSrc
            img.removeAttribute('src')
            img.hidden = true
            broken.hidden = false
            broken.textContent = '图片加载中…'
            // 加载中也允许点击降级成可编辑文本，避免一直卡住。
            wrap.classList.add('is-broken')
            void resolveAssetDisplayUrl(props.pages, nextSrc, { fallbackPage: activePage() })
              .then((url) => {
                if (token !== loadToken || img.dataset.tieAsset !== nextSrc) return
                if (!url.startsWith('blob:')) {
                  const name = parseAssetUrl(nextSrc)?.assetName ?? nextSrc
                  setBroken(nextSrc, `缺少图片 ${name}`)
                  return
                }
                displayObjectUrl = url
                img.onload = () => {
                  if (token !== loadToken) return
                  setLoaded()
                }
                img.onerror = () => {
                  if (token !== loadToken) return
                  setBroken(nextSrc, `无法显示 ${parseAssetUrl(nextSrc)?.assetName ?? '图片'}`)
                }
                img.src = url
                img.hidden = false
              })
              .catch(() => {
                if (token !== loadToken) return
                const name = parseAssetUrl(nextSrc)?.assetName ?? nextSrc
                setBroken(nextSrc, `缺少图片 ${name}`)
              })
            return
          }
          delete img.dataset.tieAsset
          img.onload = () => {
            if (token !== loadToken) return
            setLoaded()
          }
          img.onerror = () => {
            if (token !== loadToken) return
            setBroken(nextSrc, nextSrc || '图片无法显示')
          }
          img.src = nextSrc
          img.hidden = false
          broken.hidden = true
        }

        wrap.addEventListener('mousedown', (event) => {
          if (!wrap.classList.contains('is-broken')) return
          if (event.button !== 0) return
          event.preventDefault()
          event.stopPropagation()
          demoteToEditableText()
        })

        applySrc(String(currentNode.attrs.src ?? ''))
        wrap.appendChild(img)
        wrap.appendChild(broken)
        return {
          dom: wrap,
          selectNode: () => wrap.classList.add('ProseMirror-selectednode'),
          deselectNode: () => wrap.classList.remove('ProseMirror-selectednode'),
          update: (updated) => {
            if (updated.type.name !== 'image') return false
            currentNode = updated
            img.alt = String(updated.attrs.alt ?? '')
            applySrc(String(updated.attrs.src ?? ''))
            return true
          },
          ignoreMutation: (mutation) => {
            if (mutation.type === 'attributes' && mutation.attributeName === 'src') return true
            return mutation.target === img
              || mutation.target === broken
              || img.contains(mutation.target as Node)
              || broken.contains(mutation.target as Node)
          },
          destroy: () => {
            loadToken += 1
            if (displayObjectUrl) URL.revokeObjectURL(displayObjectUrl)
          },
        }
      }
    },
  })
}

function canEmbedImage(file: File) {
  if (!isImageFile(file)) return false
  const page = activePage()
  if (!page || !canStorePageAssets(page)) {
    window.alert('当前存储源不支持图片附件。请切换到本地/S3/后台工作区后再粘贴图片。')
    return false
  }
  const maxSize = 20 * 1024 * 1024
  if (file.size <= maxSize) return true
  window.alert('图片超过 20 MB，请压缩后重试或使用 /图片 插入 URL。')
  return false
}

function rejectInlineImageUrl(src: string) {
  return src.startsWith('blob:') || src.startsWith('data:')
}

async function insertImageFile(editor: Editor, file: File) {
  const page = activePage()
  if (!page || !canEmbedImage(file)) return
  try {
    const src = await embedImageFile(page, file)
    editor.chain().focus().setImage({ src }).run()
  } catch {
    window.alert('无法上传图片到存储源。')
  }
}

async function insertImageInView(
  currentEditor: Editor,
  file: File,
  options: { mode: 'replace' } | { mode: 'insert'; position: number },
) {
  const normalized = normalizeImageFile(file)
  const page = activePage()
  if (!page || !canEmbedImage(normalized)) return
  try {
    const src = await embedImageFile(page, normalized)
    if (options.mode === 'replace') {
      currentEditor.chain().focus().setImage({ src }).run()
      return
    }
    currentEditor.chain().focus().insertContentAt(options.position, { type: 'image', attrs: { src } }).run()
  } catch (error) {
    window.alert(`无法上传图片到存储源。${error instanceof Error ? error.message : ''}`)
  }
}

function runImagePaste(event: ClipboardEvent, tiptapEditor: Editor) {
  if (!shouldHandleImagePaste(event)) return false
  event.preventDefault()
  event.stopImmediatePropagation()
  const page = activePage()
  if (!page) {
    window.alert('请先打开一个页面。')
    return true
  }
  if (!canStorePageAssets(page)) {
    window.alert('当前存储源不支持图片附件。请切换到本地/S3/后台工作区后再粘贴图片。')
    return true
  }
  void uploadPastedImage(page, event).then((src) => {
    tiptapEditor.chain().focus().setImage({ src }).run()
  }).catch((error) => {
    window.alert(error instanceof Error ? error.message : '无法上传图片到存储源。')
  })
  return true
}

function createTieImagePasteExtension() {
  return Extension.create({
    name: 'tieImagePaste',
    priority: 1000,
    addProseMirrorPlugins() {
      const tiptapEditor = this.editor
      return [
        new Plugin({
          props: {
            handlePaste(_view, event) {
              if (!(event instanceof ClipboardEvent)) return false
              return runImagePaste(event, tiptapEditor)
            },
            handleDrop(view, event) {
              if (!(event instanceof DragEvent)) return false
              const image = [...(event.dataTransfer?.files ?? [])].find((file) => isImageFile(file))
              if (!image) return false
              event.preventDefault()
              const dropPosition = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos ?? view.state.selection.from
              void insertImageInView(tiptapEditor, image, { mode: 'insert', position: dropPosition })
              return true
            },
          },
        }),
      ]
    },
  })
}

function stripInlineImageHtml(html: string) {
  return html.replace(/<img\b[^>]*\bsrc=["'](?:blob:|data:)[^"']*["'][^>]*>/gi, '')
}

/** Remove autolink marks on tie://asset/... so caret can sit mid-URL. */
function stripAssetAutolinks(currentEditor: Editor) {
  const linkType = currentEditor.schema.marks.link
  if (!linkType) return
  const { tr, doc } = currentEditor.state
  let changed = false
  doc.descendants((node, pos) => {
    if (!node.isText) return
    const mark = node.marks.find((item) => item.type === linkType)
    const href = String(mark?.attrs.href ?? '')
    const text = node.text ?? ''
    const isAssetLink = href.startsWith('tie://asset/')
      || href.startsWith('tie://') && !href.startsWith('tie://page/')
      || text.includes('tie://asset/')
    if (!mark || !isAssetLink) return
    tr.removeMark(pos, pos + node.nodeSize, linkType)
    changed = true
  })
  if (changed) currentEditor.view.dispatch(tr)
}

/**
 * 若 markdown 解析失败把 `![](tie://asset/...)` 留成纯文本，这里补成 image 节点。
 * 同时拆掉 asset URL 上的 link mark，避免光标点不进。
 */
function hydrateAssetMarkdownImages(currentEditor: Editor) {
  const imageType = currentEditor.schema.nodes.image
  if (!imageType) return
  const pattern = /!\[([^\]]*)\]\((tie:\/\/asset\/[^)\s]+)(?:\s+"([^"]*)")?\)/g
  type Replacement = { from: number; to: number; alt: string; src: string; title: string | null }
  const replacements: Replacement[] = []

  currentEditor.state.doc.descendants((node, pos) => {
    if (!node.isText || !node.text?.includes('tie://asset/')) return
    pattern.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = pattern.exec(node.text)) !== null) {
      const [raw, alt = '', src, title = null] = match
      if (!parseAssetUrl(src)) continue
      replacements.push({
        from: pos + match.index,
        to: pos + match.index + raw.length,
        alt,
        src,
        title,
      })
    }
  })

  stripAssetAutolinks(currentEditor)
  if (!replacements.length) return

  let tr = currentEditor.state.tr
  for (const item of [...replacements].sort((a, b) => b.from - a.from)) {
    const imageNode = imageType.create({
      src: item.src,
      alt: item.alt,
      title: item.title,
    })
    tr = tr.replaceWith(item.from, item.to, imageNode)
  }
  if (tr.docChanged) currentEditor.view.dispatch(tr)
}

let rewritingInlineImages = false
async function rewriteInlineImageNodes(currentEditor: Editor) {
  if (rewritingInlineImages || syncingExternalValue) return
  const page = activePage()
  if (!page || !canStorePageAssets(page)) return

  type Pending = { from: number; to: number; src: string; alt: string }
  const pending: Pending[] = []
  currentEditor.state.doc.descendants((node, pos) => {
    if (node.type.name !== 'image') return
    const src = String(node.attrs.src ?? '')
    if (!src.startsWith('blob:') && !src.startsWith('data:image/')) return
    pending.push({ from: pos, to: pos + node.nodeSize, src, alt: String(node.attrs.alt ?? '') })
  })
  if (!pending.length) return

  rewritingInlineImages = true
  try {
    let offset = 0
    for (const item of pending) {
      const file = await inlineImageSrcToFile(item.src)
      if (!file || !isImageFile(file) || file.size > 20 * 1024 * 1024) continue
      try {
        const assetSrc = await embedImageFile(page, file)
        const mappedFrom = item.from + offset
        const mappedTo = item.to + offset
        const node = currentEditor.state.schema.nodes.image.create({ src: assetSrc, alt: item.alt })
        currentEditor.view.dispatch(currentEditor.state.tr.replaceWith(mappedFrom, mappedTo, node))
        offset += node.nodeSize - (item.to - item.from)
      } catch {
        // keep original node if upload fails
      }
    }
  } finally {
    rewritingInlineImages = false
  }
}

function pickLocalImage(editor: Editor) {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'image/*'
  input.addEventListener('change', () => {
    const file = input.files?.[0]
    if (!file || !canEmbedImage(file)) return
    void insertImageFile(editor, file)
  }, { once: true })
  input.click()
}

const slashCommands: SlashCommand[] = [
  { id: 'text', label: '正文', hint: '普通段落', keywords: ['paragraph', '文字', '文本'], run: (editor) => editor.chain().focus().setParagraph().run() },
  { id: 'heading-2', label: '二级标题', hint: '章节标题', keywords: ['heading', '标题', 'h2'], run: (editor) => editor.chain().focus().toggleHeading({ level: 2 }).run() },
  { id: 'heading-3', label: '三级标题', hint: '小节标题', keywords: ['heading', '标题', 'h3'], run: (editor) => editor.chain().focus().toggleHeading({ level: 3 }).run() },
  { id: 'bullet-list', label: '无序列表', hint: '项目符号列表', keywords: ['list', '列表', 'bullet'], run: (editor) => editor.chain().focus().toggleBulletList().run() },
  { id: 'task-list', label: '待办事项', hint: '可勾选的任务', keywords: ['task', 'todo', '待办', '任务'], run: (editor) => editor.chain().focus().toggleTaskList().run() },
  { id: 'quote', label: '引用', hint: '突出一段内容', keywords: ['quote', '引用'], run: (editor) => editor.chain().focus().toggleBlockquote().run() },
  { id: 'code', label: '代码块', hint: '带语法标记的代码', keywords: ['code', '代码'], run: (editor) => editor.chain().focus().toggleCodeBlock().run() },
  { id: 'image', label: '图片', hint: '插入网络图片 URL', keywords: ['image', '图片', 'photo', '图像'], run: (editor) => {
    const src = window.prompt('图片 URL')?.trim()
    if (!src || rejectInlineImageUrl(src)) {
      if (src) window.alert('请使用网络图片 URL，或使用 /上传图片 保存到存储源。')
      return
    }
    if (src) editor.chain().focus().setImage({ src }).run()
  } },
  { id: 'image-upload', label: '上传图片', hint: '保存到存储源附件目录', keywords: ['image', '图片', 'upload', '上传', '本地图片'], run: (editor) => pickLocalImage(editor) },
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
  const anchor = target.closest<HTMLAnchorElement>('a[href^="tie://page/"]')
  const href = anchor?.getAttribute('href')
  const prefix = 'tie://page/'
  if (!href?.startsWith(prefix)) return false
  event.preventDefault()
  emit('navigate', href.slice(prefix.length))
  return true
}

function openExternalLink(event: MouseEvent) {
  const target = event.target
  if (!(target instanceof Element)) return false
  const href = target.closest('a')?.getAttribute('href')
  if (!href || !/^(https?:|mailto:)/i.test(href)) return false
  event.preventDefault()
  if ('__TAURI_INTERNALS__' in window) void openUrl(href)
  else window.open(href, '_blank', 'noopener,noreferrer')
  return true
}

function focusNextWritingLine(event: MouseEvent) {
  const current = editor.value
  const root = current?.view.dom
  if (!current || !root) return false

  const target = event.target
  if (!(target instanceof Element)) return false
  if (target.closest('.editor-embedded-meta, .page-picker, .slash-menu, button, input, textarea, a, img, label')) return false
  // 点在正文块内部时交给 ProseMirror 正常处理
  if (root.contains(target) && target !== root) return false

  const lastBlock = root.lastElementChild as HTMLElement | null
  if (lastBlock && event.clientY <= lastBlock.getBoundingClientRect().bottom + 1) return false

  event.preventDefault()
  const lastNode = current.state.doc.lastChild
  if (lastNode?.type.name === 'paragraph' && lastNode.content.size === 0) current.chain().focus('end').run()
  else current.chain().insertContentAt(current.state.doc.content.size, { type: 'paragraph' }).focus('end').run()
  return true
}

function handleEditorClick(event: MouseEvent) {
  const handled = openInternalLink(event) || openExternalLink(event) || focusNextWritingLine(event)
  if (handled) event.stopPropagation()
  return handled
}

function handleSurfaceClick(event: MouseEvent) {
  if (event.target !== event.currentTarget) return
  focusNextWritingLine(event)
}

let syncingExternalValue = false
const editor = useEditor({
  content: props.modelValue,
  contentType: 'markdown',
  extensions: [
    StarterKit.configure({
      codeBlock: false,
      link: {
        openOnClick: false,
        autolink: true,
        linkOnPaste: true,
        protocols: ['http', 'https', 'mailto', 'tie'],
        // Only wiki links use tie:// — never autolink asset URLs (blocks mid-URL caret).
        isAllowedUri: (url, { defaultValidate }) => {
          if (url.startsWith('tie://page/')) return true
          if (url.startsWith('tie://')) return false
          return defaultValidate(url)
        },
      },
    }),
    Markdown,
    CodeBlockLowlight.configure({ lowlight }),
    createAssetImageExtension().configure({ allowBase64: false, inline: true }),
    createTieImagePasteExtension(),
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
    transformPastedHTML: (html) => stripInlineImageHtml(html),
    transformPastedText: (text) => text.replace(/!\[[^\]]*\]\((blob:[^)\s]+|data:image\/[^)\s]+)\)/g, ''),
    handlePaste: (_view, event) => {
      const text = event.clipboardData?.getData('text/plain') ?? ''
      if (!/!\[[^\]]*\]\(tie:\/\/asset\//.test(text)) return false
      queueMicrotask(() => {
        const current = editor.value
        if (!current) return
        syncingExternalValue = true
        hydrateAssetMarkdownImages(current)
        syncingExternalValue = false
      })
      return false
    },
    handleDOMEvents: {
      click: (_view, event) => handleEditorClick(event),
    },
    handleKeyDown: (_view, event) => {
      if (showPagePicker.value && pagePickerMode.value === 'wiki') {
        if (!matchingPages.value.length && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
          event.preventDefault()
          return true
        }
        if (!matchingPages.value.length && event.key === 'Enter') {
          event.preventDefault()
          void createWikiPage()
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
  onCreate: ({ editor: currentEditor }) => {
    // 初始化清理不要当成用户编辑，避免一打开页面就触发自动保存刷 updatedAt。
    syncingExternalValue = true
    hydrateAssetMarkdownImages(currentEditor)
    syncingExternalValue = false
  },
  onUpdate: ({ editor: currentEditor }) => {
    if (!syncingExternalValue && !rewritingInlineImages) emit('update:modelValue', currentEditor.getMarkdown())
    updateMenus(currentEditor)
    void rewriteInlineImageNodes(currentEditor)
  },
  onSelectionUpdate: ({ editor: currentEditor }) => updateMenus(currentEditor),
})

watch(() => props.modelValue, (markdown) => {
  if (!editor.value || editor.value.getMarkdown() === markdown) return
  const selection = editor.value.state.selection
  syncingExternalValue = true
  editor.value.commands.setContent(markdown, { contentType: 'markdown', emitUpdate: false })
  hydrateAssetMarkdownImages(editor.value)
  const maxPos = editor.value.state.doc.content.size
  const from = Math.min(selection.from, maxPos)
  const to = Math.min(selection.to, maxPos)
  try {
    editor.value.commands.setTextSelection({ from, to })
  } catch {
    // ignore invalid selection after content swap
  }
  syncingExternalValue = false
})

watch(() => props.pages.map((page) => `${page.id}:${page.storageSourceId}:${(page.storageSourceIds ?? []).join(',')}`).join('|'), () => {
  refreshAssetImages()
})
watch(() => props.spellcheck, (enabled) => editor.value?.view.dom.setAttribute('spellcheck', String(enabled)))

function refreshAssetImages() {
  const root = editor.value?.view.dom
  if (!root) return
  root.querySelectorAll<HTMLImageElement>('img[data-tie-asset]').forEach((img) => {
    const asset = img.dataset.tieAsset
    if (!asset) return
    void resolveAssetDisplayUrl(props.pages, asset).then((url) => {
      if (img.dataset.tieAsset !== asset) return
      if (img.src !== url) img.src = url
    })
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

async function createWikiPage() {
  const title = wikiQuery.value.trim()
  if (!title) return
  const page = await props.createLinkedPage(title)
  insertPageLink(page)
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

function undo() { editor.value?.chain().focus().undo().run() }
function redo() { editor.value?.chain().focus().redo().run() }

function onPasteCapture(event: ClipboardEvent) {
  if (!editor.value || !shouldHandleImagePaste(event)) return
  runImagePaste(event, editor.value)
}

function findText(query: string, direction = 1) {
  const current = editor.value
  const cleanQuery = query.trim()
  if (!current || !cleanQuery) return { count: 0, index: 0 }
  const matches: Array<{ from: number; to: number }> = []
  const needle = cleanQuery.toLocaleLowerCase()
  current.state.doc.descendants((node, position) => {
    if (!node.isText || !node.text) return
    const text = node.text.toLocaleLowerCase()
    let offset = text.indexOf(needle)
    while (offset >= 0) {
      matches.push({ from: position + offset, to: position + offset + cleanQuery.length })
      offset = text.indexOf(needle, offset + Math.max(cleanQuery.length, 1))
    }
  })
  if (!matches.length) return { count: 0, index: 0 }
  const cursor = direction > 0 ? current.state.selection.to : current.state.selection.from
  let index = direction > 0
    ? matches.findIndex((match) => match.from >= cursor)
    : [...matches].map((match, matchIndex) => ({ match, matchIndex })).reverse().find((item) => item.match.to <= cursor)?.matchIndex ?? -1
  if (index < 0) index = direction > 0 ? 0 : matches.length - 1
  const match = matches[index]
  current.view.dispatch(current.state.tr.setSelection(TextSelection.create(current.state.doc, match.from, match.to)).scrollIntoView())
  current.commands.focus()
  return { count: matches.length, index: index + 1 }
}

onBeforeUnmount(() => editor.value?.destroy())

defineExpose({ undo, redo, findText, focusBlank: focusNextWritingLine })
</script>

<template>
  <div class="tiptap-editor" v-if="editor" @click="handleSurfaceClick" @paste.capture="onPasteCapture">
    <slot name="meta"></slot>
    <div v-if="showPagePicker" class="page-picker">
      <input v-if="pagePickerMode === 'slash'" v-model="pageQuery" autofocus placeholder="搜索并关联页面…" />
      <p v-else class="wiki-picker-hint">正在关联：<strong>{{ wikiQuery || '全部页面' }}</strong><small>↑↓ 选择，Enter 插入，Esc 取消</small></p>
      <button v-for="(page, index) in matchingPages" :key="page.id" :class="{ selected: pagePickerMode === 'wiki' && selectedPageIndex === index }" @mousedown.prevent="insertPageLink(page)">
        <span>{{ DEFAULT_PAGE_ICON }} {{ page.title }}</span><small>{{ sourceLabel(page) }} · {{ page.parentId ? '子页面' : '顶层页面' }}</small>
      </button>
      <button v-if="!matchingPages.length && pagePickerMode === 'wiki' && wikiQuery.trim()" class="page-picker-create" @mousedown.prevent="createWikiPage"><span>创建“{{ wikiQuery.trim() }}”</span><small>并插入页面链接</small></button>
      <p v-else-if="!matchingPages.length">没有匹配页面</p>
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
