/**
 * Checkpoint 层类型定义
 * 每条用户消息是一个事务边界，第一次修改文件前备份原始内容
 */
import type { DiffReviewStatus, SkippedFileInfo } from '../../shared/diff/types'

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
  /** 本轮因过大或命中排除规则而跳过备份的文件 */
  skippedFiles?: SkippedFileInfo[]
  /** 是否已被滚动清理：true 表示 files/ 目录已被删除，只剩 manifest 记录 */
  backupPruned?: boolean
  /** 是否已被滚动清理：true 表示 forward/ 目录已被删除 */
  forwardPruned?: boolean
  /** 滚动清理发生的时间戳（毫秒） */
  prunedAt?: number
  /** Tier 2：消息结束时是否已捕获改动后快照（forward/） */
  forwardCaptured?: boolean
}

/** CheckpointManager 的初始化配置 */
export interface CheckpointConfig {
  /** checkpoint 根目录（通常为 app_data/checkpoints） */
  checkpointDir: string
  /** 当前会话 ID */
  sessionId: string
  /** 工作区根目录 */
  workspaceRoot: string
  /**
   * 单个文件备份大小上限（字节）。
   * 默认 5MB；超过此阈值的文件不会被物理备份，仅记录到 manifest.skippedFiles。
   */
  maxBackupFileBytes?: number
  /**
   * 每个会话保留的最近 checkpoint 消息数。
   * 默认 30；更早消息的 files/ 目录会被物理删除，manifest 保留并标记 backupPruned。
   */
  keepRecentCheckpointMessages?: number
  /** 返回当前激活路径消息 id 集合，供滚动清理时只计 active path */
  getActivePathMessageIds?: () => Set<string> | undefined
}
