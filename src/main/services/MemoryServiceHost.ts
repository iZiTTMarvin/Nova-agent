/**
 * MemoryServiceHost — scope reconcile 调度与单例生命周期
 * reconcile 在工作区打开时后台触发，不在 SEND_MESSAGE 同步路径阻塞。
 */
import { app } from 'electron'
import { mkdirSync } from 'fs'
import { join } from 'path'
import { getMemoryRoot, computeWorkspaceHash } from '../../runtime/memory/MemoryPaths'
import { MemoryService } from '../../runtime/memory/MemoryService'
import { openBetterSqliteMemoryDb } from '../../runtime/memory/BetterSqliteMemoryDb'
import type { BetterSqliteMemoryDb } from '../../runtime/memory/BetterSqliteMemoryDb'
import { SqliteMemoryRepository } from '../../runtime/memory/repository/SqliteMemoryRepository'
import type { MemoryRepository } from '../../runtime/memory/repository/MemoryRepository'
import { MemoryCandidateProcessor } from '../../runtime/memory/policy/MemoryCandidateProcessor'
import { StructuredMemoryRetriever } from '../../runtime/memory/retrieval/StructuredMemoryRetriever'
import { DocumentMemoryRetriever } from '../../runtime/memory/retrieval/DocumentMemoryRetriever'
import { MemoryRetrievalService } from '../../runtime/memory/retrieval/MemoryRetrievalService'
import { MemoryVerifier } from '../../runtime/memory/lifecycle/MemoryVerifier'
import { loadNovaSettings } from '../../runtime/settings/novaSettings'

let memoryService: MemoryService | null = null
let memoryRepository: MemoryRepository | null = null
let memoryCandidateProcessor: MemoryCandidateProcessor | null = null
let memoryRetrievalService: MemoryRetrievalService | null = null
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
    let db: BetterSqliteMemoryDb
    try {
      db = openBetterSqliteMemoryDb(dbPath)
    } catch (err) {
      // 原生绑定缺失（node_modules 重建跳过 lifecycle scripts 的典型后果）
      // 在 owner 处转成可行动报错，禁止把 bindings 原始堆栈抛给渲染层。
      throw new Error(
        '记忆存储不可用：better-sqlite3 原生模块未对当前 Electron ABI 构建。'
        + '请在仓库根目录运行 `npm run rebuild:native:electron` 后重启应用。'
        + `原始错误：${err instanceof Error ? err.message : String(err)}`
      )
    }
    memoryService = new MemoryService(memoryRoot, db, {
      reconcileOnSearch: settings.memoryReconcileOnSearch,
      searchLimit: settings.memorySearchLimit,
      scoreFloor: settings.memoryScoreFloor
    })
    memoryRepository = new SqliteMemoryRepository(db)
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
export function scheduleMemoryScopeReconcile(scopeId: string): void {
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
  scheduleMemoryScopeReconcile(scopeId)
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
  memoryCandidateProcessor = null
  memoryRetrievalService = null
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
