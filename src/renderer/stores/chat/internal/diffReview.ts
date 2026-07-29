import type { DiffReviewStatus } from '../../../../shared/diff/types'
import type { MessageDiffCache } from '../types'

/** 把单条 diff 文件标记为某个 review 状态（若该文件尚未进入 diffs 列表则先追加占位） */
export function applyDiffReviewStatus(
  cache: MessageDiffCache,
  filePath: string,
  status: DiffReviewStatus
): MessageDiffCache {
  const existingDiff = cache.diffs.find(diff => diff.filePath === filePath)
  const nextDiffs = existingDiff
    ? cache.diffs
    : [...cache.diffs, { filePath, hunks: [], status: 'modified' as const }]

  return {
    diffs: nextDiffs,
    reviews: { ...cache.reviews, [filePath]: status }
  }
}
