/**
 * MemoryService — 跨会话记忆业务入口
 * 文档检索：指纹变化时同步 FTS 索引；手写 .md 与 episodic 落盘走本服务。
 */
import {
  existsSync,
  readFileSync,
  statSync,
} from 'fs'
import type { MemoryDb } from './MemoryDb'
import {
  MemoryScopeDirectoryResolver,
  resolveSafeScopeRelPath
} from './MemoryPaths'
import { episodicSummaryRelPath } from './MemoryConsolidator'
import type { MemoryEntryStore } from './markdown/MemoryEntryStore'
import { assertMemoryFilePath, memoryFileFingerprint, writeFileAtomic } from './markdown/atomicFile'
import { buildQueryTerms } from './index/indexTerms'
import {
  applyScoreFloor,
  computeFingerprint,
  computeOverFetchLimit,
  DEFAULT_SCORE_FLOOR,
  DEFAULT_SEARCH_LIMIT
} from './FtsQueryBuilder'
import {
  isSearchableMemoryFile,
  isStructuralIndexError,
  listIndexedFingerprints,
  searchIndexedDocuments,
  upsertIndexedFile,
  countIndexedFiles
} from './MemoryIndexer'
import { reconcileScope, scanScopeMarkdownFiles, listScopeMarkdownFileMeta } from './MemoryReconciler'
import type {
  MemorySearchHit,
  MemorySearchOptions,
  MemoryScopeFileEntry,
  MemoryDocumentStats,
  ReconcileStats
} from './types'

export interface MemoryServiceOptions {
  /** 每次检索全量同步；默认仅在文件指纹变化时同步 */
  reconcileOnSearch?: boolean
  searchLimit?: number
  scoreFloor?: number
  entryStore?: MemoryEntryStore
}

export class MemoryService {
  private readonly reconcileOnSearch: boolean
  private readonly searchLimit: number
  private readonly scoreFloor: number
  private closed = false
  private indexUnavailable = false
  private readonly entryStore?: MemoryEntryStore
  private readonly scopeDirectories: MemoryScopeDirectoryResolver

  constructor(
    private readonly memoryRoot: string,
    private readonly db: MemoryDb | null = null,
    options: MemoryServiceOptions = {}
  ) {
    this.scopeDirectories = new MemoryScopeDirectoryResolver(memoryRoot)
    this.entryStore = options.entryStore
    this.reconcileOnSearch = options.reconcileOnSearch ?? false
    this.searchLimit = options.searchLimit ?? DEFAULT_SEARCH_LIMIT
    this.scoreFloor = options.scoreFloor ?? DEFAULT_SCORE_FLOOR
  }

  registerWorkspace(workspaceRoot: string): string {
    this.entryStore?.registerWorkspace(workspaceRoot)
    return this.scopeDirectories.registerWorkspace(workspaceRoot)
  }

  /** 检索前同步外部编辑；索引故障时从同一范围的文件检索。 */
  search(scopeId: string, query: string, options?: MemorySearchOptions): MemorySearchHit[] {
    if (this.closed || !query.trim()) {
      return []
    }

    const limit = options?.limit ?? this.searchLimit
    const floor = options?.scoreFloor ?? this.scoreFloor
    const fetchLimit = computeOverFetchLimit(limit)
    let raw: MemorySearchHit[]
    try {
      if (this.reconcileOnSearch) this.reconcile(scopeId)
      else this.syncExternalEdits(scopeId)
      raw = !this.db || this.indexUnavailable
        ? this.scanDocuments(scopeId, query, fetchLimit)
        : searchIndexedDocuments(this.db, scopeId, query, fetchLimit)
    } catch (error) {
      if (isStructuralIndexError(error)) this.indexUnavailable = true
      raw = this.scanDocuments(scopeId, query, fetchLimit)
    }
    return applyScoreFloor(raw, limit, floor)
  }

  /**
   * 检索前用 stat 比对指纹，发现外部改动才增量重建。
   *
   * 用户在应用运行期间用编辑器改了手写记忆文档时，索引不会自动知道——以前要等到
   * 重启或手动重建，检索一直返回旧内容。这里只读元信息（size + mtime），不读正文，
   * 只有指纹真的对不上才走一次 reconcile。
   */
  private syncExternalEdits(scopeId: string): void {
    if (!this.db || this.closed || this.indexUnavailable) return
    const scopeKind = scopeId === 'user' ? 'global' : 'project'
    const scopeDir = this.scopeDirectories.resolve(scopeId)
    const onDisk = new Map(
      listScopeMarkdownFileMeta(scopeDir)
        .filter(file => isSearchableMemoryFile(file.relPath, scopeKind))
        .map(file => [file.relPath, computeFingerprint(file.size, file.mtimeMs)])
    )
    const indexed = listIndexedFingerprints(this.db, scopeId)
    if (onDisk.size === indexed.size && [...onDisk].every(([relPath, fp]) => indexed.get(relPath) === fp)) {
      return
    }
    this.reconcile(scopeId)
  }

  private scanDocuments(scopeId: string, query: string, limit: number): MemorySearchHit[] {
    const terms = buildQueryTerms(query)
    // 降级路径与索引路径共用同一个范围判定：不能因为走了扫描就丢掉操作摘要
    const scopeKind = scopeId === 'user' ? 'global' : 'project'
    const hits = scanScopeMarkdownFiles(this.scopeDirectories.resolve(scopeId), scopeKind)
      .filter(file => isSearchableMemoryFile(file.relPath, scopeKind)).map(file => {
        const text = file.body.normalize('NFKC').toLowerCase()
        return { scopeId, relPath: file.relPath, body: file.body, score: terms.filter(term => text.includes(term)).length }
      }).filter(hit => hit.score > 0).sort((a, b) => b.score - a.score || a.relPath.localeCompare(b.relPath)).slice(0, limit)
    const top = hits[0]?.score ?? 1
    return hits.map(hit => ({ ...hit, score: hit.score / top }))
  }

  /**
   * 写入 Markdown 并同步增量索引（自写自更，无需 reconcile）
   * relPath 必须在 scope 目录内，禁止路径穿越。
   */
  upsertMarkdown(scopeId: string, relPath: string, content: string): void {
    if (this.entryStore?.isReadOnly()) throw new Error('Memory files are read-only')
    const scopeDir = this.scopeDirectories.resolve(scopeId)
    const absPath = resolveSafeScopeRelPath(scopeDir, relPath)
    writeFileAtomic(absPath, content, { memoryRoot: this.memoryRoot, expectedFingerprint: memoryFileFingerprint(absPath) })

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
   * 追加摘要块到当前月份的 episodic 文件。
   */
  appendEpisodicSummary(scopeId: string, markdownBlock: string): void {
    if (this.entryStore?.isReadOnly()) throw new Error('Memory files are read-only')
    if (!markdownBlock.trim()) {
      return
    }

    const relPath = episodicSummaryRelPath()
    const scopeDir = this.scopeDirectories.resolve(scopeId)
    const absPath = resolveSafeScopeRelPath(scopeDir, relPath)
    assertMemoryFilePath(absPath, this.memoryRoot)
    const fingerprint = memoryFileFingerprint(absPath)

    let existing = ''
    if (existsSync(absPath)) {
      existing = readFileSync(absPath, 'utf8')
    }

    const needsSep = existing.length > 0 && !existing.endsWith('\n')
    const content = needsSep ? `${existing}\n${markdownBlock}` : `${existing}${markdownBlock}`

    writeFileAtomic(absPath, content, { memoryRoot: this.memoryRoot, expectedFingerprint: fingerprint })

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
    const scopeDir = this.scopeDirectories.resolve(scopeId)
    return listScopeMarkdownFileMeta(scopeDir)
  }

  /** 读取 scope 内单个 .md 文件；relPath 越界则拒绝 */
  readScopeFile(scopeId: string, relPath: string): string {
    const scopeDir = this.scopeDirectories.resolve(scopeId)
    const absPath = resolveSafeScopeRelPath(scopeDir, relPath)
    assertMemoryFilePath(absPath, this.memoryRoot)
    if (!existsSync(absPath)) {
      throw new Error('记忆文件不存在')
    }
    return readFileSync(absPath, 'utf8')
  }

  /** scope 统计：磁盘文件数、索引条数、占用字节 */
  stats(scopeId: string): MemoryDocumentStats {
    const scopeDir = this.scopeDirectories.resolve(scopeId)
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
    this.entryStore?.reconcile({ scopeKind: scopeId === 'user' ? 'global' : 'project', scopeId })
    if (!this.db || this.closed) {
      return { added: 0, updated: 0, removed: 0, skipped: 0 }
    }
    const scopeDir = this.scopeDirectories.resolve(scopeId)
    return reconcileScope(this.db, scopeId, scopeDir)
  }

  /** 关闭底层 DB 连接 */
  close(): void {
    if (this.closed) {
      return
    }
    this.closed = true
    this.scopeDirectories.clear()
    this.db?.close()
  }

  /** 供单测断言：是否持有可写索引 */
  hasIndex(): boolean {
    return this.db != null && !this.closed && !this.indexUnavailable
  }

  /** 供单测：扫描 scope 目录（暴露 reconciler 能力） */
  scanScopeFiles(scopeId: string) {
    return scanScopeMarkdownFiles(this.scopeDirectories.resolve(scopeId))
  }
}
