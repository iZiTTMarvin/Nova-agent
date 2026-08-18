/**
 * 跨会话记忆 IPC — scope 文件浏览/编辑、索引维护与结构化记忆管理
 */
import { mkdirSync } from 'fs'
import { shell } from 'electron'
import { handle } from './secureIpc'
import {
  MEMORY_LIST_FILES,
  MEMORY_READ_FILE,
  MEMORY_WRITE_FILE,
  MEMORY_RECONCILE,
  MEMORY_STATS,
  MEMORY_OPEN_DIR,
  MEMORY_LIST_RECORDS,
  MEMORY_RETRACT_RECORD
} from '../../shared/ipc/channels'
import { computeWorkspaceHash, GLOBAL_SCOPE_ID } from '../../runtime/memory/MemoryPaths'
import { getMemoryService, getMemoryRepository } from '../services/MemoryServiceHost'
import { getWorkspaceService } from '../services/WorkspaceService'
import {
  MEMORY_STATUSES,
  SCOPE_KINDS
} from '../../runtime/memory/types'
import type { MemoryRecord, MemoryScope, MemoryStatus, ScopeKind } from '../../runtime/memory/types'
import type {
  MemoryScopeFileEntry,
  MemoryScopeStats,
  MemoryReadFileParams,
  MemoryWriteFileParams,
  MemoryListRecordsParams,
  MemoryRetractRecordParams,
  MemoryRecordDto,
  MemoryRecordStatusCounts,
  MemoryScopeKindDto
} from '../../shared/memory/types'
import type { ReconcileStats } from '../../shared/memory/types'

/** 从当前工作区解析 scopeId；未打开项目时抛错 */
function requireScopeId(): string {
  const projectPath = getWorkspaceService().getState().currentProjectPath
  if (!projectPath?.trim()) {
    throw new Error('请先打开工作区项目')
  }
  return computeWorkspaceHash(projectPath)
}

/**
 * 解析 renderer 请求的 scope 归属。project scope 只允许当前工作区（scopeId 由主进程
 * 解析，renderer 传入值仅作越权校验）；禁止跨项目访问他人记忆。
 */
function resolveRequestedScope(
  scopeKind: MemoryScopeKindDto,
  requestedScopeId: string | undefined
): MemoryScope {
  if (scopeKind === 'global') {
    return { scopeKind: 'global', scopeId: GLOBAL_SCOPE_ID }
  }
  const currentScopeId = requireScopeId()
  if (requestedScopeId !== undefined && requestedScopeId !== currentScopeId) {
    throw new Error('无权访问其他项目的记忆')
  }
  return { scopeKind: 'project', scopeId: currentScopeId }
}

function parseScopeKind(raw: unknown): MemoryScopeKindDto {
  if (typeof raw !== 'string' || !(SCOPE_KINDS as readonly string[]).includes(raw)) {
    throw new Error('scopeKind 必须是 project 或 global')
  }
  return raw as ScopeKind
}

function parseStatus(raw: unknown): MemoryStatus {
  if (raw === undefined) {
    return 'active'
  }
  if (typeof raw !== 'string' || !(MEMORY_STATUSES as readonly string[]).includes(raw)) {
    throw new Error('status 值非法')
  }
  return raw as MemoryStatus
}

/** domain 记录 → IPC DTO（唯一权威转换；不携带 evidence 全文与内部指纹） */
function toMemoryRecordDto(record: MemoryRecord): MemoryRecordDto {
  return {
    id: record.id,
    scopeKind: record.scopeKind,
    kind: record.kind,
    memoryKey: record.memoryKey,
    content: record.content,
    status: record.status,
    explicitness: record.explicitness,
    evidenceCount: record.evidenceCount,
    sourceSummary: record.sourcePath ?? record.sourceType,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  }
}

function countRecordsByStatus(rows: ReadonlyArray<{ status: MemoryStatus; count: number }>): MemoryRecordStatusCounts {
  const counts: MemoryRecordStatusCounts = {
    active: 0,
    pending: 0,
    superseded: 0,
    retracted: 0,
    needsVerification: 0
  }
  for (const row of rows) {
    switch (row.status) {
      case 'active':
        counts.active += row.count
        break
      case 'pending':
        counts.pending += row.count
        break
      case 'superseded':
        counts.superseded += row.count
        break
      case 'retracted':
        counts.retracted += row.count
        break
      case 'needs_verification':
        counts.needsVerification += row.count
        break
    }
  }
  return counts
}

export function registerMemoryHandler(): void {
  handle(MEMORY_LIST_FILES, async (): Promise<MemoryScopeFileEntry[]> => {
    const scopeId = requireScopeId()
    return getMemoryService().listScopeFiles(scopeId)
  })

  handle(MEMORY_READ_FILE, async (_event, params: MemoryReadFileParams): Promise<string> => {
    const scopeId = requireScopeId()
    return getMemoryService().readScopeFile(scopeId, params.relPath)
  })

  handle(MEMORY_WRITE_FILE, async (_event, params: MemoryWriteFileParams): Promise<void> => {
    const scopeId = requireScopeId()
    getMemoryService().upsertMarkdown(scopeId, params.relPath, params.content)
  })

  handle(MEMORY_RECONCILE, async (): Promise<ReconcileStats> => {
    const scopeId = requireScopeId()
    return getMemoryService().reconcile(scopeId)
  })

  handle(MEMORY_STATS, async (): Promise<MemoryScopeStats> => {
    const scopeId = requireScopeId()
    const stats = getMemoryService().stats(scopeId)
    const recordRows = getMemoryRepository().stats({ scopeKind: 'project', scopeId })
    return { ...stats, records: countRecordsByStatus(recordRows) }
  })

  handle(MEMORY_OPEN_DIR, async (): Promise<void> => {
    const scopeId = requireScopeId()
    const memoryService = getMemoryService()
    const stats = memoryService.stats(scopeId)
    mkdirSync(stats.scopeDir, { recursive: true })
    const err = await shell.openPath(stats.scopeDir)
    if (err) {
      throw new Error(`无法打开记忆目录：${err}`)
    }
  })

  handle(MEMORY_LIST_RECORDS, async (_event, params: MemoryListRecordsParams): Promise<MemoryRecordDto[]> => {
    const scopeKind = parseScopeKind(params?.scopeKind)
    const status = parseStatus(params?.status)
    const scope = resolveRequestedScope(scopeKind, params?.scopeId)
    const records = getMemoryRepository().listByScope(scope, { status })
    return records.map(toMemoryRecordDto)
  })

  handle(MEMORY_RETRACT_RECORD, async (_event, params: MemoryRetractRecordParams): Promise<void> => {
    const scopeKind = parseScopeKind(params?.scopeKind)
    const id = typeof params?.id === 'string' ? params.id.trim() : ''
    if (!id) {
      throw new Error('缺少记忆记录 id')
    }
    const scope = resolveRequestedScope(scopeKind, undefined)
    const repository = getMemoryRepository()
    const record = repository.findById(id)
    if (!record) {
      throw new Error('记忆记录不存在或已被清除')
    }
    if (record.scopeKind !== scope.scopeKind || record.scopeId !== scope.scopeId) {
      throw new Error('无权操作其他范围的记忆')
    }
    if (!repository.retract(id)) {
      throw new Error('忘记失败，请稍后重试')
    }
  })
}
