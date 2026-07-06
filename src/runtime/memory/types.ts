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

/** reconcile 执行统计 */
export interface ReconcileStats {
  added: number
  updated: number
  removed: number
  skipped: number
}

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

/** FtsQueryBuilder 分派路径 */
export type FtsQueryPath = 'trigram' | 'unicode61' | 'none'

export interface BuiltMatchQuery {
  query: string | null
  path: FtsQueryPath
}
