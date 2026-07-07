/**
 * DiffReviewService — diff 审阅操作服务（PRD §5.3）
 *
 * 从 WorkspaceService 拆出，负责文件级与批量级 accept/reject 操作。
 * WorkspaceService 只负责工作区状态（currentSession/project/mode）的单一事实源，
 * diff 审阅属于 checkpoint 领域，归属本服务。
 *
 * 事务性约定（PRD §5.3.3）：
 * - 批量拒绝逐个恢复，任一失败则中断并回滚已恢复文件（保持原子性）。
 * - 回滚机制：恢复前快照每个目标文件的当前（改后）内容到内存，
 *   失败时把已恢复的文件重新写回快照内容。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'fs'
import { join, dirname } from 'path'
import type { SessionStore } from '../sessions/SessionStore'
import { ToolRegistry } from '../tools/ToolRegistry'
import { rejectFile } from './restore'
import { readManifest, writeManifest } from './manifest'

/** 批量拒绝结果 */
export interface RejectAllResult {
  /** 全部成功时 restored 含所有文件，failed 为空 */
  restored: string[]
  /** 失败的文件（事务性回滚后，这里只含首个失败的文件） */
  failed: Array<{ filePath: string; error: string }>
}

export class DiffReviewService {
  private readonly pathValidator = new ToolRegistry()

  constructor(private readonly sessionStore: SessionStore) {}

  private get checkpointRoot(): string {
    return this.sessionStore.getSessionsDir()
  }

  /** 接受单个文件改动：标记 manifest 为 accepted */
  acceptFile(sessionId: string, messageId: string, filePath: string): void {
    const manifest = readManifest(this.checkpointRoot, sessionId, messageId)
    if (!manifest) {
      throw new Error('接受文件失败：找不到对应的 checkpoint')
    }
    if (!manifest.fileReviews) manifest.fileReviews = {}
    manifest.fileReviews[filePath] = 'accepted'
    writeManifest(this.checkpointRoot, manifest)
  }

  /**
   * 拒绝单个文件改动：从 checkpoint 恢复原始内容。
   * 拒绝失败（文件不在 manifest）抛错。
   */
  rejectFile(sessionId: string, messageId: string, filePath: string): void {
    const session = this.sessionStore.load(sessionId)
    if (!session) {
      throw new Error(`会话 ${sessionId} 不存在`)
    }
    this.assertPathsWithinWorkspace(session.workspaceRoot, [filePath])
    const success = rejectFile(
      this.checkpointRoot,
      session.workspaceRoot,
      sessionId,
      messageId,
      filePath
    )
    if (!success) {
      throw new Error('文件拒绝失败：该文件不在当前消息的 checkpoint 中')
    }
    // 标记审查状态为 rejected
    const manifest = readManifest(this.checkpointRoot, sessionId, messageId)
    if (manifest) {
      if (!manifest.fileReviews) manifest.fileReviews = {}
      manifest.fileReviews[filePath] = 'rejected'
      writeManifest(this.checkpointRoot, manifest)
    }
  }

  /** 批量接受：更新 manifest，所有目标标记为 accepted */
  acceptAllFiles(sessionId: string, messageId: string, filePaths: string[]): void {
    const session = this.sessionStore.load(sessionId)
    if (!session) {
      throw new Error(`会话 ${sessionId} 不存在`)
    }
    this.assertPathsWithinWorkspace(session.workspaceRoot, filePaths)

    const manifest = readManifest(this.checkpointRoot, sessionId, messageId)
    if (!manifest) {
      throw new Error('批量接受失败：找不到对应的 checkpoint')
    }
    if (!manifest.fileReviews) manifest.fileReviews = {}
    for (const fp of filePaths) {
      manifest.fileReviews[fp] = 'accepted'
    }
    writeManifest(this.checkpointRoot, manifest)
  }

  /**
   * 批量拒绝（PRD §5.3.3 事务性）：
   * 1. 恢复前快照所有目标文件的当前（改后）内容到内存。
   * 2. 逐个从 checkpoint 恢复。
   * 3. 任一失败：立即中断，把已恢复的文件用快照回滚（重新写成改后内容）。
   * 4. 全部成功：更新 manifest 审查状态。
   *
   * 返回 restored（全部成功时含所有文件）与 failed（含首个失败文件）。
   */
  rejectAllFiles(sessionId: string, messageId: string, filePaths: string[]): RejectAllResult {
    const session = this.sessionStore.load(sessionId)
    if (!session) {
      throw new Error(`会话 ${sessionId} 不存在`)
    }
    const workspaceRoot = session.workspaceRoot
    this.assertPathsWithinWorkspace(workspaceRoot, filePaths)

    // 1. 快照所有目标文件的当前内容（改后状态），供失败回滚使用
    //    只快照存在的文件；不存在的（如 created 文件待删除）记录为 null
    const snapshots = new Map<string, Buffer | null>()
    for (const fp of filePaths) {
      const absPath = join(workspaceRoot, fp)
      if (existsSync(absPath)) {
        snapshots.set(fp, readFileSync(absPath))
      } else {
        snapshots.set(fp, null)
      }
    }

    // 2. 逐个恢复
    const restored: string[] = []
    for (const fp of filePaths) {
      const ok = rejectFile(
        this.checkpointRoot,
        workspaceRoot,
        sessionId,
        messageId,
        fp
      )
      if (!ok) {
        // 3. 失败：回滚所有已恢复的文件到快照内容（事务性）
        this.rollbackRestored(restored, snapshots, workspaceRoot)
        return {
          restored: [],
          failed: [{ filePath: fp, error: '该文件不在当前消息的 checkpoint 中（已回滚此前恢复的文件）' }]
        }
      }
      restored.push(fp)
    }

    // 4. 全部成功：更新 manifest
    const manifest = readManifest(this.checkpointRoot, sessionId, messageId)
    if (manifest) {
      if (!manifest.fileReviews) manifest.fileReviews = {}
      for (const fp of restored) {
        manifest.fileReviews[fp] = 'rejected'
      }
      writeManifest(this.checkpointRoot, manifest)
    }

    return { restored, failed: [] }
  }

  /** 校验文件相对路径均落在工作区内，越界则整批拒绝 */
  private assertPathsWithinWorkspace(workspaceRoot: string, filePaths: string[]): void {
    for (const fp of filePaths) {
      if (!this.pathValidator.isWithinWorkspace(workspaceRoot, fp)) {
        throw new Error(`路径越界: "${fp}" 位于工作区 "${workspaceRoot}" 之外`)
      }
    }
  }

  /**
   * 事务性回滚：把已恢复的文件重新写成快照内容（改后状态）。
   * - 快照为 Buffer：写回文件内容。
   * - 快照为 null（原文件不存在，是 created 类型被删除）：删除当前文件。
   */
  private rollbackRestored(
    restoredFiles: string[],
    snapshots: Map<string, Buffer | null>,
    workspaceRoot: string
  ): void {
    for (const fp of restoredFiles) {
      const snapshot = snapshots.get(fp)
      const absPath = join(workspaceRoot, fp)
      try {
        if (snapshot === null) {
          // 原本不存在（created 文件），恢复时被删了；回滚 = 删除当前文件
          if (existsSync(absPath)) {
            unlinkSync(absPath)
          }
        } else if (Buffer.isBuffer(snapshot)) {
          // 写回快照内容
          const targetDir = dirname(absPath)
          if (!existsSync(targetDir)) {
            mkdirSync(targetDir, { recursive: true })
          }
          writeFileSync(absPath, snapshot)
        }
        // snapshot === undefined：理论上不会发生（快照阶段已写入），跳过
      } catch (err) {
        // 回滚失败是极端情况（磁盘满/权限），只能记录，无法进一步恢复
        console.error(`[DiffReviewService] 事务性回滚文件 ${fp} 失败:`, err)
      }
    }
  }
}
