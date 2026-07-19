/** 大输出截断元数据（工具 / 事件 / 持久化共用） */
export interface ToolTruncationMeta {
  totalBytes: number
  totalLines: number
  shownLines?: number
  truncated: boolean
}
