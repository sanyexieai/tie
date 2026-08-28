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
  if (file.type === 'image/png') return 'png'
  if (file.type === 'image/jpeg') return 'jpg'
  if (file.type === 'image/gif') return 'gif'
  if (file.type === 'image/webp') return 'webp'
  if (file.type === 'image/svg+xml') return 'svg'
  return 'bin'
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
  const assetName = `${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}.${extensionFromFile(file)}`
  const data = new Uint8Array(await file.arrayBuffer())
  await writePageAsset(page, assetName, data)
  return buildAssetUrl(page.id, assetName)
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

export async function embedImageFile(page: Page, file: File) {
  if (canStorePageAssets(page)) return uploadPageImage(page, file)
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.addEventListener('load', () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('无法读取图片')))
    reader.addEventListener('error', () => reject(reader.error))
    reader.readAsDataURL(file)
  })
}
