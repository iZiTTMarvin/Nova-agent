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
