/**
 * 记忆模块 IPC 共享类型（renderer ↔ main）
 */

/** scope 目录下单个 .md 文件元信息（不含正文） */
export interface MemoryScopeFileEntry {
  relPath: string
  size: number
  mtimeMs: number
}

/** scope 记忆统计（磁盘 + 索引） */
export interface MemoryScopeStats {
  scopeId: string
  scopeDir: string
  fileCount: number
  indexCount: number
  diskBytes: number
}

/** reconcile 执行统计 */
export interface ReconcileStats {
  added: number
  updated: number
  removed: number
  skipped: number
}

export interface MemoryReadFileParams {
  relPath: string
}

export interface MemoryWriteFileParams {
  relPath: string
  content: string
}
