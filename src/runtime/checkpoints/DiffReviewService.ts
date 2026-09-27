/** Diff 审阅状态归 checkpoint；拒绝恢复统一交由 reviewRestore 执行。 */
import type { SessionStore } from '../sessions/SessionStore'
import { ToolRegistry } from '../tools/ToolRegistry'
import { readManifest, writeManifest } from './manifest'
import {
  createDefaultReviewRestoreIo,
  executeReviewRestore,
  planReviewReject,
  ReviewRestoreError,
  type ReviewRejectTarget,
  type ReviewRestoreIo
} from './reviewRestore'

/** 批量拒绝结果 */
export interface RejectAllResult {
  /** 全部成功时 restored 含所有文件，failed 为空 */
  restored: string[]
  /** 失败的文件；预检失败与已回滚的执行失败都写入这里，且保证零持久副作用 */
  failed: Array<{ filePath: string; error: string }>
}

export class DiffReviewService {
  private readonly pathValidator = new ToolRegistry()

  constructor(
    private readonly sessionStore: SessionStore,
    private readonly io: ReviewRestoreIo | null = null
  ) {}

  private get checkpointRoot(): string {
    return this.sessionStore.getSessionsDir()
  }

  private getRestoreIo(): ReviewRestoreIo {
    return this.io ?? createDefaultReviewRestoreIo(this.checkpointRoot)
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
   * expectedDigest 为调用方审阅时看到的文件版本摘要（null 表示当时不存在），
   * 与当前字节不一致即拒绝覆盖。任何失败都抛错，不产生副作用。
   */
  rejectFile(
    sessionId: string,
    messageId: string,
    filePath: string,
    expectedDigest: string | null
  ): void {
    const session = this.sessionStore.load(sessionId)
    if (!session) {
      throw new Error(`会话 ${sessionId} 不存在`)
    }
    const io = this.getRestoreIo()
    const result = planReviewReject(
      {
        checkpointRoot: this.checkpointRoot,
        workspaceRoot: session.workspaceRoot,
        sessionId,
        messageId,
        targets: [{ filePath, expectedDigest }],
        isWithinWorkspace: rel => this.pathValidator.isWithinWorkspace(session.workspaceRoot, rel)
      },
      io
    )
    if (!result.ok) {
      throw new Error(`文件拒绝失败：${result.failures[0]!.error}`)
    }
    try {
      executeReviewRestore(result.plan, io)
    } catch (err) {
      if (err instanceof ReviewRestoreError) throw new Error(err.message)
      throw err
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

  /** 批量拒绝：预检或可补偿的失败返回 failed；补偿失败则抛出错误。 */
  rejectAllFiles(
    sessionId: string,
    messageId: string,
    targets: ReviewRejectTarget[]
  ): RejectAllResult {
    const session = this.sessionStore.load(sessionId)
    if (!session) {
      throw new Error(`会话 ${sessionId} 不存在`)
    }
    const io = this.getRestoreIo()
    const result = planReviewReject(
      {
        checkpointRoot: this.checkpointRoot,
        workspaceRoot: session.workspaceRoot,
        sessionId,
        messageId,
        targets,
        isWithinWorkspace: rel => this.pathValidator.isWithinWorkspace(session.workspaceRoot, rel)
      },
      io
    )
    if (!result.ok) {
      return { restored: [], failed: result.failures }
    }
    try {
      executeReviewRestore(result.plan, io)
    } catch (err) {
      if (err instanceof ReviewRestoreError) {
        if (!err.compensated) throw err
        return {
          restored: [],
          failed: [{ filePath: err.filePath ?? '', error: err.message }]
        }
      }
      throw err
    }
    return { restored: result.plan.ops.map(op => op.filePath), failed: [] }
  }

  /** 校验文件相对路径均落在工作区内，越界则整批拒绝 */
  private assertPathsWithinWorkspace(workspaceRoot: string, filePaths: string[]): void {
    for (const fp of filePaths) {
      if (!this.pathValidator.isWithinWorkspace(workspaceRoot, fp)) {
        throw new Error(`路径越界: "${fp}" 位于工作区 "${workspaceRoot}" 之外`)
      }
    }
  }
}
