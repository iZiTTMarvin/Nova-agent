/**
 * 回退与拒绝恢复模块
 *
 * 核心职责：
 * 1. 按文件拒绝（reject single file）：从 checkpoint 恢复单个文件的原始内容，并标记 manifest
 * 2. 按消息回退（revert to message）：回退到某条消息之前的完整状态，彻底清理后续所有痕迹
 *
 * 设计约束：
 * - 回退操作不可撤销
 * - 会话是线性的，不存在分支
 * - 清理范围包括：checkpoint 目录、manifest 条目、会话历史记录
 * - 新建文件的拒绝意味着删除该文件
 */
import { existsSync, readFileSync, writeFileSync, unlinkSync, rmSync, readdirSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import type { CheckpointManifest } from './types'
import { readManifest, writeManifest, getCheckpointDir, getFilesDir } from './manifest'

/**
 * 按文件拒绝：恢复单个文件到 checkpoint 中的原始内容
 *
 * 逻辑：
 * - 如果文件在 modifiedFiles 中，从备份恢复原始内容到工作区
 * - 如果文件在 createdFiles 中，从工作区删除该文件
 * - 从 manifest 中移除该文件条目
 * - 如果 manifest 所有文件列表都变空，标记为 rolled-back
 *
 * @param checkpointRoot checkpoint 根目录
 * @param workspaceRoot 工作区根目录
 * @param sessionId 会话 ID
 * @param messageId 消息 ID
 * @param relFilePath 相对路径（相对于工作区根目录）
 * @returns 操作是否成功
 */
export function rejectFile(
  checkpointRoot: string,
  workspaceRoot: string,
  sessionId: string,
  messageId: string,
  relFilePath: string
): boolean {
  const manifest = readManifest(checkpointRoot, sessionId, messageId)
  if (!manifest) return false

  const absFilePath = join(workspaceRoot, relFilePath)
  const filesDir = getFilesDir(checkpointRoot, sessionId, messageId)

  // 修改过的文件：从备份恢复原始内容
  if (manifest.modifiedFiles.includes(relFilePath)) {
    const backupPath = join(filesDir, relFilePath)
    if (existsSync(backupPath)) {
      // 确保目标目录存在
      const targetDir = dirname(absFilePath)
      if (!existsSync(targetDir)) {
        mkdirSync(targetDir, { recursive: true })
      }
      writeFileSync(absFilePath, readFileSync(backupPath), 'utf8')
    }
    manifest.modifiedFiles = manifest.modifiedFiles.filter(f => f !== relFilePath)
  }
  // 新建的文件：从工作区删除
  else if (manifest.createdFiles.includes(relFilePath)) {
    if (existsSync(absFilePath)) {
      unlinkSync(absFilePath)
    }
    manifest.createdFiles = manifest.createdFiles.filter(f => f !== relFilePath)
  }
  // 删除的文件：从备份恢复原始内容到工作区
  else if (manifest.deletedFiles.includes(relFilePath)) {
    const backupPath = join(filesDir, relFilePath)
    if (existsSync(backupPath)) {
      const targetDir = dirname(absFilePath)
      if (!existsSync(targetDir)) {
        mkdirSync(targetDir, { recursive: true })
      }
      writeFileSync(absFilePath, readFileSync(backupPath), 'utf8')
    }
    manifest.deletedFiles = manifest.deletedFiles.filter(f => f !== relFilePath)
  }
  else {
    // 文件不在 manifest 中，无法拒绝
    return false
  }

  // 更新 manifest：如果所有文件列表都为空，标记为 rolled-back
  if (
    manifest.modifiedFiles.length === 0 &&
    manifest.createdFiles.length === 0 &&
    manifest.deletedFiles.length === 0
  ) {
    manifest.status = 'rolled-back'
  }

  writeManifest(checkpointRoot, manifest)
  return true
}

/**
 * 按消息回退：回退到某条消息之前的完整状态
 *
 * 从指定消息开始（包含该消息），按时间正序处理所有后续 checkpoint，
 * 逐步恢复工作区文件，然后彻底删除所有涉及的 checkpoint 目录。
 *
 * @param checkpointRoot checkpoint 根目录
 * @param workspaceRoot 工作区根目录
 * @param sessionId 会话 ID
 * @param targetMessageId 目标消息 ID（回退到该消息之前的状态，该消息及之后的全部删除）
 * @param allManifests 该会话所有的 manifest 列表（按 createdAt 升序）
 * @returns 是否成功执行回退
 */
export function revertToMessage(
  checkpointRoot: string,
  workspaceRoot: string,
  sessionId: string,
  targetMessageId: string,
  allManifests: CheckpointManifest[]
): boolean {
  // 找到目标消息的 manifest 以确定回退起点的时间戳
  const targetManifest = allManifests.find(m => m.messageId === targetMessageId)
  if (!targetManifest) return false

  // 筛选出目标消息及之后的所有 manifest，按时间升序排列
  const manifestsToRevert = allManifests
    .filter(m => m.createdAt >= targetManifest.createdAt && m.status === 'active')
    .sort((a, b) => a.createdAt - b.createdAt)

  // 逐个处理 checkpoint：恢复文件，然后删除目录
  for (const manifest of manifestsToRevert) {
    const checkpointDir = getCheckpointDir(checkpointRoot, sessionId, manifest.messageId)
    const filesDir = getFilesDir(checkpointRoot, sessionId, manifest.messageId)

    // 恢复修改过的文件：从备份还原原始内容
    for (const relPath of manifest.modifiedFiles) {
      const backupPath = join(filesDir, relPath)
      const absPath = join(workspaceRoot, relPath)

      if (existsSync(backupPath)) {
        const targetDir = dirname(absPath)
        if (!existsSync(targetDir)) {
          mkdirSync(targetDir, { recursive: true })
        }
        writeFileSync(absPath, readFileSync(backupPath), 'utf8')
      }
    }

    // 删除新建的文件
    for (const relPath of manifest.createdFiles) {
      const absPath = join(workspaceRoot, relPath)
      if (existsSync(absPath)) {
        unlinkSync(absPath)
      }
    }

    // 恢复被删除的文件：从备份还原原始内容
    for (const relPath of manifest.deletedFiles) {
      const backupPath = join(filesDir, relPath)
      const absPath = join(workspaceRoot, relPath)

      if (existsSync(backupPath)) {
        const targetDir = dirname(absPath)
        if (!existsSync(targetDir)) {
          mkdirSync(targetDir, { recursive: true })
        }
        writeFileSync(absPath, readFileSync(backupPath), 'utf8')
      }
    }

    // 注意：deletedFiles 的文件在更早期的 checkpoint 中可能被修改，
    // 已经被前面恢复的 modifiedFiles 处理了。如果被删除的文件在更早的
    // checkpoint 中不存在原始备份，则无法恢复。

    // 删除整个 checkpoint 目录
    if (existsSync(checkpointDir)) {
      rmSync(checkpointDir, { recursive: true, force: true })
    }
  }

  return true
}

/**
 * 列出指定会话的所有 active 状态的 manifest
 * 从 checkpoint 根目录扫描所有子目录，读取并返回 manifest 列表
 */
export function listManifests(
  checkpointRoot: string,
  sessionId: string
): CheckpointManifest[] {
  const sessionDir = join(checkpointRoot, sessionId)
  if (!existsSync(sessionDir)) return []

  const manifests: CheckpointManifest[] = []

  try {
    const entries = readdirSync(sessionDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const manifest = readManifest(checkpointRoot, sessionId, entry.name)
      if (manifest) {
        manifests.push(manifest)
      }
    }
  } catch {
    // 目录读取失败时静默返回空列表
  }

  return manifests.sort((a, b) => a.createdAt - b.createdAt)
}
