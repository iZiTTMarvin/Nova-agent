/**
 * 记忆模块 IPC 共享类型（renderer ↔ main）
 */
export type { MemoryScopeFileEntry, MemoryScopeStats, ReconcileStats } from '../../runtime/memory/types'

export interface MemoryReadFileParams {
  relPath: string
}

export interface MemoryWriteFileParams {
  relPath: string
  content: string
}
