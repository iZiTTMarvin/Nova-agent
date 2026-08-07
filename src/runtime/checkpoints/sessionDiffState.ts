/**
 * 会话级 diff 状态构建器
 *
 * 消息级 checkpoint 以每条 assistant 消息为事务边界；本模块把整个会话
 * （子代理通常只有一两次 turn）的改动聚合为一份净 diff：
 * - 每个文件取「最早出现它的 manifest」的 backup 作为原始内容，与当前工作区对比；
 * - 合并携带 reviews（rejected 痕迹优先级最高，跨 manifest 保留）；
 * - messageIdByFile 记录每个文件可供 accept/reject 路由的 messageId。
 *
 * 与 buildMessageDiffState 共用 computeFileDiff 与读取路径，不复制第二份 diff 计算。
 */
import { existsSync, readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import type {
  DiffEntry,
  DiffReviewStatus,
  SessionMessageDiffsState,
  SkippedFileInfo
} from '../../shared/diff/types'
import { computeFileDiff } from '../../shared/diff/compute'
import { readManifest, getFilesDir } from './manifest'
import type { CheckpointManifest } from './types'

/** 文件在会话中最早一次出现时的身份信息 */
interface EarliestFileAppearance {
  messageId: string
  /** created 表示文件此前不存在，原始内容视为空 */
  op: 'created' | 'modified' | 'deleted'
}

/** 聚合出的单文件 diff 与可路由的 messageId（供 accept/reject） */
interface AggregatedFileDiff {
  entry: DiffEntry
  routeMessageId: string
}

export function buildSessionDiffState(
  checkpointRoot: string,
  workspaceRoot: string,
  sessionId: string
): SessionMessageDiffsState {
  const manifests = listActiveManifests(checkpointRoot, sessionId)
  const earliestByFile = new Map<string, EarliestFileAppearance>()
  const mergedReviews: Record<string, DiffReviewStatus> = {}
  const skippedByPath = new Map<string, SkippedFileInfo>()

  for (const manifest of manifests) {
    for (const relPath of manifest.modifiedFiles) {
      recordEarliest(earliestByFile, relPath, manifest.messageId, 'modified')
    }
    for (const relPath of manifest.deletedFiles) {
      recordEarliest(earliestByFile, relPath, manifest.messageId, 'deleted')
    }
    for (const relPath of manifest.createdFiles) {
      recordEarliest(earliestByFile, relPath, manifest.messageId, 'created')
    }
    for (const [filePath, status] of Object.entries(manifest.fileReviews ?? {})) {
      // rejected 痕迹必须保留且优先级最高；accepted 只在无冲突时记录
      if (status === 'rejected' || mergedReviews[filePath] !== 'rejected') {
        mergedReviews[filePath] = status
      }
    }
    for (const skipped of manifest.skippedFiles ?? []) {
      if (!skippedByPath.has(skipped.path)) skippedByPath.set(skipped.path, skipped)
    }
  }

  const diffs: DiffEntry[] = []
  const messageIdByFile: Record<string, string> = {}
  for (const [relPath, appearance] of earliestByFile) {
    const aggregated = buildAggregatedEntry(
      checkpointRoot,
      workspaceRoot,
      sessionId,
      relPath,
      appearance,
      manifests
    )
    if (!aggregated) continue
    diffs.push(aggregated.entry)
    messageIdByFile[relPath] = aggregated.routeMessageId
  }

  const visiblePaths = new Set(diffs.map((diff) => diff.filePath))
  const reviews: Record<string, DiffReviewStatus> = {}
  for (const [filePath, status] of Object.entries(mergedReviews)) {
    if (visiblePaths.has(filePath) || status === 'rejected') {
      reviews[filePath] = status
    }
  }

  return {
    diffs,
    reviews,
    skippedFiles: [...skippedByPath.values()],
    messageIdByFile
  }
}

/** 列出本会话所有 active manifest，按 createdAt 升序（同毫秒用 messageId 兜底）。 */
function listActiveManifests(checkpointRoot: string, sessionId: string): CheckpointManifest[] {
  const sessionDir = join(checkpointRoot, sessionId)
  let entries
  try {
    entries = readdirSync(sessionDir, { withFileTypes: true })
  } catch {
    return []
  }

  const manifests: CheckpointManifest[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const manifest = readManifest(checkpointRoot, sessionId, entry.name)
    // rolled-back 消息的改动已被还原，不参与聚合（与消息级口径一致）
    if (manifest && manifest.status === 'active') manifests.push(manifest)
  }
  return manifests.sort(
    (left, right) =>
      left.createdAt - right.createdAt || left.messageId.localeCompare(right.messageId)
  )
}

function recordEarliest(
  earliestByFile: Map<string, EarliestFileAppearance>,
  relPath: string,
  messageId: string,
  op: EarliestFileAppearance['op']
): void {
  // 只记录首次出现：最早消息的 backup 才是该文件在本会话内的原始内容
  if (!earliestByFile.has(relPath)) {
    earliestByFile.set(relPath, { messageId, op })
  }
}

/**
 * 计算单个文件的净 diff。
 * 滚动清理可能删除最早消息的 files/，此时沿 manifest 顺序回退到下一个
 * 仍持有 backup 的消息，保证 accept/reject 路由到的 checkpoint 可真正操作。
 */
function buildAggregatedEntry(
  checkpointRoot: string,
  workspaceRoot: string,
  sessionId: string,
  relPath: string,
  appearance: EarliestFileAppearance,
  manifests: CheckpointManifest[]
): AggregatedFileDiff | null {
  const startIndex = manifests.findIndex(
    (manifest) => manifest.messageId === appearance.messageId
  )
  const currentPath = join(workspaceRoot, relPath)
  const currentExists = existsSync(currentPath)

  if (appearance.op === 'created') {
    // 先建后删：净变化为零，不产生 diff
    if (!currentExists) return null
    const newContent = readFileSync(currentPath, 'utf-8')
    return {
      entry: computeFileDiff(relPath, '', newContent, 'added'),
      routeMessageId: appearance.messageId
    }
  }

  let routeMessageId = appearance.messageId
  let oldContent: string | null = null
  for (let i = Math.max(0, startIndex); i < manifests.length; i++) {
    const manifest = manifests[i]!
    if (!manifest.modifiedFiles.includes(relPath) && !manifest.deletedFiles.includes(relPath)) {
      continue
    }
    const backupPath = join(getFilesDir(checkpointRoot, sessionId, manifest.messageId), relPath)
    if (!existsSync(backupPath)) continue
    oldContent = readFileSync(backupPath, 'utf-8')
    routeMessageId = manifest.messageId
    break
  }
  // 备份全部缺失（被清理或命中跳过规则）：与消息级口径一致，跳过该文件
  if (oldContent === null) return null

  const newContent = currentExists ? readFileSync(currentPath, 'utf-8') : ''
  const status: DiffEntry['status'] = currentExists ? 'modified' : 'deleted'
  return {
    entry: computeFileDiff(relPath, oldContent, newContent, status),
    routeMessageId
  }
}
