/**
 * 回退与分支重放模块
 *
 * 核心职责：
 * 1. 按消息回退（revert to message）：回退到某条消息之前的完整状态，彻底清理后续所有痕迹
 * 2. 工作区级撤销 / forward 重放（分支切换用，不删 checkpoint）
 *
 * 设计约束：
 * - 回退操作不可撤销
 * - 清理范围包括：checkpoint 目录、manifest 条目、会话历史记录
 * - 审阅场景的按文件拒绝由 reviewRestore 的 plan/execute 承担，不在本模块
 */
import { existsSync, readFileSync, writeFileSync, unlinkSync, rmSync, readdirSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import type { CheckpointManifest } from './types'
import { readManifest, getCheckpointDir, getFilesDir, getForwardDir } from './manifest'

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
  // 只重放完整可验证的前缀：一旦出现缺口，其后所有有改动的消息都不再应用，
  // 否则后续消息的快照会跨过缺口写到错误基线上
  let gapSeen = false

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

    if (gapSeen || !manifest.forwardCaptured || manifest.forwardPruned) {
      gapSeen = true
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
      gapSeen = true
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

/** 将单条 manifest 的 forward 快照应用到工作区；先整体校验再写，保证不半写 */
function applySingleManifestForward(
  checkpointRoot: string,
  workspaceRoot: string,
  sessionId: string,
  manifest: CheckpointManifest
): boolean {
  const forwardDir = getForwardDir(checkpointRoot, sessionId, manifest.messageId)
  const skippedPaths = new Set((manifest.skippedFiles ?? []).map(s => s.path))
  const toWrite = [...manifest.modifiedFiles, ...manifest.createdFiles]

  // 全部 modified/created 路径必须未被 skipped 且 forward 文件存在，否则整条不应用
  for (const relPath of toWrite) {
    if (skippedPaths.has(relPath)) return false
    if (!existsSync(join(forwardDir, relPath))) return false
  }

  for (const relPath of toWrite) {
    writeForwardFileToWorkspace(forwardDir, workspaceRoot, relPath)
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
): void {
  const forwardPath = join(forwardDir, relPath)
  const absPath = join(workspaceRoot, relPath)
  const targetDir = dirname(absPath)
  if (!existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true })
  }
  writeFileSync(absPath, readFileSync(forwardPath))
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
