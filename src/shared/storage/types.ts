/**
 * 存储治理相关共享类型
 *
 * 用于 IPC 命令参数 / 返回值以及 renderer 端设置面板数据展示。
 */

/** 单条会话的磁盘占用明细 */
export interface SessionStorageBreakdown {
  /** 会话 ID */
  sessionId: string
  /** 会话历史（session.json + messages.jsonl，当前阶段只有 session.json） */
  historyBytes: number
  /** 文件备份（checkpoint files/ 目录） */
  checkpointsBytes: number
  /** 命令产物（artifacts/ 目录） */
  artifactsBytes: number
  /** 该会话总占用（字节） */
  totalBytes: number
}

/** 全应用存储占用统计 */
export interface StorageUsageReport {
  /** 应用数据总根目录 */
  appDataPath: string
  /** 所有会话合计（字节） */
  totalBytes: number
  /** 按会话明细 */
  sessions: SessionStorageBreakdown[]
  /** 无法归入会话的零散数据（字节） */
  orphanBytes: number
}

/** 清理操作结果 */
export interface StorageCleanupResult {
  /** 清理了多少字节 */
  freedBytes: number
  /** 清理涉及多少会话 */
  affectedSessions: number
  /** 操作详情 */
  details: string[]
}

/** 启动时 GC 配置 */
export interface StorageGcConfig {
  /** 陈旧快照保留天数，超过此天数的 files/ 目录会被删除 */
  snapshotRetentionDays: number
}
