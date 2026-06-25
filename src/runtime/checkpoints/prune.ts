/**
 * Checkpoint 滚动清理模块
 *
 * 核心职责：
 * 1. 按保留策略只保留最近 N 条消息的物理备份
 * 2. 清理时只删除 files/ 目录，保留 manifest.json 作为历史记录
 * 3. 被清理的 manifest 标记 backupPruned，供 restore 阶段识别并抛错
 *
 * 设计约束：
 * - 不删除对话历史，只删除可恢复的原始文件备份
 * - 保留 manifest 以便 UI 知道某消息曾修改过哪些文件（但已无法回退）
 * - 清理失败时记录错误但不阻塞当前消息流程
 */
import { existsSync, rmSync, readdirSync } from 'fs'
import type { CheckpointManifest } from './types'
import { getCheckpointDir, getFilesDir, writeManifest, readManifest } from './manifest'

/**
 * 滚动清理指定会话的过期 checkpoint 备份。
 *
 * 逻辑：
 * 1. 读取该会话所有 manifest，按 createdAt 降序排列
 * 2. 保留前 keepRecent 条完整备份
 * 3. 对更旧的 manifest，删除其 files/ 目录并在 manifest 中标记 backupPruned
 *
 * @param checkpointRoot checkpoint 根目录
 * @param sessionId 会话 ID
 * @param keepRecent 保留最近 N 条消息
 */
export function pruneOldCheckpoints(
  checkpointRoot: string,
  sessionId: string,
  keepRecent: number
): void {
  if (keepRecent <= 0) return

  const sessionDir = getCheckpointDir(checkpointRoot, sessionId, '')
  if (!existsSync(sessionDir)) return

  const manifests = listSessionManifests(checkpointRoot, sessionId)
  if (manifests.length <= keepRecent) return

  // 按时间从新到旧排序，后面的都是要清理的
  const sorted = manifests.sort((a, b) => b.createdAt - a.createdAt)
  const toPrune = sorted.slice(keepRecent)

  for (const manifest of toPrune) {
    pruneSingleManifest(checkpointRoot, manifest)
  }
}

/**
 * 清理单个 manifest 的物理备份并打标记。
 */
function pruneSingleManifest(
  checkpointRoot: string,
  manifest: CheckpointManifest
): void {
  const filesDir = getFilesDir(checkpointRoot, manifest.sessionId, manifest.messageId)

  try {
    if (existsSync(filesDir)) {
      rmSync(filesDir, { recursive: true, force: true })
    }

    // 重新读取，避免覆盖并发改动；读取失败则跳过
    const fresh = readManifest(checkpointRoot, manifest.sessionId, manifest.messageId)
    if (!fresh) return

    fresh.backupPruned = true
    fresh.prunedAt = Date.now()
    writeManifest(checkpointRoot, fresh)
  } catch (err) {
    // 清理失败不应阻塞当前消息，仅记录日志
    console.error(
      `[CheckpointPrune] 清理 ${manifest.sessionId}/${manifest.messageId} 失败:`,
      err
    )
  }
}

/**
 * 列出指定会话的所有 manifest（按 createdAt 升序）。
 */
function listSessionManifests(
  checkpointRoot: string,
  sessionId: string
): CheckpointManifest[] {
  const sessionDir = getCheckpointDir(checkpointRoot, sessionId, '')
  if (!existsSync(sessionDir)) return []

  const result: CheckpointManifest[] = []

  try {
    const entries = readdirSync(sessionDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const manifest = readManifest(checkpointRoot, sessionId, entry.name)
      if (manifest) {
        result.push(manifest)
      }
    }
  } catch (err) {
    console.error(`[CheckpointPrune] 读取会话目录失败: ${sessionDir}`, err)
  }

  return result.sort((a, b) => a.createdAt - b.createdAt)
}
