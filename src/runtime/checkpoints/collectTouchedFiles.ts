/**
 * 按消息 id 聚合 checkpoint manifest 中的文件变更。
 * 只读、提交瞬间调用一次；不含编辑器手改与 skippedFiles。
 */
import type { TouchedFilesSnapshot } from '../sessions'
import { listManifests } from './restore'
import type { CheckpointManifest } from './types'

export const MAX_TOUCHED_FILES = 16


/** 合并 created/modified/deleted，去重保序；超出上限时保留省略数量。 */
export function collectTouchedFilesFromManifests(
  manifests: readonly Pick<
    CheckpointManifest,
    'messageId' | 'createdFiles' | 'modifiedFiles' | 'deletedFiles'
  >[],
  messageIds: ReadonlySet<string>,
  limit: number = MAX_TOUCHED_FILES
): TouchedFilesSnapshot {
  if (messageIds.size === 0 || limit <= 0) return { paths: [], omittedCount: 0 }
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

  if (ordered.length <= limit) return { paths: ordered, omittedCount: 0 }
  const paths = ordered.slice(0, Math.max(0, limit - 1))
  return {
    paths,
    omittedCount: ordered.length - paths.length
  }
}

export function collectTouchedFilesForSession(
  checkpointRoot: string,
  sessionId: string,
  messageIds: readonly string[]
): TouchedFilesSnapshot {
  if (messageIds.length === 0) return { paths: [], omittedCount: 0 }
  return collectTouchedFilesFromManifests(
    listManifests(checkpointRoot, sessionId),
    new Set(messageIds)
  )
}
