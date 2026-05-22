/**
 * Checkpoint 层类型定义
 * 每条用户消息是一个事务边界，第一次修改文件前备份原始内容
 */
import type { DiffReviewStatus } from '../../shared/diff/types'

/** Checkpoint manifest 记录一次消息级别的文件变更快照 */
export interface CheckpointManifest {
  sessionId: string
  messageId: string
  workspaceRoot: string
  /** 本轮新创建的文件（相对路径） */
  createdFiles: string[]
  /** 本轮修改过的已有文件（相对路径） */
  modifiedFiles: string[]
  /** 本轮删除的文件（相对路径） */
  deletedFiles: string[]
  status: 'active' | 'rolled-back'
  createdAt: number
  /** 文件级审查状态，key 为相对路径 */
  fileReviews?: Record<string, DiffReviewStatus>
}

/** CheckpointManager 的初始化配置 */
export interface CheckpointConfig {
  /** checkpoint 根目录（通常为 app_data/checkpoints） */
  checkpointDir: string
  /** 当前会话 ID */
  sessionId: string
  /** 工作区根目录 */
  workspaceRoot: string
}
