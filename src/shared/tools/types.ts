/** 命令退出事实独立于工具调用是否成功；后台启动不代表命令退出。 */
export type ToolProcessOutcome =
  | { state: 'running' | 'unconfirmed' }
  | { state: 'exited'; exitCode: number | null }

/** 大输出截断元数据（工具 / 事件 / 持久化共用） */
export interface ToolTruncationMeta {
  totalBytes: number
  totalLines: number
  shownLines?: number
  truncated: boolean
}
/** 工具返回的图片正文；持久化保留当时的字节，不重新读取可变工作区文件。 */
export interface ImageContent {
  data: string
  mimeType: string
}
