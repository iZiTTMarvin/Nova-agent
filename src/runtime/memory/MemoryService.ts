/**
 * MemoryService — 跨会话记忆业务入口
 * L1：getProjectEssence 直读 MEMORY.md；L2 检索：search 只查 FTS 索引（热路径默认不 reconcile）
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync
} from 'fs'
import { dirname } from 'path'
import type { MemoryDb } from './MemoryDb'
import {
  getMemoryMdPath,
  getProjectMemoryDir,
  resolveSafeScopeRelPath
} from './MemoryPaths'
import { EPISODIC_SUMMARY_REL_PATH } from './MemoryConsolidator'
import { truncateAtLineOrHeaderBoundary } from './truncateEssence'
import {
  applyScoreFloor,
  buildMatchQuery,
  computeFingerprint,
  computeOverFetchLimit,
  DEFAULT_SCORE_FLOOR,
  DEFAULT_SEARCH_LIMIT
} from './FtsQueryBuilder'
import { searchIndexed, upsertIndexedFile, countIndexedFiles } from './MemoryIndexer'
import { reconcileScope, scanScopeMarkdownFiles, listScopeMarkdownFileMeta } from './MemoryReconciler'
import type {
  MemorySearchHit,
  MemorySearchOptions,
  MemoryScopeFileEntry,
  MemoryScopeStats,
  ReconcileStats
} from './types'
import { DEFAULT_L1_MAX_CHARS } from './MemoryBudget'

export { DEFAULT_L1_MAX_CHARS } from './MemoryBudget'

export interface MemoryServiceOptions {
  /** 热路径默认 false：search 不触发 reconcile */
  reconcileOnSearch?: boolean
  searchLimit?: number
  scoreFloor?: number
}

export class MemoryService {
  private readonly reconcileOnSearch: boolean
  private readonly searchLimit: number
  private readonly scoreFloor: number
  private closed = false

  constructor(
    private readonly memoryRoot: string,
    private readonly db: MemoryDb | null = null,
    options: MemoryServiceOptions = {}
  ) {
    this.reconcileOnSearch = options.reconcileOnSearch ?? false
    this.searchLimit = options.searchLimit ?? DEFAULT_SEARCH_LIMIT
    this.scoreFloor = options.scoreFloor ?? DEFAULT_SCORE_FLOOR
  }

  /**
   * 直读项目 MEMORY.md 作为 L1 精华；不调 LLM、不做 importance 排序。
   */
  getProjectEssence(scopeId: string, maxChars?: number): string {
    const mdPath = getMemoryMdPath(this.memoryRoot, scopeId)
    if (!existsSync(mdPath)) {
      return ''
    }

    const raw = readFileSync(mdPath, 'utf8').trim()
    if (!raw) {
      return ''
    }

    if (maxChars === undefined || raw.length <= maxChars) {
      return raw
    }

    return truncateAtLineOrHeaderBoundary(raw, maxChars)
  }

  /**
   * FTS 检索（热路径只查索引；默认不 reconcile）
   */
  search(scopeId: string, query: string, options?: MemorySearchOptions): MemorySearchHit[] {
    if (!this.db || this.closed || !query.trim()) {
      return []
    }

    if (this.reconcileOnSearch) {
      this.reconcile(scopeId)
    }

    const { query: matchQuery } = buildMatchQuery(query)
    if (!matchQuery) {
      return []
    }

    const limit = options?.limit ?? this.searchLimit
    const floor = options?.scoreFloor ?? this.scoreFloor
    const fetchLimit = computeOverFetchLimit(limit)
    const raw = searchIndexed(this.db, scopeId, matchQuery, fetchLimit)
    return applyScoreFloor(raw, limit, floor)
  }

  /**
   * 写入 Markdown 并同步增量索引（自写自更，无需 reconcile）
   * relPath 必须在 scope 目录内，禁止路径穿越。
   */
  upsertMarkdown(scopeId: string, relPath: string, content: string): void {
    const scopeDir = getProjectMemoryDir(this.memoryRoot, scopeId)
    const absPath = resolveSafeScopeRelPath(scopeDir, relPath)
    mkdirSync(dirname(absPath), { recursive: true })
    writeFileSync(absPath, content, 'utf8')

    if (!this.db || this.closed) {
      return
    }

    const stat = statSync(absPath)
    const mtimeMs = Math.floor(stat.mtimeMs)
    const size = stat.size
    const safeRelPath = relPath.replace(/\\/g, '/')
    upsertIndexedFile(this.db, scopeId, {
      relPath: safeRelPath,
      body: content,
      fingerprint: computeFingerprint(size, mtimeMs),
      mtimeMs,
      size
    })
  }

  /**
   * 追加内容到 MEMORY.md（只追加，不覆盖既有正文）
   */
  appendMemoryMd(scopeId: string, markdownBlock: string): void {
    if (!markdownBlock.trim()) {
      return
    }

    const relPath = 'MEMORY.md'
    const scopeDir = getProjectMemoryDir(this.memoryRoot, scopeId)
    const absPath = resolveSafeScopeRelPath(scopeDir, relPath)

    let existing = ''
    if (existsSync(absPath)) {
      existing = readFileSync(absPath, 'utf8')
    }

    const needsSep = existing.length > 0 && !existing.endsWith('\n')
    const content = needsSep ? `${existing}\n${markdownBlock}` : `${existing}${markdownBlock}`

    mkdirSync(dirname(absPath), { recursive: true })
    writeFileSync(absPath, content, 'utf8')

    if (!this.db || this.closed) {
      return
    }

    const stat = statSync(absPath)
    const mtimeMs = Math.floor(stat.mtimeMs)
    const size = stat.size
    upsertIndexedFile(this.db, scopeId, {
      relPath,
      body: content,
      fingerprint: computeFingerprint(size, mtimeMs),
      mtimeMs,
      size
    })
  }

  /**
   * 追加 episodic 摘要块到 episodic/summary.md（只追加，绝不覆盖 MEMORY.md）
   */
  appendEpisodicSummary(scopeId: string, markdownBlock: string): void {
    if (!markdownBlock.trim()) {
      return
    }

    const relPath = EPISODIC_SUMMARY_REL_PATH
    const scopeDir = getProjectMemoryDir(this.memoryRoot, scopeId)
    const absPath = resolveSafeScopeRelPath(scopeDir, relPath)

    let existing = ''
    if (existsSync(absPath)) {
      existing = readFileSync(absPath, 'utf8')
    }

    const needsSep = existing.length > 0 && !existing.endsWith('\n')
    const content = needsSep ? `${existing}\n${markdownBlock}` : `${existing}${markdownBlock}`

    mkdirSync(dirname(absPath), { recursive: true })
    writeFileSync(absPath, content, 'utf8')

    if (!this.db || this.closed) {
      return
    }

    const stat = statSync(absPath)
    const mtimeMs = Math.floor(stat.mtimeMs)
    const size = stat.size
    upsertIndexedFile(this.db, scopeId, {
      relPath,
      body: content,
      fingerprint: computeFingerprint(size, mtimeMs),
      mtimeMs,
      size
    })
  }

  /** 列出 scope 下全部 .md 文件元信息（相对路径 + size + mtime） */
  listScopeFiles(scopeId: string): MemoryScopeFileEntry[] {
    const scopeDir = getProjectMemoryDir(this.memoryRoot, scopeId)
    return listScopeMarkdownFileMeta(scopeDir)
  }

  /** 读取 scope 内单个 .md 文件；relPath 越界则拒绝 */
  readScopeFile(scopeId: string, relPath: string): string {
    const scopeDir = getProjectMemoryDir(this.memoryRoot, scopeId)
    const absPath = resolveSafeScopeRelPath(scopeDir, relPath)
    if (!existsSync(absPath)) {
      throw new Error('记忆文件不存在')
    }
    return readFileSync(absPath, 'utf8')
  }

  /** scope 统计：磁盘文件数、索引条数、占用字节 */
  stats(scopeId: string): MemoryScopeStats {
    const scopeDir = getProjectMemoryDir(this.memoryRoot, scopeId)
    const files = listScopeMarkdownFileMeta(scopeDir)
    const diskBytes = files.reduce((sum, f) => sum + f.size, 0)
    const indexCount =
      this.db && !this.closed ? countIndexedFiles(this.db, scopeId) : 0

    return {
      scopeId,
      scopeDir,
      fileCount: files.length,
      indexCount,
      diskBytes
    }
  }

  /**
   * 全量 reconcile 单个 scope（初始化 / 手动重建 / 指纹变更时调用，不在 search 热路径）
   */
  reconcile(scopeId: string): ReconcileStats {
    if (!this.db || this.closed) {
      return { added: 0, updated: 0, removed: 0, skipped: 0 }
    }
    const scopeDir = getProjectMemoryDir(this.memoryRoot, scopeId)
    return reconcileScope(this.db, scopeId, scopeDir)
  }

  /** 关闭底层 DB 连接 */
  close(): void {
    if (this.closed) {
      return
    }
    this.closed = true
    this.db?.close()
  }

  /** 供单测断言：是否持有可写索引 */
  hasIndex(): boolean {
    return this.db != null && !this.closed
  }

  /** 供单测：扫描 scope 目录（暴露 reconciler 能力） */
  scanScopeFiles(scopeId: string) {
    return scanScopeMarkdownFiles(getProjectMemoryDir(this.memoryRoot, scopeId))
  }
}
