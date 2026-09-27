/** 单个 diff 块 */
export interface DiffHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  content: string
}

/** 单文件 diff 条目 */
export interface DiffEntry {
  filePath: string
  hunks: DiffHunk[]
  status: 'added' | 'modified' | 'deleted'
  /**
   * 生成该 diff 时工作区文件原始字节的 sha256 hex；null 表示文件不存在，
   * undefined 表示该条目尚未从工作区读取，不能据此拒绝改动。
   * 用于拒绝恢复前的并发校验（用户看完 diff 后又改了文件则不覆盖），不是安全令牌。
   */
  currentDigest: string | null | undefined
}

/** 文件级审查状态 */
export type DiffReviewStatus = 'accepted' | 'rejected'

/** 因过大或命中排除规则而被跳过备份的文件记录 */
export interface SkippedFileInfo {
  /** 相对路径（相对于工作区根目录） */
  path: string
  /** 跳过原因：过大或命中排除规则 */
  reason: 'oversized' | 'excluded'
  /** 文件大小（字节），排除规则下可为 0 */
  bytes: number
}

/** 单条消息级 diff 状态（供 renderer 展示） */
export interface MessageDiffsState {
  diffs: DiffEntry[]
  reviews: Record<string, DiffReviewStatus>
  /** 因过大等原因未生成 snapshot 的文件 */
  skippedFiles: SkippedFileInfo[]
}

/**
 * 会话级 diff 状态：跨消息合并后的净变化。
 * messageIdByFile 记录每个文件最早出现（或备份实际可用）的 messageId，
 * 供 accept/reject 路由到正确的消息级 checkpoint。
 */
export interface SessionMessageDiffsState extends MessageDiffsState {
  messageIdByFile: Record<string, string>
}
