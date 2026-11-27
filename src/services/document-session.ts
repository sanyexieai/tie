import type { Page } from '@/types'

/** A protected document supplies plaintext to the editor and ciphertext to storage. */
export interface DocumentSession {
  readonly page: Page
  readonly locked: boolean
  readonly busy: boolean
  readonly error: string
  save(page: Page, force?: boolean): Promise<void>
  refresh(isCurrent?: () => boolean): Promise<void>
  latest(): Promise<Page | null>
  readRevision(revisionId: string): Promise<Page | null>
  restoreRevision(revisionId: string): Promise<void>
  createPage(title: string, parentId: string | null): Promise<Page>
  lock(): void
}
