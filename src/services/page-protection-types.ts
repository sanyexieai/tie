import type { Page } from '@/types'
import type { ReviewFile } from '@/services/review-service'

export interface PageProtectionBundle {
  sourceId?: string
  snapshot: string
  page: Page
  revisions: { id: string; page: Page }[]
  reviews: ReviewFile
  assets: { name: string; data: string }[]
}
