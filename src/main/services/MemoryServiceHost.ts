/**
 * MemoryServiceHost — 记忆服务生命周期、索引降级与 scope 同步。
 */
import { app } from 'electron'
import { existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { getMemoryRoot, computeWorkspaceHash, GLOBAL_SCOPE_ID } from '../../runtime/memory/MemoryPaths'
import { MemoryService } from '../../runtime/memory/MemoryService'
import { openBetterSqliteMemoryDb, BetterSqliteMemoryDb } from '../../runtime/memory/BetterSqliteMemoryDb'
import { MarkdownMemoryRepository } from '../../runtime/memory/repository/MarkdownMemoryRepository'
import { MemoryEntryStore } from '../../runtime/memory/markdown/MemoryEntryStore'
import { MemoryIndex } from '../../runtime/memory/index/MemoryIndex'
import { LegacyMemoryMigrator } from '../../runtime/memory/migration/LegacyMemoryMigrator'
import type { MemoryRepository } from '../../runtime/memory/repository/MemoryRepository'
import { MemoryCandidateProcessor } from '../../runtime/memory/policy/MemoryCandidateProcessor'
import { StructuredMemoryRetriever } from '../../runtime/memory/retrieval/StructuredMemoryRetriever'
import { DocumentMemoryRetriever } from '../../runtime/memory/retrieval/DocumentMemoryRetriever'
import { MemoryRetrievalService } from '../../runtime/memory/retrieval/MemoryRetrievalService'
import { MemoryVerifier } from '../../runtime/memory/lifecycle/MemoryVerifier'
import { renderMemorySnapshot, type RenderedMemorySnapshot } from '../../runtime/memory/snapshot/renderMemorySnapshot'
import { MemoryForgetter } from '../../runtime/memory/forget/MemoryForgetter'
import { createSessionSnapshotForgetCopy } from './SessionMemorySnapshot'
import { getSessionStore } from './SessionStoreHost'
import { loadNovaSettings } from '../../runtime/settings/novaSettings'

let memoryService: MemoryService | null = null
let memoryRepository: MemoryRepository | null = null
let memoryEntryStore: MemoryEntryStore | null = null
let memoryIndex: MemoryIndex | null = null
let memoryIndexDiagnostic: string | null = null
let memoryCandidateProcessor: MemoryCandidateProcessor | null = null
let memoryRetrievalService: MemoryRetrievalService | null = null
let memoryMigrator: LegacyMemoryMigrator | null = null
let memoryForgetter: MemoryForgetter | null = null
let workspaceRootsProvider: () => readonly string[] = () => []

export function setMemoryWorkspaceRootsProvider(provider: () => readonly string[]): void {
  workspaceRootsProvider = provider
}
/** 已完成初始化 reconcile 的 scope（每个 scope 仅 reconcile 一次） */
const initializedScopes = new Set<string>()
/** 正在 reconcile 的 scope（防止同一 scope 并发重复） */
const reconcilingScopes = new Set<string>()

/** 获取或创建记忆服务单例（含 FTS 索引库；同库一并装配结构化记忆仓储、候选处理器与检索层） */
export function getMemoryService(): MemoryService {
  if (!memoryService) {
    const settings = loadNovaSettings()
    const userData = app.getPath('userData')
    const memoryRoot = getMemoryRoot(userData)
    mkdirSync(memoryRoot, { recursive: true })
    const dbPath = join(memoryRoot, 'memory.db')
    let db: BetterSqliteMemoryDb | null = null
    let index: MemoryIndex | null = null
    let migrationFailed = false
    let migrationComplete = false
    memoryMigrator = new LegacyMemoryMigrator(memoryRoot)
    try {
      migrationComplete = memoryMigrator.isMigrationComplete()
      memoryMigrator.backup()
      db = openBetterSqliteMemoryDb(dbPath)
      memoryMigrator.migrate(db)
      migrationComplete = true
      index = new MemoryIndex(db)
      memoryIndex = index
    } catch (err) {
      db?.close()
      db = null
      memoryIndexDiagnostic = '索引不可用；记忆文件仍可读写。请在仓库根目录运行 npm run rebuild:native:electron 后重启应用。'
      migrationFailed = !migrationComplete && (existsSync(dbPath) || existsSync(join(memoryRoot, '.migration.json')))
      if (migrationFailed) memoryIndexDiagnostic = '旧记忆迁移失败；当前记忆仅可读取，请修复迁移后重启。原库及备份均保留。'
      console.error('[MemoryServiceHost] memory index unavailable:', err instanceof Error ? err.name : 'unknown')
    }
    // 遗忘留下的索引残留尽量在每次启动时回收；失败不阻断记忆服务
    if (index) {
      try { index.purgeResidue() } catch { console.warn('[MemoryServiceHost] 索引残留清理失败') }
    }
    memoryEntryStore = new MemoryEntryStore(memoryRoot, {
      onIndexChanged: (scope, entries) => index?.rebuild(scope, entries),
      readPreviousEntries: scope => index?.readPreviousEntries(scope) ?? [],
      onError: stage => {
        if (stage === 'index') memoryIndexDiagnostic = '索引不可用；当前使用文件降级检索。'
        console.error(`[MemoryServiceHost] memory ${stage} update failed`)
      }
    })
    memoryEntryStore.setReadOnly(migrationFailed)
    if (!migrationFailed) {
      for (const root of new Set(workspaceRootsProvider().filter(Boolean))) {
        try { memoryMigrator.claim(root, memoryEntryStore) }
        catch { memoryIndexDiagnostic = '部分旧记忆认领失败；暂存区仍保留，请检查记忆设置。' }
      }
    }
    memoryService = new MemoryService(memoryRoot, db, {
      reconcileOnSearch: settings.memoryReconcileOnSearch,
      searchLimit: settings.memorySearchLimit,
      scoreFloor: settings.memoryScoreFloor,
      entryStore: memoryEntryStore
    })
    memoryForgetter = new MemoryForgetter({
      store: memoryEntryStore,
      copies: [
        createSessionSnapshotForgetCopy(getSessionStore),
        { label: '迁移备份', redact: forgotten => memoryMigrator!.redactBackups(forgotten, path => new BetterSqliteMemoryDb(path)) }
      ],
      index
    })
    memoryRepository = new MarkdownMemoryRepository(memoryEntryStore, index, () => {
      memoryIndexDiagnostic = '索引重建失败；当前使用文件降级检索。'
    }, (scope, id) => memoryForgetter!.forget(scope, id))
    memoryCandidateProcessor = new MemoryCandidateProcessor({ repository: memoryRepository })
    const verifier = new MemoryVerifier({ repository: memoryRepository })
    memoryRetrievalService = new MemoryRetrievalService({
      structuredRetriever: new StructuredMemoryRetriever(memoryRepository),
      documentRetriever: new DocumentMemoryRetriever(memoryService),
      verifier
    })
  }
  return memoryService
}

/** 结构化记忆仓储单例（与 MemoryService 共用同一 DB 连接） */
export function getMemoryRepository(): MemoryRepository {
  getMemoryService()
  return memoryRepository!
}

export function getMemoryEntryStore(): MemoryEntryStore {
  getMemoryService()
  return memoryEntryStore!
}

/** 彻底遗忘单例：设置页 IPC 与 memory_manage 撤回共用此入口 */
export function getMemoryForgetter(): MemoryForgetter {
  getMemoryService()
  return memoryForgetter!
}

export function upgradeMemoryLearnedEpoch(epoch: number): number {
  getMemoryService()
  return memoryMigrator!.upgradeLearnedEpoch(memoryEntryStore!, epoch)
}

export function listUnclaimedMemory() { getMemoryService(); return memoryMigrator!.listUnclaimed() }
export function deleteUnclaimedMemory(oldHash: string): void {
  getMemoryService()
  if (memoryEntryStore!.isReadOnly()) throw new Error('Memory files are read-only')
  memoryMigrator!.deleteUnclaimed(oldHash)
}

export function captureMemorySnapshot(workspaceRoot: string, capturedAt = Date.now()): RenderedMemorySnapshot {
  const service = getMemoryService()
  const scopeId = service.registerWorkspace(workspaceRoot)
  const store = getMemoryEntryStore()
  if (!store.isReadOnly()) memoryMigrator?.claim(workspaceRoot, store)
  const rendered = renderMemorySnapshot({ capturedAt,
    global: store.snapshotScope({ scopeKind: 'global', scopeId: GLOBAL_SCOPE_ID }),
    project: store.snapshotScope({ scopeKind: 'project', scopeId }) })
  if (rendered.budgetOverflow) console.warn('[MemoryServiceHost] snapshot exceeded its character budget')
  return rendered
}

export function getMemoryIndexDiagnostic(): string | null {
  getMemoryService()
  return memoryIndexDiagnostic
}

export function getMemoryIndexStatus(scope: import('../../runtime/memory/types').MemoryScope): 'ok' | 'dirty' | 'unavailable' {
  getMemoryService()
  if (!memoryIndex) return 'unavailable'
  try { return memoryIndex.isDirty(scope) ? 'dirty' : 'ok' }
  catch { return 'unavailable' }
}

/** 候选落库处理器单例（端口注入，主进程实例化） */
export function getMemoryCandidateProcessor(): MemoryCandidateProcessor {
  getMemoryService()
  return memoryCandidateProcessor!
}

/** 组合检索单例（memory_search 工具使用） */
export function getMemoryRetrievalService(): MemoryRetrievalService {
  getMemoryService()
  return memoryRetrievalService!
}

/**
 * 后台调度 scope 全量 reconcile（fire-and-forget，不阻塞发送路径）。
 * 每个 scope 至多执行一次；memoryEnabled 为 false 时跳过。
 */
export function scheduleMemoryScopeReconcile(scopeId: string, workspaceRoot?: string): void {
  const settings = loadNovaSettings()
  if (!settings.memoryEnabled) {
    return
  }
  if (initializedScopes.has(scopeId) || reconcilingScopes.has(scopeId)) {
    return
  }
  reconcilingScopes.add(scopeId)
  setImmediate(() => {
    try {
      if (workspaceRoot) {
        getMemoryService().registerWorkspace(workspaceRoot)
        memoryMigrator?.claim(workspaceRoot, getMemoryEntryStore())
      }
      getMemoryService().reconcile(scopeId)
      initializedScopes.add(scopeId)
    } catch (err) {
      console.error(`[MemoryServiceHost] scope ${scopeId} reconcile 失败:`, err)
    } finally {
      reconcilingScopes.delete(scopeId)
    }
  })
}

/** 工作区路径变更时触发对应 scope 的后台 reconcile */
export function scheduleMemoryReconcileForWorkspace(workspaceRoot: string | null | undefined): void {
  if (!workspaceRoot?.trim()) {
    return
  }
  const scopeId = computeWorkspaceHash(workspaceRoot)
  scheduleMemoryScopeReconcile(scopeId, workspaceRoot)
}

/** @deprecated 使用 scheduleMemoryScopeReconcile；保留供迁移期引用 */
export function ensureMemoryScopeInitialized(scopeId: string): void {
  scheduleMemoryScopeReconcile(scopeId)
}

/** 应用退出时关闭 DB 连接 */
export function closeMemoryService(): void {
  memoryService?.close()
  memoryService = null
  memoryRepository = null
  memoryEntryStore = null
  memoryIndex = null
  memoryMigrator = null
  memoryIndexDiagnostic = null
  memoryCandidateProcessor = null
  memoryRetrievalService = null
  memoryForgetter = null
  initializedScopes.clear()
  reconcilingScopes.clear()
}

/** 单测或特殊场景重置单例 */
export function resetMemoryServiceForTests(): void {
  closeMemoryService()
}

/** 测试辅助：查询 scope 是否已完成 reconcile */
export function isMemoryScopeInitializedForTests(scopeId: string): boolean {
  return initializedScopes.has(scopeId)
}

/** 测试辅助：查询 scope 是否正在 reconcile */
export function isMemoryScopeReconcilingForTests(scopeId: string): boolean {
  return reconcilingScopes.has(scopeId)
}
