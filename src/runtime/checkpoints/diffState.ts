/**
 * message 级 diff 状态构建器
 *
 * 统一负责从 checkpoint manifest + 当前工作区状态
 * 计算 renderer 需要的 diff 列表与审查状态。
 * 每个工作区文件只读一次：diff 文本与 currentDigest 都来自这次读取，
 * 保证「用户看到的版本」与「拒绝时比对的摘要」一致。
 */
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { readManifest, getFilesDir } from './manifest'
import { computeFileDiff } from '../../shared/diff/compute'
import { digestFileBytes } from './fileDigest'
import type { DiffEntry, DiffReviewStatus, MessageDiffsState } from '../../shared/diff/types'

export function buildMessageDiffState(
  checkpointRoot: string,
  workspaceRoot: string,
  sessionId: string,
  messageId: string
): MessageDiffsState {
  const manifest = readManifest(checkpointRoot, sessionId, messageId)
  if (!manifest || manifest.status !== 'active') {
    return { diffs: [], reviews: {}, skippedFiles: [] }
  }

  const filesDir = getFilesDir(checkpointRoot, sessionId, messageId)
  const diffs: DiffEntry[] = []
  const reviews = manifest.fileReviews ?? {}

  /** 工作区文件单次读取：返回字节，缺返回 null */
  const readCurrentOnce = (relPath: string): Buffer | null => {
    const currentPath = join(workspaceRoot, relPath)
    return existsSync(currentPath) ? readFileSync(currentPath) : null
  }

  /** 备份与当前字节一致且未经审查：净变化为零，不产生 diff（审查过的保留以展示审查结果） */
  const isUnchanged = (relPath: string, backup: Buffer, current: Buffer | null): boolean =>
    current !== null && reviews[relPath] === undefined && backup.equals(current)

  for (const relPath of manifest.modifiedFiles) {
    const backupPath = join(filesDir, relPath)

    if (!existsSync(backupPath)) continue
    const backup = readFileSync(backupPath)
    const currentBytes = readCurrentOnce(relPath)
    if (isUnchanged(relPath, backup, currentBytes)) continue
    diffs.push({
      ...computeFileDiff(relPath, backup.toString('utf-8'), currentBytes?.toString('utf-8') ?? '', 'modified'),
      currentDigest: currentBytes === null ? null : digestFileBytes(currentBytes)
    })
  }

  for (const relPath of manifest.createdFiles) {
    const currentBytes = readCurrentOnce(relPath)
    if (currentBytes === null) continue
    diffs.push({
      ...computeFileDiff(relPath, '', currentBytes.toString('utf-8'), 'added'),
      currentDigest: digestFileBytes(currentBytes)
    })
  }

  for (const relPath of manifest.deletedFiles) {
    const backupPath = join(filesDir, relPath)
    if (!existsSync(backupPath)) continue
    const backup = readFileSync(backupPath)
    const currentBytes = readCurrentOnce(relPath)
    if (isUnchanged(relPath, backup, currentBytes)) continue
    const status = currentBytes === null ? 'deleted' : 'modified'
    diffs.push({
      ...computeFileDiff(relPath, backup.toString('utf-8'), currentBytes?.toString('utf-8') ?? '', status),
      currentDigest: currentBytes === null ? null : digestFileBytes(currentBytes)
    })
  }

  const visiblePaths = new Set(diffs.map(diff => diff.filePath))
  const filteredReviews: Record<string, DiffReviewStatus> = {}

  for (const [filePath, status] of Object.entries(reviews)) {
    if (visiblePaths.has(filePath) || status === 'rejected') {
      filteredReviews[filePath] = status
    }
  }

  return {
    diffs,
    reviews: filteredReviews,
    skippedFiles: manifest.skippedFiles ?? []
  }
}
