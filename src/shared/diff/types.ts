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
