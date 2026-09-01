import type { Page, PageRevision, StorageKind, StorageSource } from '@/types'

export interface StorageCapabilities {
  load: boolean
  save: boolean
  delete: boolean
  transfer: boolean
  revisions: boolean
  import: boolean
  remote: boolean
  manageConnection: boolean
}

export type SourceState = 'idle' | 'loading' | 'syncing' | 'error' | 'offline' | 'queued'

export interface SourceRuntimeStatus {
  sourceId: string
  state: SourceState
  lastSyncedAt: string | null
  lastError: string | null
  pendingCount: number
}

export interface LoadPagesResult {
  pages: Page[]
  error?: string
}

export interface SyncConflict {
  pageId: string
  localUpdatedAt: string
  remoteUpdatedAt: string
}

export interface SyncResult {
  sourceId: string
  pages: Page[]
  added: string[]
  updated: string[]
  removed: string[]
  conflicts: SyncConflict[]
  unchanged: number
  error?: string
}

export interface SyncSourceContext {
  localPages?: Page[]
}

export interface SavePageOptions {
  expectedUpdatedAt?: string
  queueOnFailure?: boolean
  force?: boolean
  /** 物理写入目标源；frontmatter 仍以 page.storageSourceId 为主源 */
  writeSourceId?: string
}

export interface S3ConnectionInput {
  id?: string
  name: string
  endpoint: string
  bucket: string
  region?: string
  accessKey: string
  secretKey: string
}

export interface StorageAdapter {
  readonly kind: StorageKind | 'browser'
  readonly capabilities: StorageCapabilities
  matches(sourceId: string): boolean
  listSources(): StorageSource[]
  loadPages(sourceId: string): Promise<LoadPagesResult>
  savePage(page: Page, options?: SavePageOptions): Promise<Page>
  permanentlyDeletePages(sourceId: string, pages: Page[]): Promise<void>
  transferPage?(page: Page, targetSourceId: string): Promise<Page>
  listPageRevisions?(page: Page): Promise<PageRevision[]>
  readPageRevision?(page: Page, revisionId: string): Promise<Page>
  readLatestPage?(page: Page): Promise<Page | null>
  syncSource?(sourceId: string, context?: SyncSourceContext): Promise<SyncResult>
  renameSource?(sourceId: string, name: string): Promise<void>
  removeSource?(sourceId: string): Promise<void>
  saveConnection?(input: S3ConnectionInput): Promise<StorageSource>
  updateConnection?(sourceId: string, input: Partial<S3ConnectionInput>): Promise<StorageSource>
}

export function defaultSourceStatus(sourceId: string): SourceRuntimeStatus {
  return {
    sourceId,
    state: 'idle',
    lastSyncedAt: null,
    lastError: null,
    pendingCount: 0,
  }
}

export function isFileSourceId(sourceId: string) {
  return !sourceId.startsWith('backend:')
    && !sourceId.startsWith('backend-s3:')
    && !sourceId.startsWith('s3:')
    && sourceId !== 'source-demo-local'
}

export function isRemoteAdapter(adapter: StorageAdapter) {
  return adapter.capabilities.remote
}
