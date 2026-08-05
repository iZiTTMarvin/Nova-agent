/**
 * 项目文件只读浏览 IPC 契约（renderer ↔ main）
 */

export interface FsEntry {
  name: string
  /** 相对项目根的 POSIX 路径 */
  relativePath: string
  type: 'file' | 'directory'
}

export interface FsListDirectoryParams {
  /** 相对项目根；空字符串表示项目根 */
  relativeDir: string
}

export interface FsListDirectoryResult {
  entries: FsEntry[]
}

export interface FsReadFilePreviewParams {
  relativePath: string
}

export interface FsReadFilePreviewResult {
  content: string
  truncated: boolean
  binary: boolean
}
