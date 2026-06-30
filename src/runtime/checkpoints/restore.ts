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
import { readManifest, writeManifest, getCheckpointDir, getFilesDir, getForwardDir } from './manifest'

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

  // 修改过的文件：从备份恢复原始内容，备份缺失时严禁静默跳过
  if (manifest.modifiedFiles.includes(relFilePath)) {
    const backupPath = join(filesDir, relFilePath)
    if (!existsSync(backupPath)) {
      const reason = manifest.backupPruned
        ? '该消息备份已被滚动清理（仅保留最近 checkpoint），无法恢复'
        : '备份文件不存在'
      throw new Error(
        `[rejectFile] ${reason}: session=${sessionId}, message=${messageId}, file=${relFilePath}`
      )
    }

    // 确保目标目录存在
    const targetDir = dirname(absFilePath)
    if (!existsSync(targetDir)) {
      mkdirSync(targetDir, { recursive: true })
    }
    // 不带 encoding：readFileSync 返回 Buffer，writeFileSync 字节级写入，二进制安全
    writeFileSync(absFilePath, readFileSync(backupPath))
    manifest.modifiedFiles = manifest.modifiedFiles.filter(f => f !== relFilePath)
  }
  // 新建的文件：从工作区删除
  else if (manifest.createdFiles.includes(relFilePath)) {
    if (existsSync(absFilePath)) {
      unlinkSync(absFilePath)
    }
    manifest.createdFiles = manifest.createdFiles.filter(f => f !== relFilePath)
  }
  // 删除的文件：从备份恢复原始内容到工作区，备份缺失时严禁静默跳过
  else if (manifest.deletedFiles.includes(relFilePath)) {
    const backupPath = join(filesDir, relFilePath)
    if (!existsSync(backupPath)) {
      const reason = manifest.backupPruned
        ? '该消息备份已被滚动清理（仅保留最近 checkpoint），无法恢复'
        : '备份文件不存在'
      throw new Error(
        `[rejectFile] ${reason}: session=${sessionId}, message=${messageId}, file=${relFilePath}`
      )
    }

    const targetDir = dirname(absFilePath)
    if (!existsSync(targetDir)) {
      mkdirSync(targetDir, { recursive: true })
    }
    // 不带 encoding：readFileSync 返回 Buffer，writeFileSync 字节级写入，二进制安全
    writeFileSync(absFilePath, readFileSync(backupPath))
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

  // 先预检：确认所有需要恢复的备份文件都存在，避免半回退。
  // 任何备份缺失都抛 Error，不修改任何工作区文件或 checkpoint 目录。
  verifyRevertPossible(checkpointRoot, sessionId, manifestsToRevert)

  // 逐个处理 checkpoint：恢复文件，然后删除目录
  for (const manifest of manifestsToRevert) {
    const checkpointDir = getCheckpointDir(checkpointRoot, sessionId, manifest.messageId)
    const filesDir = getFilesDir(checkpointRoot, sessionId, manifest.messageId)

    // 恢复修改过的文件：从备份还原原始内容，备份缺失时严禁静默跳过
    for (const relPath of manifest.modifiedFiles) {
      const backupPath = join(filesDir, relPath)
      const absPath = join(workspaceRoot, relPath)

      if (!existsSync(backupPath)) {
        const reason = manifest.backupPruned
          ? '该消息备份已被滚动清理（仅保留最近 checkpoint），无法回退'
          : '备份文件不存在'
        throw new Error(
          `[revertToMessage] ${reason}: session=${sessionId}, message=${manifest.messageId}, file=${relPath}`
        )
      }

      const targetDir = dirname(absPath)
      if (!existsSync(targetDir)) {
        mkdirSync(targetDir, { recursive: true })
      }
      // 不带 encoding：readFileSync 返回 Buffer，writeFileSync 字节级写入，二进制安全
      writeFileSync(absPath, readFileSync(backupPath))
    }

    // 删除新建的文件
    for (const relPath of manifest.createdFiles) {
      const absPath = join(workspaceRoot, relPath)
      if (existsSync(absPath)) {
        unlinkSync(absPath)
      }
    }

    // 恢复被删除的文件：从备份还原原始内容，备份缺失时严禁静默跳过
    for (const relPath of manifest.deletedFiles) {
      const backupPath = join(filesDir, relPath)
      const absPath = join(workspaceRoot, relPath)

      if (!existsSync(backupPath)) {
        const reason = manifest.backupPruned
          ? '该消息备份已被滚动清理（仅保留最近 checkpoint），无法回退'
          : '备份文件不存在'
        throw new Error(
          `[revertToMessage] ${reason}: session=${sessionId}, message=${manifest.messageId}, file=${relPath}`
        )
      }

      const targetDir = dirname(absPath)
      if (!existsSync(targetDir)) {
        mkdirSync(targetDir, { recursive: true })
      }
      // 不带 encoding：readFileSync 返回 Buffer，writeFileSync 字节级写入，二进制安全
      writeFileSync(absPath, readFileSync(backupPath))
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
 * 预检回退是否可行：扫描所有待回退 manifest，确认需要恢复原始内容的备份都存在。
 *
 * 任何备份缺失都抛 Error，调用方应据此阻止回退并提示用户。
 */
function verifyRevertPossible(
  checkpointRoot: string,
  sessionId: string,
  manifestsToRevert: CheckpointManifest[]
): void {
  for (const manifest of manifestsToRevert) {
    const filesDir = getFilesDir(checkpointRoot, sessionId, manifest.messageId)

    for (const relPath of manifest.modifiedFiles) {
      const backupPath = join(filesDir, relPath)
      if (!existsSync(backupPath)) {
        const reason = manifest.backupPruned
          ? '该消息备份已被滚动清理（仅保留最近 checkpoint），无法回退'
          : '备份文件不存在'
        throw new Error(
          `[revertToMessage] 预检失败，${reason}: session=${sessionId}, message=${manifest.messageId}, file=${relPath}`
        )
      }
    }

    for (const relPath of manifest.deletedFiles) {
      const backupPath = join(filesDir, relPath)
      if (!existsSync(backupPath)) {
        const reason = manifest.backupPruned
          ? '该消息备份已被滚动清理（仅保留最近 checkpoint），无法回退'
          : '备份文件不存在'
        throw new Error(
          `[revertToMessage] 预检失败，${reason}: session=${sessionId}, message=${manifest.messageId}, file=${relPath}`
        )
      }
    }
  }
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

/** applyForward 结果：完整重放与因缺少 forward 快照而跳过的消息 */
export interface ApplyForwardResult {
  appliedMessageIds: string[]
  incompleteMessageIds: string[]
}

/**
 * 非破坏性工作区回退：仅还原磁盘文件，保留 checkpoint 目录与 manifest（树模型分叉必备）。
 * 按 createdAt 从新到旧依次撤销指定消息 id 集合内的 active checkpoint。
 */
export function revertWorkspaceForMessageIds(
  checkpointRoot: string,
  workspaceRoot: string,
  sessionId: string,
  messageIds: Set<string>,
  allManifests: CheckpointManifest[]
): void {
  if (messageIds.size === 0) return

  const toRevert = allManifests
    .filter(m => messageIds.has(m.messageId) && m.status === 'active')
    .sort((a, b) => b.createdAt - a.createdAt)

  verifyWorkspaceRevertPossible(checkpointRoot, sessionId, toRevert)

  for (const manifest of toRevert) {
    undoSingleManifestWorkspace(checkpointRoot, workspaceRoot, sessionId, manifest)
  }
}

/**
 * Tier 2：沿目标路径正向重放 forward 快照（LCA → target 区间内的 assistant checkpoint）。
 * messageIds 须按时间升序传入。
 */
export function applyForwardForMessageIds(
  checkpointRoot: string,
  workspaceRoot: string,
  sessionId: string,
  messageIds: string[],
  allManifests: CheckpointManifest[]
): ApplyForwardResult {
  const manifestById = new Map(allManifests.map(m => [m.messageId, m]))
  const appliedMessageIds: string[] = []
  const incompleteMessageIds: string[] = []

  for (const messageId of messageIds) {
    const manifest = manifestById.get(messageId)
    if (!manifest || manifest.status !== 'active') continue

    const hasChanges =
      manifest.createdFiles.length > 0
      || manifest.modifiedFiles.length > 0
      || manifest.deletedFiles.length > 0
    if (!hasChanges) {
      appliedMessageIds.push(messageId)
      continue
    }

    if (!manifest.forwardCaptured || manifest.forwardPruned) {
      incompleteMessageIds.push(messageId)
      continue
    }

    const ok = applySingleManifestForward(
      checkpointRoot,
      workspaceRoot,
      sessionId,
      manifest
    )
    if (ok) {
      appliedMessageIds.push(messageId)
    } else {
      incompleteMessageIds.push(messageId)
    }
  }

  return { appliedMessageIds, incompleteMessageIds }
}

/** 撤销单条 manifest 对工作区的改动（不删 checkpoint 目录） */
function undoSingleManifestWorkspace(
  checkpointRoot: string,
  workspaceRoot: string,
  sessionId: string,
  manifest: CheckpointManifest
): void {
  const filesDir = getFilesDir(checkpointRoot, sessionId, manifest.messageId)

  for (const relPath of manifest.modifiedFiles) {
    restoreFileFromBackup(filesDir, workspaceRoot, relPath, manifest)
  }
  for (const relPath of manifest.createdFiles) {
    const absPath = join(workspaceRoot, relPath)
    if (existsSync(absPath)) {
      unlinkSync(absPath)
    }
  }
  for (const relPath of manifest.deletedFiles) {
    restoreFileFromBackup(filesDir, workspaceRoot, relPath, manifest)
  }
}

/** 将单条 manifest 的 forward 快照应用到工作区 */
function applySingleManifestForward(
  checkpointRoot: string,
  workspaceRoot: string,
  sessionId: string,
  manifest: CheckpointManifest
): boolean {
  const forwardDir = getForwardDir(checkpointRoot, sessionId, manifest.messageId)
  const skippedPaths = new Set((manifest.skippedFiles ?? []).map(s => s.path))

  for (const relPath of manifest.modifiedFiles) {
    if (skippedPaths.has(relPath)) return false
    if (!writeForwardFileToWorkspace(forwardDir, workspaceRoot, relPath)) return false
  }
  for (const relPath of manifest.createdFiles) {
    if (skippedPaths.has(relPath)) return false
    if (!writeForwardFileToWorkspace(forwardDir, workspaceRoot, relPath)) return false
  }
  for (const relPath of manifest.deletedFiles) {
    const absPath = join(workspaceRoot, relPath)
    if (existsSync(absPath)) {
      unlinkSync(absPath)
    }
  }
  return true
}

function restoreFileFromBackup(
  filesDir: string,
  workspaceRoot: string,
  relPath: string,
  manifest: CheckpointManifest
): void {
  const backupPath = join(filesDir, relPath)
  if (!existsSync(backupPath)) {
    const reason = manifest.backupPruned
      ? '该消息备份已被滚动清理，无法回退'
      : '备份文件不存在'
    throw new Error(
      `[revertWorkspace] ${reason}: message=${manifest.messageId}, file=${relPath}`
    )
  }
  const absPath = join(workspaceRoot, relPath)
  const targetDir = dirname(absPath)
  if (!existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true })
  }
  writeFileSync(absPath, readFileSync(backupPath))
}

function writeForwardFileToWorkspace(
  forwardDir: string,
  workspaceRoot: string,
  relPath: string
): boolean {
  const forwardPath = join(forwardDir, relPath)
  if (!existsSync(forwardPath)) return false
  const absPath = join(workspaceRoot, relPath)
  const targetDir = dirname(absPath)
  if (!existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true })
  }
  writeFileSync(absPath, readFileSync(forwardPath))
  return true
}

function verifyWorkspaceRevertPossible(
  checkpointRoot: string,
  sessionId: string,
  manifestsToRevert: CheckpointManifest[]
): void {
  for (const manifest of manifestsToRevert) {
    const filesDir = getFilesDir(checkpointRoot, sessionId, manifest.messageId)
    for (const relPath of [...manifest.modifiedFiles, ...manifest.deletedFiles]) {
      const backupPath = join(filesDir, relPath)
      if (!existsSync(backupPath)) {
        const reason = manifest.backupPruned
          ? '该消息备份已被滚动清理，无法回退'
          : '备份文件不存在'
        throw new Error(
          `[revertWorkspace] 预检失败，${reason}: message=${manifest.messageId}, file=${relPath}`
        )
      }
    }
  }
}
