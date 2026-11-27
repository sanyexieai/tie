<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { EditorContent, useEditor } from '@tiptap/vue-3'
import type { Editor } from '@tiptap/core'
import { Extension, mergeAttributes } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { TextSelection } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import StarterKit from '@tiptap/starter-kit'
import Link from '@tiptap/extension-link'
import { TieCodeBlock } from '@/extensions/code-block'
import { WikiLink, wikiPageHref } from '@/extensions/wiki-link'
import Placeholder from '@tiptap/extension-placeholder'
import Image from '@tiptap/extension-image'
import { TieTable } from '@/extensions/table'
import TableCell from '@tiptap/extension-table-cell'
import TableHeader from '@tiptap/extension-table-header'
import TableRow from '@tiptap/extension-table-row'
import TaskItem from '@tiptap/extension-task-item'
import TaskList from '@tiptap/extension-task-list'
import { Markdown } from '@tiptap/markdown'
import { common, createLowlight } from 'lowlight'
import { openUrl } from '@tauri-apps/plugin-opener'
import type { Page, StorageSource } from '@/types'
import { focusPheromone, pheromoneRevision, pheromoneState, pheromonesFor, startPheromoneDraft, type PheromoneKind } from '@/services/pheromone'
import { DEFAULT_PAGE_ICON } from '@/constants/page'
import { canStorePageAssets, embedImageFile, inlineImageSrcToFile, isImageFile, normalizeImageFile, parseAssetUrl, resolveAssetDisplayUrl, resolvePastedImageFromEvent, shouldHandleImagePaste, uploadPastedImage } from '@/services/attachments'
import { isProtectedImageDataUrl, protectedImageDataUrl } from '@/services/protected-images'
import { cachedFileResource, canRebindRegisteredFile, listRegisteredFiles, probeRelativePath, resolveRegisteredFile } from '@/services/files'
import { fileIdFromFilesRelative } from '@/services/storage/blobs-path'
import type { SyncedResources } from '@/services/backend-sync'
import { pickLinkedResource, linkableSources, rebindLinkedResource, sourceChipLabel } from '@/services/link-actions'
import {
  applyLocalLinkClasses,
  buildPathUrl,
  classifyLocalLink,
  openLocalLink,
  PATH_URL_PREFIX,
  pastedTextToHtml,
  rewriteFileProtocolText,
  type LinkContext,
} from '@/services/local-links'
import {
  parseFileUrl,
  parsePathUrl,
  resolvedSourceId,
  sourceById,
} from '@/services/link-runtime'

const props = defineProps<{ modelValue: string; pages: Page[]; sources: StorageSource[]; pageId: string; spellcheck: boolean; createLinkedPage?: (title: string) => Promise<Page>; expandToChild?: (title: string) => Promise<Page>; enablePheromone?: boolean; backgroundStarted?: boolean; privateDocument?: boolean; protectedPageActions?: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [markdown: string]; navigate: [pageId: string]; 'create-child': [] }>()
const lowlight = createLowlight(common)
const assetRefreshers = new Map<HTMLImageElement, () => void>()
const pheromoneEnabled = computed(() => Boolean(props.enablePheromone && (!props.privateDocument || props.protectedPageActions)))
const showPagePicker = ref(false)
const pagePickerMode = ref<'slash' | 'wiki'>('slash')
const pageQuery = ref('')
const wikiQuery = ref('')
const wikiStart = ref<number | null>(null)
const selectedPageIndex = ref(0)
const slashQuery = ref<string | null>(null)
const contextMenu = ref<{ x: number; y: number; from: number; to: number; text: string; canExpand: boolean } | null>(null)
const slashStart = ref<number | null>(null)
const selectedCommandIndex = ref(0)
const linkSourcePicker = ref<{ kind: 'file' | 'directory' | 'relative' } | null>(null)
const selectedLinkSourceIndex = ref(0)
const floatingMenuStyle = ref<Record<string, string>>({ top: '0px', left: '0px' })
const SLASH_TRIGGER = /(?:^|\s)([/／、])([^\s]*)$/
const matchingPages = computed(() => {
  const query = (pagePickerMode.value === 'wiki' ? wikiQuery.value : pageQuery.value).trim().toLocaleLowerCase()
  return props.pages.filter((page) => !page.deletedAt && (!query || page.title.toLocaleLowerCase().includes(query))).slice(0, 8)
})
function sourceLabel(page: Page) {
  const source = props.sources.find((item) => item.id === page.storageSourceId)
  return source?.name || '未知工作区'
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

function pageSourceId() {
  return activePage()?.storageSourceId ?? null
}

function linkContext(): LinkContext {
  return { pageSourceId: pageSourceId(), sources: props.sources }
}

const linkTargetSources = computed(() => linkableSources(props.sources, pageSourceId()))

async function ensureWorkspaceFilesLoaded() {
  if (props.privateDocument || props.backgroundStarted === false) return
  const sourceIds = new Set<string>()
  const relatives: Array<{ sourceId: string; relativePath: string }> = []
  const pageId = pageSourceId()
  const context = linkContext()
  const dom = editor.value?.view.dom
  if (dom) {
    for (const anchor of dom.querySelectorAll<HTMLAnchorElement>('a[href]')) {
      const href = anchor.getAttribute('href') ?? ''
      const parsed = parseFileUrl(href)
      if (parsed) {
        sourceIds.add(parsed.sourceId || pageId || '')
        continue
      }
      const relative = parsePathUrl(href)
      if (!relative) continue
      const sourceId = relative.sourceId || pageId || ''
      if (sourceId) {
        sourceIds.add(sourceId)
        relatives.push({ sourceId, relativePath: relative.relativePath })
      }
    }
  }
  await Promise.all([...sourceIds].filter(Boolean).map(async (sourceId) => {
    const source = sourceById(props.sources, sourceId)
    if (!source) return
    try {
      await listRegisteredFiles(source)
    } catch {
      // ignore missing registry
    }
  }))
  await Promise.all(relatives.map(async ({ sourceId, relativePath }) => {
    const source = sourceById(context.sources, sourceId)
    if (!source) return
    try {
      await probeRelativePath(source, relativePath)
    } catch {
      // ignore
    }
  }))
}

function decorateFileLinks() {
  const context = linkContext()
  const dom = editor.value?.view.dom
  if (!dom) return
  for (const anchor of dom.querySelectorAll<HTMLAnchorElement>('a[href], a[data-wiki-title]')) {
    const wikiTitle = anchor.getAttribute('data-wiki-title')
    if (wikiTitle !== null) {
      // Page metadata can arrive later; resolving a title must not save or reset the document.
      const href = wikiPageHref(wikiTitle, props.pages)
      if (href) anchor.setAttribute('href', href)
      else anchor.removeAttribute('href')
      anchor.classList.toggle('wiki-link-unresolved', !href)
      anchor.title = href ? wikiTitle : `未找到唯一页面：${wikiTitle}`
    }
    const href = anchor.getAttribute('href') ?? ''
    // Strip legacy target=_blank so in-app schemes never spawn a browser tab.
    if (href.startsWith('tie://') || /^file:/i.test(href)) {
      anchor.removeAttribute('target')
    }
    if (!classifyLocalLink(href)) {
      const pageId = href.startsWith('tie://page/') ? href.slice('tie://page/'.length) : ''
      const linked = pageId ? props.pages.find((page) => page.id === pageId && !page.deletedAt) : null
      anchor.classList.toggle('child-page-card', Boolean(linked && linked.parentId === props.pageId))
      continue
    }
    anchor.classList.remove('child-page-card')
    applyLocalLinkClasses(anchor, href, context)
  }
}

let decorateFilesTimer: ReturnType<typeof setTimeout> | null = null
function scheduleDecorateFileLinks() {
  if (decorateFilesTimer) clearTimeout(decorateFilesTimer)
  decorateFilesTimer = setTimeout(() => {
    decorateFilesTimer = null
    decorateFileLinks()
    if (props.backgroundStarted === false) return
    void ensureWorkspaceFilesLoaded().then(() => decorateFileLinks())
  }, 40)
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
            if (!src || src.startsWith('blob:') || (src.startsWith('data:') && !isProtectedImageDataUrl(src))) return false
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
        if (props.privateDocument) {
          const dom = document.createElement('span')
          dom.className = 'tie-image-wrap'
          dom.contentEditable = 'false'
          let currentSrc: string | null = null
          const showImage = (attrs: typeof node.attrs) => {
            const src = String(attrs.src ?? '')
            if (src === currentSrc) return
            currentSrc = src
            dom.replaceChildren()
            if (isProtectedImageDataUrl(src)) {
              const image = document.createElement('img')
              image.className = 'tiptap-image'
              image.draggable = false
              image.alt = String(attrs.alt ?? '')
              image.src = src
              dom.appendChild(image)
            } else {
              // Preserve remote URLs as text instead of requesting them on unlock.
              dom.textContent = markdownForImageAttrs(attrs)
            }
          }
          showImage(node.attrs)
          return {
            dom,
            update: (updated) => {
              if (updated.type.name !== 'image') return false
              showImage(updated.attrs)
              return true
            },
          }
        }
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

        const applySrc = (nextSrc: string, refresh = false) => {
          currentSrc = nextSrc
          // 同一 src 已显示或正在加载时不要重置成「加载中」（NodeView update 很频繁）。
          if (!refresh && nextSrc && nextSrc === appliedSrc) return
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
                if (token !== loadToken || img.dataset.tieAsset !== nextSrc) {
                  if (url.startsWith('blob:')) URL.revokeObjectURL(url)
                  return
                }
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

        assetRefreshers.set(img, () => applySrc(currentSrc, true))
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
            assetRefreshers.delete(img)
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
  if (!props.privateDocument && (!page || !canStorePageAssets(page))) {
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
  if ((!props.privateDocument && !page) || !canEmbedImage(file)) return
  const pageId = props.pageId
  const privateDocument = props.privateDocument
  try {
    const src = props.privateDocument ? await protectedImageDataUrl(file) : await embedImageFile(page!, file)
    if (editor.isDestroyed || pageId !== props.pageId || privateDocument !== props.privateDocument) return
    editor.chain().focus().setImage({ src }).run()
  } catch (error) {
    window.alert(error instanceof Error ? error.message : '无法保存图片。')
  }
}

async function insertImageInView(
  currentEditor: Editor,
  file: File,
  options: { mode: 'replace' } | { mode: 'insert'; position: number },
) {
  const normalized = normalizeImageFile(file)
  const page = activePage()
  if ((!props.privateDocument && !page) || !canEmbedImage(normalized)) return
  const pageId = props.pageId
  const privateDocument = props.privateDocument
  try {
    const src = props.privateDocument ? await protectedImageDataUrl(normalized) : await embedImageFile(page!, normalized)
    if (currentEditor.isDestroyed || pageId !== props.pageId || privateDocument !== props.privateDocument) return
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
  if (props.privateDocument) {
    const pageId = props.pageId
    void resolvePastedImageFromEvent(event).then(async (image) => {
      if (tiptapEditor.isDestroyed || pageId !== props.pageId || !props.privateDocument) return
      if (!image) throw new Error('无法读取剪贴板图片')
      await insertImageFile(tiptapEditor, image)
    }).catch((error) => { window.alert(error instanceof Error ? error.message : '无法保存图片。') })
    return true
  }
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
  if (props.privateDocument) return html.replace(/<img\b[^>]*>/gi, (tag) => {
    const src = /\bsrc=["']([^"']*)["']/i.exec(tag)?.[1] ?? ''
    if (isProtectedImageDataUrl(src)) {
      const alt = (/\balt=["']([^"']*)["']/i.exec(tag)?.[1] ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!)
      return `<img src="${src}" alt="${alt}">`
    }
    return markdownForImageAttrs({ src }).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  })
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
      || (href.startsWith('tie://')
        && !href.startsWith('tie://page/')
        && !href.startsWith('tie://file/')
        && !href.startsWith(PATH_URL_PREFIX))
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
  if (props.privateDocument) return
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
  if (props.privateDocument || rewritingInlineImages || syncingExternalValue) return
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

function insertFileResourceLink(editor: Editor, title: string, href: string) {
  editor.chain().focus().insertContent({ type: 'text', text: title, marks: [{ type: 'link', attrs: { href } }] }).run()
  scheduleDecorateFileLinks()
}

function pickLocalFileLink(editor: Editor, kind: 'file' | 'directory', source: StorageSource) {
  void (async () => {
    try {
      const linked = await pickLinkedResource(kind, source)
      if (!linked) return
      insertFileResourceLink(editor, linked.title, linked.href)
    } catch (error) {
      window.alert(error instanceof Error ? error.message : String(error))
    }
  })()
}

function insertRelativePathLink(editor: Editor, source: StorageSource) {
  const raw = window.prompt('工作区相对路径（例如 docs/spec.pdf）')?.trim()
  if (!raw) return
  try {
    const href = buildPathUrl(raw, source.id)
    const title = raw.replace(/\\/g, '/').split('/').filter(Boolean).pop() || raw
    insertFileResourceLink(editor, title, href)
  } catch (error) {
    window.alert(error instanceof Error ? error.message : String(error))
  }
}

function closeLinkSourcePicker() {
  linkSourcePicker.value = null
  selectedLinkSourceIndex.value = 0
}

function beginLinkInsert(editor: Editor, kind: 'file' | 'directory' | 'relative') {
  if (props.privateDocument) return
  const targets = linkTargetSources.value
  if (!targets.length) {
    window.alert('没有可登记或引用文件的存储源')
    return
  }
  if (targets.length === 1) {
    if (kind === 'relative') insertRelativePathLink(editor, targets[0])
    else pickLocalFileLink(editor, kind, targets[0])
    return
  }
  const pageId = pageSourceId()
  const index = Math.max(0, targets.findIndex((source) => source.id === pageId))
  selectedLinkSourceIndex.value = index
  linkSourcePicker.value = { kind }
}

function confirmLinkSource(editor: Editor, source: StorageSource) {
  const kind = linkSourcePicker.value?.kind
  closeLinkSourcePicker()
  if (!kind) return
  if (kind === 'relative') insertRelativePathLink(editor, source)
  else pickLocalFileLink(editor, kind, source)
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
  { id: 'image-upload', label: '上传图片', hint: '从设备选择图片', keywords: ['image', '图片', 'upload', '上传', '本地图片'], run: (editor) => pickLocalImage(editor) },
  { id: 'table', label: '表格', hint: '插入 3 × 3 表格', keywords: ['table', '表格'], run: (editor) => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
  { id: 'divider', label: '分割线', hint: '分隔内容区域', keywords: ['divider', '分割', 'horizontal'], run: (editor) => editor.chain().focus().setHorizontalRule().run() },
  { id: 'page-link', label: '链接页面', hint: '关联知识库中的页面', keywords: ['link', 'page', '链接', '关联', '页面'], run: () => openSlashPagePicker() },
  { id: 'local-file', label: '文件', hint: '区内相对或导入副本，区外登记；可选手源', keywords: ['file', 'local', '文件', '本地', '链接', '登记', '跨源', '导入'], run: (editor) => beginLinkInsert(editor, 'file') },
  { id: 'local-directory', label: '目录', hint: '区内相对路径，区外登记；可选手源', keywords: ['folder', 'directory', '目录', '文件夹', '本地', '链接', '登记', '跨源'], run: (editor) => beginLinkInsert(editor, 'directory') },
  { id: 'relative-path', label: '相对路径', hint: '写入指定存储源的相对路径', keywords: ['relative', 'path', '相对', '路径', '工作区'], run: (editor) => beginLinkInsert(editor, 'relative') },
  { id: 'child-page', label: '子页面', hint: '在当前页面下创建空白子页面', keywords: ['page', 'child', '页面', '子页面'], run: () => emit('create-child') },
  { id: 'expand-child', label: '展开为子页面', hint: '用当前这句话做标题，并留在父页面', keywords: ['expand', 'turn', '展开', '子页面', '句子'], run: (editor) => { void expandParagraphToChild(editor) } },
]

const filteredCommands = computed(() => {
  const commands = props.privateDocument
    ? slashCommands.filter((command) => !['image', 'local-file', 'local-directory', 'relative-path', ...(!props.protectedPageActions ? ['child-page', 'expand-child'] : [])].includes(command.id))
    : slashCommands
  const query = slashQuery.value?.trim().toLocaleLowerCase() ?? ''
  if (!query) return commands
  return commands.filter((command) => [command.label, command.hint, ...command.keywords].some((value) => value.toLocaleLowerCase().includes(query)))
})

function anchorHrefFromEvent(event: MouseEvent) {
  const raw = event.target
  const el = raw instanceof Element ? raw : raw instanceof Node ? raw.parentElement : null
  if (!el) return null
  const anchor = el.closest('a')
  if (!anchor) return null
  // Prefer attribute: HTMLAnchorElement.href can resolve custom schemes against http://localhost.
  const attr = anchor.getAttribute('href')
  if (attr) return attr
  const prop = typeof (anchor as HTMLAnchorElement).href === 'string' ? (anchor as HTMLAnchorElement).href : ''
  if (/^(tie|file):/i.test(prop)) return prop
  return null
}

function linkMarkHrefFromEvent(event: MouseEvent) {
  const view = editor.value?.view
  if (!view) return null
  const coords = view.posAtCoords({ left: event.clientX, top: event.clientY })
  if (!coords) return null
  const marks = view.state.doc.resolve(coords.pos).marks()
  const link = marks.find((mark) => mark.type.name === 'link')
  const href = String(link?.attrs?.href ?? '').trim()
  return href || null
}

function resolveClickedHref(event: MouseEvent) {
  return anchorHrefFromEvent(event) || linkMarkHrefFromEvent(event)
}

function childCardForEvent(event: MouseEvent) {
  const root = editor.value?.view.dom
  if (!root) return null
  const raw = event.target
  const el = raw instanceof Element ? raw : raw instanceof Node ? raw.parentElement : null
  const direct = el?.closest('a.child-page-card')
  if (direct instanceof HTMLAnchorElement && root.contains(direct)) return direct
  let nearest: HTMLAnchorElement | null = null
  let best = Number.POSITIVE_INFINITY
  for (const card of root.querySelectorAll<HTMLAnchorElement>('a.child-page-card')) {
    const box = card.getBoundingClientRect()
    if (event.clientY < box.top - 4 || event.clientY > box.bottom + 4) continue
    const dx = event.clientX < box.left ? box.left - event.clientX : event.clientX > box.right ? event.clientX - box.right : 0
    if (dx < best) {
      best = dx
      nearest = card
    }
  }
  return nearest
}

function childTitleBounds(anchor: HTMLElement) {
  let left = Number.POSITIVE_INFINITY
  let right = Number.NEGATIVE_INFINITY
  let top = Number.POSITIVE_INFINITY
  let bottom = Number.NEGATIVE_INFINITY
  for (const node of anchor.childNodes) {
    if (node.nodeType !== Node.TEXT_NODE || !node.textContent?.trim()) continue
    const range = document.createRange()
    range.selectNodeContents(node)
    for (const rect of range.getClientRects()) {
      left = Math.min(left, rect.left)
      right = Math.max(right, rect.right)
      top = Math.min(top, rect.top)
      bottom = Math.max(bottom, rect.bottom)
    }
  }
  if (!Number.isFinite(left)) return null
  return { left: left - 22, right: right + 4, top: top - 4, bottom: bottom + 4 }
}

function hitChildTitle(anchor: HTMLElement, event: MouseEvent) {
  const bounds = childTitleBounds(anchor)
  if (!bounds) return false
  return event.clientX >= bounds.left && event.clientX <= bounds.right && event.clientY >= bounds.top && event.clientY <= bounds.bottom
}

function childLinkEnd(view: NonNullable<typeof editor.value>['view'], anchor: HTMLElement) {
  const href = anchor.getAttribute('href') || ''
  const pos = view.posAtDOM(anchor, 0)
  const linkType = view.state.schema.marks.link
  let end = -1
  const block = view.state.doc.resolve(pos)
  view.state.doc.nodesBetween(block.start(), block.end(), (node, nodePos) => {
    if (!node.isText) return
    const mark = node.marks.find((item) => item.type === linkType && item.attrs.href === href)
    if (!mark) return
    const nodeEnd = nodePos + node.nodeSize
    if (pos >= nodePos && pos <= nodeEnd) end = nodeEnd
  })
  return end
}

function placeCaretAfterChildTitle(anchor: HTMLElement) {
  const view = editor.value?.view
  if (!view) return
  try {
    const end = childLinkEnd(view, anchor)
    if (end < 0) return
    const linkType = view.state.schema.marks.link
    let tr = view.state.tr
    const next = tr.doc.resolve(end).nodeAfter
    const gapReady = next?.isText && next.text?.startsWith('\u200b') && !next.marks.some((mark) => mark.type === linkType)
    let caret = end + 1
    if (!gapReady) {
      tr = tr.insert(end, view.state.schema.text('\u200b'))
      tr = tr.removeMark(end, end + 1, linkType)
    }
    tr = tr.setSelection(TextSelection.create(tr.doc, caret)).setStoredMarks([])
    view.dispatch(tr)
    if (!view.hasFocus()) view.focus()
  } catch {
    view.focus()
  }
}

function shouldOpenFromPointerEvent(event: MouseEvent) {
  // `click` is primary-button only; `auxclick` is middle/other. Don't gate on event.button —
  // some WebKitGTK builds leave button unset on click and would silently no-op.
  return event.type === 'click' || event.type === 'auxclick'
}

function blankAfterChildTitle(anchor: HTMLElement, event: MouseEvent) {
  const view = editor.value?.view
  const bounds = childTitleBounds(anchor)
  if (!view || !bounds || event.clientX <= bounds.right) return false
  if (event.clientY < bounds.top || event.clientY > bounds.bottom) return false
  const coords = view.posAtCoords({ left: event.clientX, top: event.clientY })
  if (!coords) return false
  let linkEnd: number
  try {
    linkEnd = view.posAtDOM(anchor, anchor.childNodes.length)
  } catch {
    return false
  }
  // 点在标题之后的空白时，坐标会吸附到标题末尾；点到后面的别的文字则落在更后的位置。
  return coords.pos <= linkEnd
}

function openInternalLink(event: MouseEvent) {
  const card = childCardForEvent(event)
  if (card) {
    const onTitle = hitChildTitle(card, event)
    const onSameLineBlank = !onTitle && blankAfterChildTitle(card, event)
    if (!onTitle && !onSameLineBlank) return false
    event.preventDefault()
    event.stopPropagation()
    closeSlashMenu()
    closePagePicker()
    if (onTitle) {
      if (shouldOpenFromPointerEvent(event) && event.type === 'click') {
        const href = card.getAttribute('href') || ''
        const prefix = 'tie://page/'
        if (href.startsWith(prefix)) emit('navigate', href.slice(prefix.length))
      }
      return true
    }
    // 只在按下时放一次光标。等 click 再挪，会先在标题里闪一下。
    if (event.type === 'mousedown') placeCaretAfterChildTitle(card)
    return true
  }
  const href = resolveClickedHref(event)
  const prefix = 'tie://page/'
  if (!href?.startsWith(prefix)) return false
  event.preventDefault()
  event.stopPropagation()
  closeSlashMenu()
  closePagePicker()
  if (shouldOpenFromPointerEvent(event) && event.type === 'click') {
    emit('navigate', href.slice(prefix.length))
  }
  return true
}

function openLocalLinkFromEvent(event: MouseEvent) {
  const href = resolveClickedHref(event)
  if (!href || !classifyLocalLink(href)) return false
  event.preventDefault()
  event.stopPropagation()
  closeSlashMenu()
  closePagePicker()
  if (!shouldOpenFromPointerEvent(event) || event.type !== 'click') return true
  const context = linkContext()
  void openLocalLink(href, context).catch(async (error) => {
    if (props.privateDocument) {
      window.alert(error instanceof Error ? error.message : '无法打开本地链接')
      return
    }
    const link = classifyLocalLink(href)
    const source = sourceById(context.sources, link ? resolvedSourceId(link, context) : null)
    const resource = link?.fileId ? cachedFileResource(source?.id, link.fileId) : null
    if (source && link?.fileId && canRebindRegisteredFile(resource)) {
      const retry = window.confirm(`${error instanceof Error ? error.message : '找不到已登记文件'}。要重新绑定本机路径吗？`)
      if (!retry) return
      try {
        const rebound = await rebindLinkedResource(
          source,
          link.fileId,
          resource?.kind === 'directory' ? 'directory' : 'file',
        )
        if (!rebound) return
        scheduleDecorateFileLinks()
        await openLocalLink(href, context)
      } catch (rebindError) {
        window.alert(rebindError instanceof Error ? rebindError.message : '无法重新绑定')
      }
      return
    }
    window.alert(error instanceof Error ? error.message : '无法打开本地链接')
  })
  return true
}

function openExternalLink(event: MouseEvent) {
  const href = resolveClickedHref(event)
  if (!href || !/^(https?:|mailto:)/i.test(href)) return false
  event.preventDefault()
  event.stopPropagation()
  if (!shouldOpenFromPointerEvent(event) || event.type !== 'click') return true
  if ('__TAURI_INTERNALS__' in window) void openUrl(href)
  else window.open(href, '_blank', 'noopener,noreferrer')
  return true
}

/** Block WebView/OS from navigating unknown schemes (especially tie:// → system browser). */
function blockUnmanagedLinkNavigation(event: MouseEvent) {
  const href = resolveClickedHref(event)
  if (!href) return false
  if (/^(https?:|mailto:)/i.test(href)) return false
  event.preventDefault()
  event.stopPropagation()
  return true
}

function focusNextWritingLine(event: MouseEvent) {
  const current = editor.value
  const root = current?.view.dom
  if (!current || !root) return false

  const target = event.target
  if (!(target instanceof Element)) return false
  if (target.closest('.editor-embedded-meta, .page-picker, .slash-menu, button, input, textarea, a, img, label, .document-child-pages')) return false
  // 点在正文块内部时交给 ProseMirror 正常处理
  if (root.contains(target) && target !== root) return false

  const editorBox = root.getBoundingClientRect()
  // 点在编辑器可视区域下方（子页面列表等）时不要抢焦点
  if (event.clientY > editorBox.bottom + 1) return false

  const lastBlock = root.lastElementChild as HTMLElement | null
  if (lastBlock && event.clientY <= lastBlock.getBoundingClientRect().bottom + 1) return false

  event.preventDefault()
  const lastNode = current.state.doc.lastChild
  if (lastNode?.type.name === 'paragraph' && lastNode.content.size === 0) current.chain().focus('end').run()
  else current.chain().insertContentAt(current.state.doc.content.size, { type: 'paragraph' }).focus('end').run()
  return true
}

function handleEditorClick(event: MouseEvent) {
  const handled =
    openInternalLink(event)
    || openLocalLinkFromEvent(event)
    || openExternalLink(event)
    || blockUnmanagedLinkNavigation(event)
    || focusNextWritingLine(event)
  if (handled) event.stopPropagation()
  return handled
}

function handleEditorMouseDown(event: MouseEvent) {
  return openInternalLink(event)
    || openLocalLinkFromEvent(event)
    || openExternalLink(event)
    || blockUnmanagedLinkNavigation(event)
}

function handleSurfaceClick(event: MouseEvent) {
  if (event.target !== event.currentTarget) return
  focusNextWritingLine(event)
}

function chipClassForHref(href: string) {
  const value = String(href || '').trim()
  if (value.startsWith('tie://page/')) {
    const pageId = value.slice('tie://page/'.length)
    const linked = props.pages.find((page) => page.id === pageId && !page.deletedAt)
    if (linked && linked.parentId === props.pageId) return 'child-page-card'
  }
  if (value.startsWith(PATH_URL_PREFIX) || value.startsWith('tie://path/')) return 'file-link file-link-relative'
  if (value.startsWith('tie://file/') || /^file:/i.test(value)) return 'file-link file-link-absolute'
  return null
}

const tieLinkOptions = {
  openOnClick: false as const,
  autolink: true,
  linkOnPaste: true,
  protocols: ['http', 'https', 'mailto', 'tie'],
  // Never target=_blank: WebView would hand tie:// / file:// to the system browser.
  HTMLAttributes: {
    target: null,
    rel: 'noopener noreferrer nofollow',
  },
  // Only wiki / file / path links use tie:// — never autolink asset URLs (blocks mid-URL caret).
  isAllowedUri: (url: string, ctx: { defaultValidate: (url: string) => boolean }) => {
    const href = String(url || '')
    if (!href) return false
    if (href.startsWith('tie://page/')) return true
    if (href.startsWith('tie://file/')) return true
    if (href.startsWith(PATH_URL_PREFIX)) return true
    if (href.startsWith('tie://')) return false
    if (/^file:/i.test(href)) return false
    return ctx.defaultValidate(href)
  },
}

/** Bake relative/absolute chip classes into <a> so ProseMirror re-renders keep ADR styles. */
const TieLink = Link.extend({
  renderHTML({ HTMLAttributes }) {
    const href = String(HTMLAttributes.href || '')
    const allowed = this.options.isAllowedUri(href, {
      defaultValidate: (value: string) => Boolean(value),
      protocols: this.options.protocols,
      defaultProtocol: this.options.defaultProtocol,
    })
    const chip = allowed ? chipClassForHref(href) : null
    const attrs = mergeAttributes(
      this.options.HTMLAttributes,
      HTMLAttributes,
      chip ? { class: chip } : {},
      allowed ? {} : { href: '' },
    )
    return ['a', attrs, 0]
  },
}).configure(tieLinkOptions)

const pheromonePluginKey = new PluginKey('tie-pheromone')

function findQuoteRange(doc: ProseMirrorNode, quote: string): { from: number; to: number } | null {
  let found: { from: number; to: number } | null = null
  doc.descendants((node, pos) => {
    if (found || !node.isTextblock) return
    const index = node.textContent.indexOf(quote)
    if (index < 0) return
    found = { from: pos + 1 + index, to: pos + 1 + index + quote.length }
    return false
  })
  return found
}

function createPheromoneExtension() {
  return Extension.create({
    name: 'pheromoneMarks',
    addProseMirrorPlugins() {
      return [
        new Plugin({
          key: pheromonePluginKey,
          props: {
            decorations(state) {
              if (!pheromoneEnabled.value) return DecorationSet.empty
              const decorations = []
              for (const item of pheromonesFor(props.pageId, props.pages.find((page) => page.id === props.pageId)?.storageSourceId ?? '').filter((item) => item.status !== 'withdrawn')) {
                const range = findQuoteRange(state.doc, item.quote)
                if (!range || range.from >= range.to) continue
                decorations.push(Decoration.inline(range.from, range.to, {
                  class: `pheromone-mark pheromone-${item.kind}${item.id === pheromoneState.activeId ? ' is-active' : ''}`,
                  'data-pheromone-id': item.id,
                }))
              }
              decorations.sort((left, right) => left.from - right.from)
              return DecorationSet.create(state.doc, decorations)
            },
            handleClick(_view, _pos, event) {
              if (!pheromoneEnabled.value) return false
              const raw = event.target
              const element = raw instanceof Element ? raw : raw instanceof Node ? raw.parentElement : null
              const id = element?.closest('[data-pheromone-id]')?.getAttribute('data-pheromone-id')
              if (!id) return false
              focusPheromone(id)
              return false
            },
          },
        }),
      ]
    },
  })
}

let syncingExternalValue = false
const editor = useEditor({
  content: props.modelValue,
  contentType: 'markdown',
  extensions: [
    StarterKit.configure({
      codeBlock: false,
      link: false,
    }),
    TieLink,
    WikiLink.configure({ resolveHref: (title) => wikiPageHref(title, props.pages) }),
    Markdown,
    TieCodeBlock.configure({ lowlight }),
    createAssetImageExtension().configure({ allowBase64: true, inline: true }),
    createTieImagePasteExtension(),
    Placeholder.configure({ placeholder: '开始写作，支持 Markdown 快捷输入…' }),
    TaskList,
    TaskItem.configure({ nested: true }),
    TieTable.configure({ resizable: true }),
    TableRow,
    TableHeader,
    TableCell,
    createPheromoneExtension(),
  ],
  editorProps: {
    attributes: { class: 'tiptap-content', spellcheck: String(props.spellcheck) },
    transformPastedHTML: (html) => stripInlineImageHtml(html),
    transformPastedText: (text) => text.replace(/!\[[^\]]*\]\((blob:[^)\s]+|data:image\/[^)\s]+)\)/g, (image, src: string) => props.privateDocument && isProtectedImageDataUrl(src) ? image : ''),
    handlePaste: (_view, event) => {
      const text = event.clipboardData?.getData('text/plain') ?? ''
      const html = event.clipboardData?.getData('text/html') ?? ''
      if (!props.privateDocument && (/file:\/\//i.test(text) || /file:\/\//i.test(html))) {
        event.preventDefault()
        const fromPlain = /file:\/\//i.test(text)
        const payload = fromPlain ? text : html
        void rewriteFileProtocolText(payload, linkContext()).then(({ text: next, skipped }) => {
          const current = editor.value
          if (!current) return
          current.chain().focus().insertContent(fromPlain ? pastedTextToHtml(next) : next).run()
          scheduleDecorateFileLinks()
          if (skipped.length) {
            window.alert(`有 ${skipped.length} 条 file:/// 无法改写成工作区链接，已跳过。`)
          }
        }).catch((error) => {
          window.alert(error instanceof Error ? error.message : '无法改写 file:/// 链接')
        })
        return true
      }
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
      mousedown: (_view, event) => handleEditorMouseDown(event),
      auxclick: (_view, event) => handleEditorMouseDown(event),
      click: (_view, event) => handleEditorClick(event),
      compositionend: (_view) => {
        const current = editor.value
        if (current) updateMenus(current)
        return false
      },
    },
    handleKeyDown: (_view, event) => {
      if (contextMenu.value && event.key === 'Escape') {
        event.preventDefault()
        closeContextMenu()
        return true
      }
      // Windows 中文输入法在英文标点下直接输入 /；部分环境 key 为 Process，靠 onUpdate/compositionend 兜底。
      if ((event.key === '/' || event.key === '／' || event.key === '、' || event.code === 'Slash') && !event.ctrlKey && !event.metaKey && !event.altKey) {
        queueMicrotask(() => {
          const current = editor.value
          if (current) updateMenus(current)
        })
      }
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
      if (linkSourcePicker.value) {
        const targets = linkTargetSources.value
        if (!targets.length && ['ArrowDown', 'ArrowUp', 'Enter'].includes(event.key)) {
          event.preventDefault()
          return true
        }
        if (event.key === 'ArrowDown') {
          event.preventDefault()
          selectedLinkSourceIndex.value = (selectedLinkSourceIndex.value + 1) % targets.length
          return true
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault()
          selectedLinkSourceIndex.value = (selectedLinkSourceIndex.value - 1 + targets.length) % targets.length
          return true
        }
        if (event.key === 'Enter') {
          event.preventDefault()
          const current = editor.value
          const source = targets[selectedLinkSourceIndex.value]
          if (current && source) confirmLinkSource(current, source)
          return true
        }
        if (event.key === 'Escape') {
          event.preventDefault()
          closeLinkSourcePicker()
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
    scheduleDecorateFileLinks()
  },
  onUpdate: ({ editor: currentEditor }) => {
    if (!syncingExternalValue && !rewritingInlineImages) emit('update:modelValue', currentEditor.getMarkdown())
    updateMenus(currentEditor)
    void rewriteInlineImageNodes(currentEditor)
    scheduleDecorateFileLinks()
  },
  onSelectionUpdate: ({ editor: currentEditor }) => {
    updateMenus(currentEditor)
  },
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
  scheduleDecorateFileLinks()
})

watch(() => props.pages.map((page) => `${page.id}:${page.parentId ?? ''}:${page.deletedAt ?? ''}:${page.title}`).join('|'), () => {
  refreshAssetImages()
  scheduleDecorateFileLinks()
})
watch(() => props.spellcheck, (enabled) => editor.value?.view.dom.setAttribute('spellcheck', String(enabled)))
watch(() => props.pageId, () => scheduleDecorateFileLinks())
watch(() => props.backgroundStarted, (ready) => { if (ready) scheduleDecorateFileLinks() })
watch(() => pheromoneRevision(props.pageId, props.pages.find((page) => page.id === props.pageId)?.storageSourceId ?? ''), () => {
  if (!pheromoneEnabled.value) return
  const current = editor.value
  if (!current || current.isDestroyed) return
  current.view.dispatch(current.state.tr.setMeta('pheromone', true))
  const activeId = pheromoneState.activeId
  if (!activeId || !pheromoneState.panelOpen) return
  requestAnimationFrame(() => {
    document.querySelector(`[data-pheromone-id="${CSS.escape(activeId)}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  })
})
watch(() => props.sources.map((source) => `${source.id}:${source.path ?? ''}`).join('|'), () => scheduleDecorateFileLinks())

function refreshAssetImages(changes?: SyncedResources) {
  if (props.privateDocument) return
  for (const [img, refresh] of assetRefreshers) {
    const asset = parseAssetUrl(img.dataset.tieAsset ?? '')
    if (!asset) continue
    if (changes) {
      const page = props.pages.find((item) => item.id === asset.pageId)
      if (!changes.assetPageIds.includes(asset.pageId) || !page
        || ![page.storageSourceId, ...(page.storageSourceIds ?? [])].includes(changes.sourceId)) continue
    } else if (img.getAttribute('src')) continue
    refresh()
  }
}

async function onResourcesSynced(event: Event) {
  if (props.privateDocument) return
  const changes = (event as CustomEvent<SyncedResources>).detail
  if (!changes) return
  refreshAssetImages(changes)
  const source = sourceById(props.sources, changes.sourceId)
  const dom = editor.value?.view.dom
  if (!source || !dom || !changes.fileIds.length) return
  const ids = new Set<string>()
  const relatives: string[] = []
  for (const anchor of dom.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    const href = anchor.getAttribute('href') ?? ''
    const file = parseFileUrl(href)
    if (file && (file.sourceId || pageSourceId()) === changes.sourceId && changes.fileIds.includes(file.fileId)) ids.add(file.fileId)
    const path = parsePathUrl(href)
    if (path && (path.sourceId || pageSourceId()) === changes.sourceId && changes.fileIds.includes(fileIdFromFilesRelative(path.relativePath) ?? '')) relatives.push(path.relativePath)
  }
  await Promise.all([...ids].map((id) => resolveRegisteredFile(source, id).catch(() => null)))
  await Promise.all(relatives.map((path) => probeRelativePath(source, path).catch(() => null)))
  if (!editor.value?.isDestroyed) decorateFileLinks()
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

function selectionForMenu(currentEditor: Editor) {
  if (slashQuery.value !== null || showPagePicker.value) return null
  const { from, to, empty } = currentEditor.state.selection
  if (empty || from === to) return null
  const text = currentEditor.state.doc.textBetween(from, to, ' ').replace(/\s+/g, ' ').trim()
  const limit = pheromoneEnabled.value ? 280 : 120
  if (!text || text.length > limit) return null
  return { from, to, text, canExpand: text.length <= 120 && Boolean(props.expandToChild) }
}

function onEditorContextMenu(event: MouseEvent) {
  contextMenu.value = null
  const current = editor.value
  if (!current || (props.privateDocument && !props.protectedPageActions)) return
  if (!props.expandToChild && (!pheromoneEnabled.value)) return
  const selection = selectionForMenu(current)
  if (!selection) return
  if ((!pheromoneEnabled.value) && !selection.canExpand) return
  event.preventDefault()
  const menuWidth = 168
  const menuHeight = pheromoneEnabled.value ? 248 : 148
  contextMenu.value = {
    x: Math.max(8, Math.min(event.clientX, window.innerWidth - menuWidth - 8)),
    y: Math.max(8, Math.min(event.clientY, window.innerHeight - menuHeight - 8)),
    ...selection,
  }
}

function closeContextMenu() {
  contextMenu.value = null
}

function rangeForText(current: Editor, from: number, to: number, text: string) {
  const size = current.state.doc.content.size
  if (from >= 1 && to <= size && from < to) {
    const currentText = current.state.doc.textBetween(from, to, ' ').replace(/\s+/g, ' ').trim()
    if (currentText === text) return { from, to }
  }
  let found: { from: number; to: number } | null = null
  current.state.doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return
    let offset = node.text.indexOf(text)
    while (offset >= 0) {
      const start = pos + offset
      const end = start + text.length
      if (!found || Math.abs(start - from) < Math.abs(found.from - from)) found = { from: start, to: end }
      offset = node.text.indexOf(text, offset + text.length)
    }
  })
  return found
}

async function replaceRangeWithChildCard(current: Editor, from: number, to: number, text: string) {
  if ((props.privateDocument && !props.protectedPageActions) || !props.expandToChild) return
  const page = await props.expandToChild(text)
  const href = `tie://page/${page.id}`
  const range = rangeForText(current, from, to, text)
  if (!range) throw new Error('这段文字已经变化，没有写成子页面')
  const inserted = current.chain().focus().setTextSelection(range).insertContent({
    type: 'text',
    text,
    marks: [{ type: 'link', attrs: { href } }],
  }).run()
  if (!inserted) throw new Error('没有把原文替换成子页面')
  closeContextMenu()
  scheduleDecorateFileLinks()
}

let contextActionRunning = false

async function runContextAction(action: 'expand' | 'cut' | 'copy' | 'paste' | PheromoneKind) {
  if (contextActionRunning) return
  const current = editor.value
  const menu = contextMenu.value
  if (!current || !menu) return
  contextActionRunning = true
  const { from, to, text } = menu
  try {
    if (action === 'objection' || action === 'correction' || action === 'support') {
      if (!pheromoneEnabled.value) return
      closeContextMenu()
      startPheromoneDraft(props.pageId, text, action)
      return
    }
    if (action === 'expand') {
      closeContextMenu()
      await replaceRangeWithChildCard(current, from, to, text)
      return
    }
    if (action === 'copy') {
      await navigator.clipboard.writeText(text)
      closeContextMenu()
      return
    }
    if (action === 'cut') {
      await navigator.clipboard.writeText(text)
      closeContextMenu()
      const range = rangeForText(current, from, to, text)
      if (range) current.chain().focus().deleteRange(range).run()
      return
    }
    const pasted = await navigator.clipboard.readText()
    closeContextMenu()
    const range = rangeForText(current, from, to, text) ?? { from, to }
    current.chain().focus().setTextSelection(range).insertContent(pasted).run()
  } catch (error) {
    closeContextMenu()
    window.alert(error instanceof Error ? error.message : '展开为子页面失败')
  } finally {
    contextActionRunning = false
  }
}

async function expandParagraphToChild(current: Editor) {
  if (props.privateDocument && !props.protectedPageActions) return
  const { $from } = current.state.selection
  const text = $from.parent.textContent.replace(/\s+/g, ' ').trim()
  if (!text) {
    emit('create-child')
    return
  }
  try {
    await replaceRangeWithChildCard(current, $from.start(), $from.end(), text.slice(0, 120))
  } catch (error) {
    window.alert(error instanceof Error ? error.message : '展开为子页面失败')
  }
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
    updateFloatingMenuPosition(currentEditor, wikiStart.value)
    return
  }
  if (pagePickerMode.value === 'wiki') closePagePicker()
  updateSlashState(currentEditor, beforeCursor)
}

function updateFloatingMenuPosition(currentEditor: Editor, pos?: number | null) {
  const anchor = typeof pos === 'number' ? pos : currentEditor.state.selection.from
  let coords: { left: number; right: number; top: number; bottom: number }
  try {
    coords = currentEditor.view.coordsAtPos(Math.max(1, Math.min(anchor, currentEditor.state.doc.content.size)))
  } catch {
    return
  }
  const menuWidth = 330
  const preferredMaxHeight = 310
  const gap = 6
  const margin = 8
  let left = coords.left
  left = Math.min(left, window.innerWidth - menuWidth - margin)
  left = Math.max(margin, left)

  const spaceBelow = Math.max(0, window.innerHeight - coords.bottom - gap - margin)
  const spaceAbove = Math.max(0, coords.top - gap - margin)
  // 下方放得下完整菜单则向下；否则选空间更大的一侧
  const openAbove = spaceBelow < preferredMaxHeight && spaceAbove > spaceBelow
  const available = openAbove ? spaceAbove : spaceBelow
  const maxHeight = Math.max(1, Math.min(preferredMaxHeight, available))

  if (openAbove) {
    floatingMenuStyle.value = {
      top: 'auto',
      bottom: `${Math.round(window.innerHeight - coords.top + gap)}px`,
      left: `${Math.round(left)}px`,
      maxHeight: `${Math.round(maxHeight)}px`,
    }
  } else {
    floatingMenuStyle.value = {
      top: `${Math.round(coords.bottom + gap)}px`,
      bottom: 'auto',
      left: `${Math.round(left)}px`,
      maxHeight: `${Math.round(maxHeight)}px`,
    }
  }
}

function updateSlashState(currentEditor: Editor, textBeforeCursor?: string) {
  const { $from } = currentEditor.state.selection
  if ($from.parent.type.name === 'codeBlock') return closeSlashMenu()
  // 点击「/home/...」这类路径链接时，光标落在链接内会误触发斜杠菜单。
  if ($from.marks().some((mark) => mark.type.name === 'link')
    || ($from.nodeAfter?.marks.some((mark) => mark.type.name === 'link'))
    || ($from.nodeBefore?.marks.some((mark) => mark.type.name === 'link'))) {
    return closeSlashMenu()
  }
  const beforeCursor = textBeforeCursor ?? $from.parent.textContent.slice(0, $from.parentOffset)
  const match = beforeCursor.match(SLASH_TRIGGER)
  if (!match) return closeSlashMenu()
  const trigger = match[1]
  const query = match[2]
  // 路径片段（含 /）不是斜杠命令查询
  if (query.includes('/') || query.includes('／')) return closeSlashMenu()
  slashQuery.value = query
  slashStart.value = currentEditor.state.selection.from - query.length - trigger.length
  selectedCommandIndex.value = 0
  updateFloatingMenuPosition(currentEditor, slashStart.value)
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
  if (editor.value) updateFloatingMenuPosition(editor.value)
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
  if (!title || (props.privateDocument && !props.protectedPageActions) || !props.createLinkedPage) return
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

function onWindowPointerDown(event: PointerEvent) {
  const target = event.target
  const element = target instanceof Element ? target : target instanceof Node ? target.parentElement : null
  const menu = element?.closest('.editor-context-menu')
  if (menu) {
    const button = element?.closest('button')
    const action = button?.dataset.action
    if (event.button === 0 && button && (action === 'expand' || action === 'cut' || action === 'copy' || action === 'paste' || action === 'objection' || action === 'correction' || action === 'support')) {
      event.preventDefault()
      event.stopPropagation()
      void runContextAction(action)
    }
    return
  }
  contextMenu.value = null
}

onMounted(() => {
  window.addEventListener('pointerdown', onWindowPointerDown, true)
  window.addEventListener('tie:resources-synced', onResourcesSynced)
})
onBeforeUnmount(() => {
  window.removeEventListener('pointerdown', onWindowPointerDown, true)
  window.removeEventListener('tie:resources-synced', onResourcesSynced)
  if (decorateFilesTimer) clearTimeout(decorateFilesTimer)
  editor.value?.destroy()
})

defineExpose({ undo, redo, findText, focusBlank: focusNextWritingLine })
</script>

<template>
  <div class="tiptap-editor" v-if="editor" @click="handleSurfaceClick" @paste.capture="onPasteCapture" @contextmenu="onEditorContextMenu">
    <slot name="meta"></slot>
    <div v-if="showPagePicker" class="page-picker" :style="floatingMenuStyle">
      <input v-if="pagePickerMode === 'slash'" v-model="pageQuery" autofocus placeholder="搜索并关联页面…" />
      <p v-else class="wiki-picker-hint">正在关联：<strong>{{ wikiQuery || '全部页面' }}</strong><small>↑↓ 选择，Enter 插入，Esc 取消</small></p>
      <button v-for="(page, index) in matchingPages" :key="page.id" :class="{ selected: pagePickerMode === 'wiki' && selectedPageIndex === index }" @mousedown.prevent="insertPageLink(page)">
        <span>{{ DEFAULT_PAGE_ICON }} {{ page.title }}</span><small>{{ sourceLabel(page) }} · {{ page.parentId ? '子页面' : '顶层页面' }}</small>
      </button>
      <button v-if="(!privateDocument || protectedPageActions) && createLinkedPage && !matchingPages.length && pagePickerMode === 'wiki' && wikiQuery.trim()" class="page-picker-create" @mousedown.prevent="createWikiPage"><span>创建“{{ wikiQuery.trim() }}”</span><small>并插入页面链接</small></button>
      <p v-else-if="!matchingPages.length">没有匹配页面</p>
    </div>
    <div
      v-if="contextMenu"
      class="editor-context-menu"
      role="menu"
      :style="{ top: `${contextMenu.y}px`, left: `${contextMenu.x}px` }"
      @pointerdown.prevent.stop
      @mousedown.prevent.stop
      @contextmenu.prevent
    >
      <button v-if="contextMenu.canExpand" type="button" role="menuitem" data-action="expand">展开为子页面</button>
      <button v-if="pheromoneEnabled" type="button" role="menuitem" data-action="objection">提出异议</button>
      <button v-if="pheromoneEnabled" type="button" role="menuitem" data-action="correction">提出修正</button>
      <button v-if="pheromoneEnabled" type="button" role="menuitem" data-action="support">表示支持</button>
      <button type="button" role="menuitem" class="menu-split" data-action="cut">剪切</button>
      <button type="button" role="menuitem" data-action="copy">复制</button>
      <button type="button" role="menuitem" data-action="paste">粘贴</button>
    </div>
    <div v-if="slashQuery !== null" class="slash-menu" role="listbox" aria-label="插入块" :style="floatingMenuStyle">
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
    <div v-if="linkSourcePicker" class="slash-menu" role="listbox" aria-label="选择存储源" :style="floatingMenuStyle">
      <p class="slash-menu-caption">链接写到哪个存储源？</p>
      <button
        v-for="(source, index) in linkTargetSources"
        :key="source.id"
        :class="{ selected: selectedLinkSourceIndex === index }"
        @mousedown.prevent="editor && confirmLinkSource(editor, source)"
      >
        <span class="slash-command-icon">{{ sourceChipLabel(source).slice(0, 1) }}</span>
        <span>
          <strong>{{ source.name }}</strong>
          <small>{{ sourceChipLabel(source) }}{{ source.id === pageSourceId() ? ' · 当前页' : ' · 跨源' }}</small>
        </span>
      </button>
    </div>
    <EditorContent :editor="editor" />
  </div>
</template>
