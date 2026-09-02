import type { Page } from '@/types'
import { pageContentEqual } from '@/services/page-sources'

export type SaveReconcileResult =
  | { action: 'proceed'; expectedUpdatedAt?: string; adoptRemoteTimestamp?: string }
  | { action: 'skip'; page: Page }
  | { action: 'conflict'; remote: Page }

/** 保存前对照远程版本，减少多客户端共用存储源时的误报冲突。 */
export function reconcileSaveAgainstRemote(
  baseline: Page,
  draft: Page,
  remote: Page,
): SaveReconcileResult {
  if (remote.updatedAt === baseline.updatedAt) {
    return { action: 'proceed', expectedUpdatedAt: baseline.updatedAt }
  }

  if (pageContentEqual(remote, baseline)) {
    return {
      action: 'proceed',
      expectedUpdatedAt: remote.updatedAt,
      adoptRemoteTimestamp: remote.updatedAt,
    }
  }

  if (pageContentEqual(draft, remote)) {
    return { action: 'skip', page: remote }
  }

  if (!pageContentEqual(draft, baseline)) {
    return { action: 'conflict', remote }
  }

  return { action: 'skip', page: remote }
}
