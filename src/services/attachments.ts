import { invoke } from '@tauri-apps/api/core'
import type { Page } from '@/types'
import {
  backendService,
  isBackendManagedS3SourceId,
  isBackendSourceId,
  parseBackendProviderId,
  parseBackendWorkspaceId,
} from '@/services/backend'
import { isS3SourceId, s3ConnectionForSource } from '@/services/s3'
import { isFileSourceId } from '@/services/storage/types'

export const ASSET_URL_PREFIX = 'tie://asset/'

export function buildAssetUrl(pageId: string, assetName: string) {
  return `${ASSET_URL_PREFIX}${pageId}/${assetName}`
}

export function parseAssetUrl(src: string) {
  if (!src.startsWith(ASSET_URL_PREFIX)) return null
  const rest = src.slice(ASSET_URL_PREFIX.length)
  const slash = rest.indexOf('/')
  if (slash <= 0) return null
  const pageId = rest.slice(0, slash)
  const assetName = rest.slice(slash + 1)
  if (!pageId || !assetName) return null
  return { pageId, assetName }
}

export function collectAssetNamesFromMarkdown(markdown: string, pageId: string) {
  const names = new Set<string>()
  const pattern = new RegExp(`${ASSET_URL_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}${pageId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/([a-zA-Z0-9._-]+)`, 'g')
  for (const match of markdown.matchAll(pattern)) {
    if (match[1]) names.add(match[1])
  }
  return [...names]
}

export const EXPORT_ASSET_DIR = 'assets'

export function rewriteMarkdownAssetsForExport(
  markdown: string,
  pageId: string,
  assetDir = EXPORT_ASSET_DIR,
) {
  const pattern = new RegExp(
    `${ASSET_URL_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}${pageId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/([a-zA-Z0-9._-]+)`,
    'g',
  )
  return markdown.replace(pattern, `${assetDir}/$1`)
}

export interface PageExportBundle {
  markdown: string
  assets: Record<string, Uint8Array>
}

export async function preparePageExportBundle(page: Page): Promise<PageExportBundle> {
  const assetNames = collectAssetNamesFromMarkdown(page.markdown, page.id)
  const assets: Record<string, Uint8Array> = {}
  for (const assetName of assetNames) {
    try {
      assets[assetName] = new Uint8Array(await readPageAsset(page, assetName))
    } catch {
      // 跳过无法读取的附件，导出 Markdown 仍会重写为相对路径
    }
  }
  return {
    markdown: rewriteMarkdownAssetsForExport(page.markdown, page.id),
    assets,
  }
}

function extensionFromFile(file: File) {
  const fromName = file.name.split('.').pop()?.toLowerCase()
  if (fromName && /^[a-z0-9]+$/.test(fromName)) return fromName
  if (file.type) return extensionFromMime(file.type)
  return 'png'
}

function extensionFromMime(mime: string) {
  if (mime === 'image/png') return 'png'
  if (mime === 'image/jpeg') return 'jpg'
  if (mime === 'image/gif') return 'gif'
  if (mime === 'image/webp') return 'webp'
  if (mime === 'image/svg+xml') return 'svg'
  return 'png'
}

export function isImageFile(file: File) {
  return file.type.startsWith('image/') || /\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i.test(file.name)
}

export function normalizeImageFile(file: File, mimeHint?: string) {
  if (file.type.startsWith('image/')) return file
  if (mimeHint?.startsWith('image/')) {
    const ext = extensionFromMime(mimeHint)
    const name = file.name && file.name.includes('.') ? file.name : `paste-${Date.now()}.${ext}`
    return new File([file], name, { type: mimeHint })
  }
  const name = file.name && file.name.includes('.') ? file.name : `paste-${Date.now()}.png`
  const ext = name.split('.').pop()?.toLowerCase()
  const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
    : ext === 'gif' ? 'image/gif'
    : ext === 'webp' ? 'image/webp'
    : ext === 'svg' ? 'image/svg+xml'
    : ext === 'bmp' ? 'image/bmp'
    : ext === 'ico' ? 'image/x-icon'
    : 'image/png'
  return new File([file], name, { type: mime })
}

function mimeFromAssetName(assetName: string) {
  const extension = assetName.split('.').pop()?.toLowerCase()
  if (extension === 'png') return 'image/png'
  if (extension === 'jpg' || extension === 'jpeg') return 'image/jpeg'
  if (extension === 'gif') return 'image/gif'
  if (extension === 'webp') return 'image/webp'
  if (extension === 'svg') return 'image/svg+xml'
  return 'application/octet-stream'
}

function bytesToObjectUrl(bytes: ArrayBuffer | Uint8Array | number[], mime: string) {
  const copy = bytes instanceof ArrayBuffer
    ? new Uint8Array(bytes)
    : bytes instanceof Uint8Array
      ? new Uint8Array(bytes)
      : new Uint8Array(bytes)
  return URL.createObjectURL(new Blob([copy], { type: mime }))
}

async function isTauri() {
  return '__TAURI_INTERNALS__' in window
}

export function canStorePageAssets(page: Page) {
  if (isBackendSourceId(page.storageSourceId) || isBackendManagedS3SourceId(page.storageSourceId)) {
    return Boolean(backendService.loadProfile().accessToken)
  }
  if (!('__TAURI_INTERNALS__' in window)) return false
  return isFileSourceId(page.storageSourceId) || isS3SourceId(page.storageSourceId)
}

async function readPageAsset(page: Page, assetName: string) {
  if (isBackendSourceId(page.storageSourceId)) {
    const profile = backendService.loadProfile()
    if (!profile.accessToken) throw new Error('请先连接自定义后台')
    return backendService.readWorkspacePageAsset(
      profile,
      parseBackendWorkspaceId(page.storageSourceId),
      page.id,
      assetName,
    )
  }
  if (isBackendManagedS3SourceId(page.storageSourceId)) {
    const profile = backendService.loadProfile()
    if (!profile.accessToken) throw new Error('请先连接自定义后台')
    return backendService.readProviderPageAsset(
      profile,
      parseBackendProviderId(page.storageSourceId),
      page.id,
      assetName,
    )
  }
  if (isS3SourceId(page.storageSourceId)) {
    const bytes = await invoke<number[]>('read_s3_page_asset', {
      connection: s3ConnectionForSource(page.storageSourceId),
      page,
      assetName,
    })
    return new Uint8Array(bytes).buffer
  }
  if (isFileSourceId(page.storageSourceId)) {
    const bytes = await invoke<number[]>('read_file_page_asset', { page, assetName })
    return new Uint8Array(bytes).buffer
  }
  throw new Error('该存储源不支持附件')
}

async function writePageAsset(page: Page, assetName: string, data: Uint8Array) {
  if (isBackendSourceId(page.storageSourceId)) {
    const profile = backendService.loadProfile()
    if (!profile.accessToken) throw new Error('请先连接自定义后台')
    await backendService.uploadWorkspacePageAsset(
      profile,
      parseBackendWorkspaceId(page.storageSourceId),
      page.id,
      assetName,
      data,
    )
    return
  }
  if (isBackendManagedS3SourceId(page.storageSourceId)) {
    const profile = backendService.loadProfile()
    if (!profile.accessToken) throw new Error('请先连接自定义后台')
    await backendService.uploadProviderPageAsset(
      profile,
      parseBackendProviderId(page.storageSourceId),
      page.id,
      assetName,
      data,
    )
    return
  }
  if (isS3SourceId(page.storageSourceId)) {
    if (!(await isTauri())) throw new Error('S3 附件仅支持桌面端')
    await invoke<string>('save_s3_page_asset', {
      connection: s3ConnectionForSource(page.storageSourceId),
      page,
      fileName: assetName,
      data: [...data],
    })
    return
  }
  if (isFileSourceId(page.storageSourceId)) {
    if (!(await isTauri())) throw new Error('附件上传仅支持桌面端')
    await invoke<string>('save_file_page_asset', { page, fileName: assetName, data: [...data] })
    return
  }
  throw new Error('该存储源不支持附件')
}

async function listPageAssetNames(page: Page, sourceId: string) {
  const names = new Set(collectAssetNamesFromMarkdown(page.markdown, page.id))
  if (isBackendSourceId(sourceId)) {
    const profile = backendService.loadProfile()
    if (profile.accessToken) {
      const listed = await backendService.listWorkspacePageAssets(profile, parseBackendWorkspaceId(sourceId), page.id)
      listed.forEach((name) => names.add(name))
    }
  } else if (isBackendManagedS3SourceId(sourceId)) {
    const profile = backendService.loadProfile()
    if (profile.accessToken) {
      const listed = await backendService.listProviderPageAssets(profile, parseBackendProviderId(sourceId), page.id)
      listed.forEach((name) => names.add(name))
    }
  } else if (isFileSourceId(sourceId) && await isTauri()) {
    const listed = await invoke<string[]>('list_file_page_assets', { page: { ...page, storageSourceId: sourceId } })
    listed.forEach((name) => names.add(name))
  } else if (isS3SourceId(sourceId) && await isTauri()) {
    const listed = await invoke<string[]>('list_s3_page_assets', {
      connection: s3ConnectionForSource(sourceId),
      page: { ...page, storageSourceId: sourceId },
    })
    listed.forEach((name) => names.add(name))
  }
  return [...names]
}

export async function copyPageAssets(page: Page, fromSourceId: string, toSourceId: string) {
  if (fromSourceId === toSourceId) return
  const sourcePage = { ...page, storageSourceId: fromSourceId }
  const targetPage = { ...page, storageSourceId: toSourceId }
  const assetNames = await listPageAssetNames(page, fromSourceId)
  for (const assetName of assetNames) {
    const data = new Uint8Array(await readPageAsset(sourcePage, assetName))
    await writePageAsset(targetPage, assetName, data)
  }
}

export async function uploadPageImage(page: Page, file: File) {
  if (!canStorePageAssets(page)) throw new Error('该存储源不支持附件上传')
  const normalized = normalizeImageFile(file)
  const assetName = `${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}.${extensionFromFile(normalized)}`
  const data = new Uint8Array(await normalized.arrayBuffer())
  await writePageAsset(page, assetName, data)
  return buildAssetUrl(page.id, assetName)
}

export async function embedImageFile(page: Page, file: File) {
  return uploadPageImage(page, file)
}

export function clipboardImageFile(event: ClipboardEvent) {
  const types = [...(event.clipboardData?.types ?? [])]
  const imageType = types.find((type) => type.startsWith('image/')) ?? null
  const fromFiles = [...(event.clipboardData?.files ?? [])]
  if (fromFiles.length) {
    const matched = fromFiles.find(isImageFile)
    if (matched) return matched
    if (imageType) {
      const first = fromFiles.find((file) => file.size > 0)
      if (first) return first
    }
  }
  for (const item of event.clipboardData?.items ?? []) {
    const candidate = item.getAsFile()
    if (!candidate || candidate.size <= 0) continue
    if (item.type.startsWith('image/') || item.kind === 'file') return candidate
  }
  return null
}

export function capturePastedImagePayload(event: ClipboardEvent) {
  const html = event.clipboardData?.getData('text/html') ?? ''
  const plain = event.clipboardData?.getData('text/plain') ?? ''
  const markdownMatch = plain.match(/!\[[^\]]*\]\((blob:[^)\s]+|data:image\/[^)\s]+)\)/)
  const types = [...(event.clipboardData?.types ?? [])]
  const mimeHint = types.find((type) => type.startsWith('image/')) ?? null
  const hasImageType = Boolean(mimeHint)
  let file = clipboardImageFile(event)
  if (!file && hasImageType) {
    for (const item of event.clipboardData?.items ?? []) {
      const candidate = item.getAsFile()
      if (candidate && candidate.size > 0) {
        file = candidate
        break
      }
    }
  }
  return {
    file,
    mimeHint,
    hasImageType,
    inlineSrc: inlineImageSrcFromHtml(html) ?? markdownMatch?.[1] ?? null,
  }
}

export async function resolvePastedImagePayload(payload: {
  file: File | null
  inlineSrc: string | null
  mimeHint?: string | null
}) {
  if (payload.file) return normalizeImageFile(payload.file, payload.mimeHint ?? undefined)
  if (!payload.inlineSrc) return null
  if (payload.inlineSrc.startsWith('data:image/')) {
    return dataUrlToFile(payload.inlineSrc) ?? inlineImageSrcToFile(payload.inlineSrc)
  }
  return inlineImageSrcToFile(payload.inlineSrc)
}

export function dataUrlToFile(src: string) {
  const match = src.match(/^data:(image\/[a-z+.-]+);base64,(.+)$/i)
  if (!match) return null
  const mime = match[1]
  const binary = atob(match[2])
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return new File([bytes], `paste-${Date.now()}.${extensionFromMime(mime)}`, { type: mime })
}

export function isTauriDesktop() {
  return '__TAURI_INTERNALS__' in window
}

function clipboardHasText(event: ClipboardEvent) {
  const plain = event.clipboardData?.getData('text/plain')?.trim() ?? ''
  const html = event.clipboardData?.getData('text/html')?.trim() ?? ''
  return Boolean(plain || html)
}

export async function readNativeClipboardImageFile() {
  if (!isTauriDesktop()) return null
  try {
    const { readImage } = await import('@tauri-apps/plugin-clipboard-manager')
    const image = await readImage()
    const { width, height } = await image.size()
    if (!width || !height) return null
    const rgba = await image.rgba()
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) return null
    const imageData = context.createImageData(width, height)
    imageData.data.set(rgba)
    context.putImageData(imageData, 0, 0)
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((value) => resolve(value), 'image/png')
    })
    if (!blob) return null
    return new File([blob], `paste-${Date.now()}.png`, { type: 'image/png' })
  } catch {
    return null
  }
}

export function shouldHandleImagePaste(event: ClipboardEvent) {
  if (clipboardHasPastedImage(event)) return true
  // WebKitGTK (Tauri on Linux) often omits image items from paste events.
  if (isTauriDesktop() && !clipboardHasText(event)) return true
  return false
}

export function clipboardHasPastedImage(event: ClipboardEvent) {
  const payload = capturePastedImagePayload(event)
  if (payload.file || payload.inlineSrc || payload.hasImageType) return true
  return [...(event.clipboardData?.items ?? [])].some((item) => item.kind === 'file' || item.type.startsWith('image/'))
}

export async function resolvePastedImageFromEvent(event: ClipboardEvent) {
  const payload = capturePastedImagePayload(event)
  const image = await resolvePastedImagePayload(payload)
  if (image) return image
  if (isTauriDesktop() && !clipboardHasText(event)) return readNativeClipboardImageFile()
  return null
}

export async function uploadPastedImage(page: Page, event: ClipboardEvent) {
  const image = await resolvePastedImageFromEvent(event)
  if (!image) throw new Error('无法读取剪贴板图片')
  if (!canStorePageAssets(page)) throw new Error('当前存储源不支持图片附件')
  if (image.size > 20 * 1024 * 1024) throw new Error('图片超过 20 MB')
  return embedImageFile(page, image)
}

function inlineImageExtension(mime: string) {
  if (mime === 'image/png') return 'png'
  if (mime === 'image/jpeg') return 'jpg'
  if (mime === 'image/gif') return 'gif'
  if (mime === 'image/webp') return 'webp'
  if (mime === 'image/svg+xml') return 'svg'
  return 'png'
}

export async function inlineImageSrcToFile(src: string) {
  if (!src.startsWith('blob:') && !src.startsWith('data:image/')) return null
  try {
    const response = await fetch(src)
    const blob = await response.blob()
    if (!blob.type.startsWith('image/')) return null
    const extension = inlineImageExtension(blob.type)
    return new File([blob], `paste-${Date.now()}.${extension}`, { type: blob.type })
  } catch {
    return null
  }
}

export function inlineImageSrcFromHtml(html: string) {
  const match = html.match(/<img\b[^>]*\bsrc=["']([^"']+)["']/i)
  const src = match?.[1]
  if (!src || (!src.startsWith('blob:') && !src.startsWith('data:image/'))) return null
  return src
}

export async function resolveAssetDisplayUrl(pages: Page[], src: string) {
  const parsed = parseAssetUrl(src)
  if (!parsed) return src
  const page = pages.find((item) => item.id === parsed.pageId)
  if (!page) return src
  try {
    const bytes = await readPageAsset(page, parsed.assetName)
    return bytesToObjectUrl(bytes, mimeFromAssetName(parsed.assetName))
  } catch {
    return src
  }
}
