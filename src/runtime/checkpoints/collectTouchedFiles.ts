/**
 * 按消息 id 聚合 checkpoint manifest 中的文件变更。
 * 只读、提交瞬间调用一次；不含编辑器手改与 skippedFiles。
 */
import type { CheckpointManifest } from './types'

export const MAX_TOUCHED_FILES = 16

const TOUCHED_OVERFLOW_PREFIX = '…另 '

export function isTouchedFilesOverflowMarker(entry: string): boolean {
  return entry.startsWith(TOUCHED_OVERFLOW_PREFIX)
}

/** 合并 created/modified/deleted，去重保序；超出上限时末条为「…另 N 个文件」。 */
export function collectTouchedFilesFromManifests(
  manifests: readonly Pick<
    CheckpointManifest,
    'messageId' | 'createdFiles' | 'modifiedFiles' | 'deletedFiles'
  >[],
  messageIds: ReadonlySet<string>,
  limit: number = MAX_TOUCHED_FILES
): string[] {
  if (messageIds.size === 0 || limit <= 0) return []

  const seen = new Set<string>()
  const ordered: string[] = []
  for (const manifest of manifests) {
    if (!messageIds.has(manifest.messageId)) continue
    for (const relPath of [
      ...manifest.createdFiles,
      ...manifest.modifiedFiles,
      ...manifest.deletedFiles
    ]) {
      if (!relPath || seen.has(relPath)) continue
      seen.add(relPath)
      ordered.push(relPath)
    }
  }

  if (ordered.length <= limit) return ordered
  const kept = ordered.slice(0, Math.max(0, limit - 1))
  const overflow = ordered.length - kept.length
  kept.push(`${TOUCHED_OVERFLOW_PREFIX}${overflow} 个文件`)
  return kept
}
