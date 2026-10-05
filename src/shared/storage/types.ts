/**
 * 存储治理相关共享类型
 *
 * 用于 IPC 命令参数 / 返回值以及 renderer 端设置面板数据展示。
 */

/** 单条会话的磁盘占用明细 */
export interface SessionStorageBreakdown {
  /** 已通过 session.json 身份校验的会话 ID */
  sessionId: string
  /** 会话标题；旧数据缺失时为空 */
  title: string | null
  /** 会话所属工作区；旧数据缺失时为空 */
  workspaceRoot: string | null
  /** 会话最后更新时间；旧数据缺失时为空 */
  updatedAt: number | null
  /** 会话历史（session.json、messages.jsonl 与上下文快照） */
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
  /** 无法关联到会话的目录或文件，展示层不得提供会话清理操作 */
  orphanEntries: StorageOrphanEntry[]
}

export type StorageOrphanKind = 'system' | 'orphan'

/** 无法关联到会话的系统或孤立数据 */
export interface StorageOrphanEntry {
  /** 相对于应用数据根目录的展示路径 */
  relativePath: string
  /** 目录或文件占用（字节） */
  bytes: number
  /** 已知内部数据或未知孤立数据 */
  kind: StorageOrphanKind
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
