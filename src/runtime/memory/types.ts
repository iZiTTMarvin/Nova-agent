/** 磁盘扫描到的单条 Markdown 记忆文件 */
export interface ScannedMemoryFile {
  relPath: string
  body: string
  size: number
  mtimeMs: number
  fingerprint: string
}

/** reconcile 计划：对比磁盘与索引后的增删改 */
export interface ReconcilePlan {
  added: ScannedMemoryFile[]
  updated: ScannedMemoryFile[]
  removed: string[]
}

export type {
  MemoryScopeFileEntry,
  MemoryScopeStats,
  ReconcileStats
} from '../../shared/memory/types'

/** FTS 检索命中（score 为 -bm25，越大越相关） */
export interface MemorySearchHit {
  scopeId: string
  relPath: string
  body: string
  score: number
}

/** search 可选参数 */
export interface MemorySearchOptions {
  limit?: number
  scoreFloor?: number
}

/** FtsQueryBuilder 分派路径 */
export type FtsQueryPath = 'trigram' | 'unicode61' | 'none'

export interface BuiltMatchQuery {
  query: string | null
  path: FtsQueryPath
}
