import type { Page, StorageSource } from '@/types'
import { migratePageLocalHrefs } from '@/services/local-links'
import { fileRootForSource } from '@/services/link-runtime'
import { blobStoreFor } from '@/services/storage/blobs'

/** One-shot data migrations — not for every load/save. */
export const WORKSPACE_MIGRATIONS = {
  /** file:/// → tie://path|file (+ sourceId backfill). */
  fileHrefProtocol: 'href-file-protocol-v1',
} as const

export type WorkspaceMigrationId = (typeof WORKSPACE_MIGRATIONS)[keyof typeof WORKSPACE_MIGRATIONS]

export const MIGRATIONS_RELATIVE_PATH = '.tie/migrations.json'
const LOCAL_FALLBACK_KEY = 'tie.workspace.migrations.applied'

function decodeJsonApplied(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed?.applied) ? parsed.applied.map(String) : []
  } catch {
    return []
  }
}

function readLocalFallback(): string[] {
  if (typeof localStorage === 'undefined') return []
  try {
    const raw = localStorage.getItem(LOCAL_FALLBACK_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    return []
  }
}

function writeLocalFallback(ids: string[]) {
  if (typeof localStorage === 'undefined') return
  localStorage.setItem(LOCAL_FALLBACK_KEY, JSON.stringify([...new Set(ids)]))
}

function stampSource(sources: StorageSource[]) {
  return sources.find((source) => fileRootForSource(source) && blobStoreFor(source).readRelative && blobStoreFor(source).writeRelative)
}

async function readApplied(sources: StorageSource[]): Promise<string[]> {
  const source = stampSource(sources)
  if (source && blobStoreFor(source).readRelative) {
    try {
      const bytes = await blobStoreFor(source).readRelative!(source, MIGRATIONS_RELATIVE_PATH)
      const fromDisk = decodeJsonApplied(new TextDecoder().decode(bytes))
      if (fromDisk.length) return fromDisk
    } catch {
      // missing stamp file is fine
    }
  }
  return readLocalFallback()
}

async function writeApplied(sources: StorageSource[], ids: string[]) {
  const unique = [...new Set(ids)]
  writeLocalFallback(unique)
  const source = stampSource(sources)
  if (!source || !blobStoreFor(source).writeRelative) return
  try {
    const body = `${JSON.stringify({ applied: unique }, null, 2)}\n`
    await blobStoreFor(source).writeRelative!(source, MIGRATIONS_RELATIVE_PATH, new TextEncoder().encode(body))
  } catch (error) {
    console.warn('[tie] could not write migration stamp to workspace', error)
  }
}

export async function isWorkspaceMigrationApplied(
  id: WorkspaceMigrationId | string,
  sources: StorageSource[] = [],
) {
  return (await readApplied(sources)).includes(id)
}

export interface FileHrefMigrationHost {
  pages: Page[]
  sources: StorageSource[]
  persistPage: (page: Page) => Promise<void>
  adoptPageMarkdown?: (pageId: string, markdown: string) => void
}

/**
 * Run file:/// → tie:// once per workspace stamp.
 * Call from startup; no-ops after `.tie/migrations.json` records the id.
 *
 * Stamps **before** rewriting so a hang never bricks every launch.
 * One-shot only rewrites paths inside a storage root (cheap). Zone-external
 * `file:///` are left for Agent (`tie-update` / `tie_migration_status`).
 */
export async function runFileHrefMigrationOnce(host: FileHrefMigrationHost): Promise<{
  ran: boolean
  pages: number
  converted: number
  skipped: string[]
}> {
  const id = WORKSPACE_MIGRATIONS.fileHrefProtocol
  if (await isWorkspaceMigrationApplied(id, host.sources)) {
    return { ran: false, pages: 0, converted: 0, skipped: [] }
  }

  // Stamp first — never re-enter after a partial/hung run.
  await writeApplied(host.sources, [...(await readApplied(host.sources)), id])

  let pagesTouched = 0
  let converted = 0
  const skipped: string[] = []

  for (const page of host.pages) {
    if (page.deletedAt) continue
    if (!/file:\/\//i.test(page.markdown)) continue
    try {
      const result = await migratePageLocalHrefs(page, host.sources, { ingestExternal: false })
      skipped.push(...result.skipped)
      converted += result.converted
      if (result.page.markdown === page.markdown) continue
      pagesTouched += 1
      host.adoptPageMarkdown?.(page.id, result.page.markdown)
      await host.persistPage({ ...page, ...result.page, id: page.id })
    } catch (error) {
      console.warn('[tie] file:/// migration failed for page', page.id, error)
    }
  }

  if (pagesTouched > 0 || converted > 0 || skipped.length > 0) {
    console.info(
      `[tie] migration ${id}: pages=${pagesTouched} converted=${converted} skipped=${skipped.length}`,
    )
  }
  return { ran: true, pages: pagesTouched, converted, skipped }
}
