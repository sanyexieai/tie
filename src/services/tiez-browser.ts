/**
 * Browser `.tiez` pack/unpack — same tree layout as disk (`pages/` + `.tie/` + `*.tie`).
 */
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate'
import { isTieDocument, pageFromMeta, pageMetaText, parsePage } from '@/services/page-format'
import type { Page } from '@/types'

const DEMO_SOURCE_ID = 'source-demo-local'

export interface TiezImportResult {
  pages: Page[]
  solutionName: string | null
  fileCount: number
}

export interface TiezExportResult {
  filename: string
  blob: Blob
  files: number
}

function pageFileStem(title: string) {
  const stem = title
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+|\.+$/g, '')
    .slice(0, 80)
    .trim()
  return stem || '无标题'
}

function allocatePageName(title: string, used: Set<string>) {
  const stem = pageFileStem(title)
  let name = `${stem}.md`
  let n = 2
  while (used.has(name.toLocaleLowerCase())) {
    name = `${stem}-${n}.md`
    n += 1
  }
  used.add(name.toLocaleLowerCase())
  return name
}

function solutionText(name: string, sourceId: string) {
  return `# Tie solution — open with Tie / tie open\ntie_version: 1\nkind: solution\nname: ${name}\nroot: .\nsource_id: ${sourceId}\n`
}

function parseSolutionName(text: string): string | null {
  const match = text.match(/^name:\s*(.+)\s*$/m)
  const name = match?.[1]?.trim()
  return name || null
}

export function unpackTiezBytes(data: Uint8Array): TiezImportResult {
  const files = unzipSync(data)
  const pages: Page[] = []
  let solutionName: string | null = null
  let fileCount = 0

  const metaByFile = new Map<string, string>()
  const markdownFiles: Array<[string, string]> = []
  for (const [name, bytes] of Object.entries(files)) {
    const path = name.replace(/\\/g, '/').replace(/^\.\//, '')
    fileCount += 1
    const text = strFromU8(bytes)
    if (/^[^/]+\.tie$/i.test(path)) {
      solutionName = parseSolutionName(text) ?? solutionName
      continue
    }
    if (path.startsWith('.tie/meta/') && !path.endsWith('/')) {
      const relative = text.split(/\r?\n/).find((line) => line.startsWith('file: '))?.slice(6).trim().replace(/\\/g, '/')
      if (relative) metaByFile.set(relative, text)
      continue
    }
    if (path.startsWith('pages/') && path.toLowerCase().endsWith('.md')) markdownFiles.push([path, text])
  }
  for (const [path, text] of markdownFiles) {
    try {
      const page = isTieDocument(text)
        ? parsePage(text)
        : pageFromMeta(metaByFile.get(path) ?? '', text)
      if (!page) continue
      page.storageSourceId = DEMO_SOURCE_ID
      page.storageSourceIds = [DEMO_SOURCE_ID]
      pages.push(page)
    } catch {
      /* skip invalid */
    }
  }

  if (!pages.length) throw new Error('压缩包内没有有效的 pages/*.md')
  return { pages, solutionName, fileCount }
}

export async function unpackTiezFile(file: File): Promise<TiezImportResult> {
  const buffer = new Uint8Array(await file.arrayBuffer())
  return unpackTiezBytes(buffer)
}

export function packPagesToTiez(
  pages: Page[],
  options?: { name?: string; filename?: string },
): TiezExportResult {
  const name = options?.name?.trim() || '浏览器演示工作区'
  const solutionName = `${pageFileStem(name)}.tie`
  const files: Record<string, Uint8Array> = {
    [solutionName]: strToU8(solutionText(name, DEMO_SOURCE_ID)),
  }
  const used = new Set<string>()
  for (const page of pages) {
    const filename = allocatePageName(page.title, used)
    const relative = `pages/${filename}`
    files[relative] = strToU8(page.markdown ?? '')
    if (/^pg_[A-Za-z0-9_]+$/.test(page.id)) {
      files[`.tie/meta/${page.id}`] = strToU8(pageMetaText(page, relative))
    }
  }
  const zipped = zipSync(files, { level: 6 })
  const filename = options?.filename?.endsWith('.tiez')
    ? options.filename
    : `${(options?.filename || name).replace(/[\\/:*?"<>|]/g, '-').slice(0, 60) || 'workspace'}.tiez`
  return {
    filename,
    blob: new Blob([zipped], { type: 'application/zip' }),
    files: Object.keys(files).length,
  }
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

export async function pickTiezFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.tiez,application/zip'
    input.onchange = () => resolve(input.files?.[0] ?? null)
    input.click()
  })
}
