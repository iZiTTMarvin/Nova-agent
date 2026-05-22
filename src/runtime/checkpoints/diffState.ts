/**
 * message 级 diff 状态构建器
 *
 * 统一负责从 checkpoint manifest + 当前工作区状态
 * 计算 renderer 需要的 diff 列表与审查状态。
 */
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { readManifest, getFilesDir } from './manifest'
import { computeFileDiff } from '../../shared/diff/compute'
import type { DiffEntry, DiffReviewStatus } from '../../shared/diff/types'

export interface MessageDiffsState {
  diffs: DiffEntry[]
  reviews: Record<string, DiffReviewStatus>
}

export function buildMessageDiffState(
  checkpointRoot: string,
  workspaceRoot: string,
  sessionId: string,
  messageId: string
): MessageDiffsState {
  const manifest = readManifest(checkpointRoot, sessionId, messageId)
  if (!manifest || manifest.status !== 'active') {
    return { diffs: [], reviews: {} }
  }

  const filesDir = getFilesDir(checkpointRoot, sessionId, messageId)
  const diffs: DiffEntry[] = []

  for (const relPath of manifest.modifiedFiles) {
    const backupPath = join(filesDir, relPath)
    const currentPath = join(workspaceRoot, relPath)

    if (!existsSync(backupPath)) continue
    const oldContent = readFileSync(backupPath, 'utf-8')
    const newContent = existsSync(currentPath) ? readFileSync(currentPath, 'utf-8') : ''
    diffs.push(computeFileDiff(relPath, oldContent, newContent, 'modified'))
  }

  for (const relPath of manifest.createdFiles) {
    const currentPath = join(workspaceRoot, relPath)
    if (!existsSync(currentPath)) continue
    const newContent = readFileSync(currentPath, 'utf-8')
    diffs.push(computeFileDiff(relPath, '', newContent, 'added'))
  }

  for (const relPath of manifest.deletedFiles) {
    const backupPath = join(filesDir, relPath)
    if (!existsSync(backupPath)) continue
    const oldContent = readFileSync(backupPath, 'utf-8')
    diffs.push(computeFileDiff(relPath, oldContent, '', 'deleted'))
  }

  const reviews = manifest.fileReviews ?? {}
  const visiblePaths = new Set(diffs.map(diff => diff.filePath))
  const filteredReviews: Record<string, DiffReviewStatus> = {}

  for (const [filePath, status] of Object.entries(reviews)) {
    if (visiblePaths.has(filePath) || status === 'rejected') {
      filteredReviews[filePath] = status
    }
  }

  return {
    diffs,
    reviews: filteredReviews
  }
}
