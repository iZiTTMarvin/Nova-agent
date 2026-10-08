import { mkdirSync, existsSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { shell } from 'electron'
import { handle } from './secureIpc'
import { MEMORY_LIST_FILES, MEMORY_READ_FILE, MEMORY_WRITE_FILE, MEMORY_RECONCILE, MEMORY_STATS, MEMORY_OPEN_DIR,
  MEMORY_LIST_ENTRIES, MEMORY_FORGET_ENTRY, MEMORY_SET_ENTRY_PINNED, MEMORY_DECIDE_INBOX, MEMORY_SNAPSHOT_PREVIEW,
  MEMORY_CONSOLIDATE, MEMORY_CLEAR_EPISODIC, MEMORY_LIST_LEGACY, MEMORY_DELETE_LEGACY } from '../../shared/ipc/channels'
import { computeWorkspaceHash, GLOBAL_SCOPE_ID, isManagedMemoryFile } from '../../runtime/memory/MemoryPaths'
import { getMemoryService, getMemoryEntryStore, getMemoryForgetter, getMemoryIndexDiagnostic, getMemoryIndexStatus, captureMemorySnapshot, listUnclaimedMemory, deleteUnclaimedMemory } from '../services/MemoryServiceHost'
import { organizeMemoryTopic } from '../services/MemoryMaintenanceHost'
import { getWorkspaceService } from '../services/WorkspaceService'
import { parseMemoryFile, MEMORY_TOPIC_FILES } from '../../runtime/memory/markdown/entryFormat'
import { assertMemoryFilePath } from '../../runtime/memory/markdown/atomicFile'
import { renderMemorySnapshot } from '../../runtime/memory/snapshot/renderMemorySnapshot'
import type { MemoryScope } from '../../runtime/memory/types'
import type { StoredMemoryEntry } from '../../runtime/memory/markdown/MemoryEntryStore'
import type { MemoryEntryDto, MemoryScopeStats, MemoryFileDto } from '../../shared/memory/types'

function object(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('请求参数非法')
  return raw as Record<string, unknown>
}
function text(raw: unknown, name: string): string {
  if (typeof raw !== 'string' || !raw.trim()) throw new Error(`缺少 ${name}`)
  return raw
}
function requestedScope(params: Record<string, unknown>): MemoryScope {
  if (params.scopeKind !== 'project' && params.scopeKind !== 'global') throw new Error('scopeKind 必须是 project 或 global')
  if (params.scopeId !== undefined && typeof params.scopeId !== 'string') throw new Error('scopeId 非法')
  if (params.scopeKind === 'global') {
    if (params.scopeId !== undefined && params.scopeId !== GLOBAL_SCOPE_ID) throw new Error('无权访问其他范围的记忆')
    return { scopeKind: 'global', scopeId: GLOBAL_SCOPE_ID }
  }
  const path = getWorkspaceService().getState().currentProjectPath
  if (!path?.trim()) throw new Error('请先打开工作区项目')
  const scopeId = computeWorkspaceHash(path)
  if (params.scopeId !== undefined && params.scopeId !== scopeId) throw new Error('无权访问其他项目的记忆')
  getMemoryService().registerWorkspace(path)
  return { scopeKind: 'project', scopeId }
}
function projectScope(): MemoryScope { return requestedScope({ scopeKind: 'project' }) }
function entryParams(raw: unknown) {
  const params = object(raw), scope = requestedScope(params), id = text(params.id, '记忆条目 id').trim()
  const store = getMemoryEntryStore(), entry = store.find(id, scope) ?? store.find(id)
  if (!entry) throw new Error('记忆条目不存在或已被清除')
  if (entry.record.scopeId !== scope.scopeId || entry.record.scopeKind !== scope.scopeKind) throw new Error('无权操作其他范围的记忆')
  return { params, scope, id, store, entry }
}
function toDto(entry: StoredMemoryEntry): MemoryEntryDto {
  const record = entry.record
  return { id: record.id, scopeKind: record.scopeKind, kind: record.kind, location: entry.location, relPath: entry.relPath,
    text: record.content, key: record.memoryKey, aliases: entry.aliases, explicitness: record.explicitness,
    pinned: entry.pinned, needsVerification: record.status === 'needs_verification', addedDate: entry.addedDate,
    lastSeenAt: record.lastSeenAt, evidenceCount: record.evidenceCount }
}
export function registerMemoryHandler(): void {
  handle(MEMORY_LIST_FILES, async (_event, raw: unknown): Promise<MemoryFileDto[]> => {
    const scope = requestedScope(object(raw)), service = getMemoryService(), store = getMemoryEntryStore()
    store.reconcile(scope)
    return service.listScopeFiles(scope.scopeId).map(file => {
      const managed = isManagedMemoryFile(file.relPath, scope.scopeKind)
      const model = managed ? parseMemoryFile(service.readScopeFile(scope.scopeId, file.relPath)) : null
      const topic = Object.values(MEMORY_TOPIC_FILES).includes(file.relPath)
      return { ...file, managed, readOnly: store.isReadOnly() || file.relPath.toLowerCase() === 'memory.md' || scope.scopeKind === 'global' && file.relPath === 'facts.md' || !!model?.readOnly,
        parseIssues: model?.issues ?? 0, needsOrganization: topic && !(scope.scopeKind === 'global' && file.relPath === 'facts.md') && !model?.readOnly && store.topicMaintenanceInput(scope, file.relPath).suggested }
    })
  })
  handle(MEMORY_READ_FILE, async (_event, raw: unknown) => {
    const params = object(raw), scope = requestedScope(params)
    return getMemoryService().readScopeFile(scope.scopeId, text(params.relPath, 'relPath'))
  })
  handle(MEMORY_WRITE_FILE, async (_event, raw: unknown) => {
    const params = object(raw), scope = requestedScope(params), relPath = text(params.relPath, 'relPath').replace(/\\/g, '/')
    if (typeof params.content !== 'string') throw new Error('content 必须是文本')
    if (relPath.split('/').some(part => part.startsWith('.')) || relPath.toLowerCase() === 'memory.md') throw new Error('该记忆文件只读，请编辑主题文件或 notes.md')
    const store = getMemoryEntryStore()
    if (store.isReadOnly()) throw new Error('Memory files are read-only')
    if (scope.scopeKind === 'global' && relPath === 'facts.md') throw new Error('全局记忆不允许项目事实')
    if (isManagedMemoryFile(relPath, scope.scopeKind)) return { parseIssues: store.writeManagedFile(scope, relPath, params.content) }
    getMemoryService().upsertMarkdown(scope.scopeId, relPath, params.content)
    return { parseIssues: 0 }
  })
  handle(MEMORY_LIST_ENTRIES, async (_event, raw: unknown): Promise<MemoryEntryDto[]> => {
    const params = object(raw), scope = requestedScope(params), location = params.location
    if (location !== undefined && location !== 'topics' && location !== 'inbox' && location !== 'archive') throw new Error('location 非法')
    return getMemoryEntryStore().list(scope, location).map(toDto)
  })
  handle(MEMORY_FORGET_ENTRY, async (_event, raw: unknown) => {
    const { scope, id } = entryParams(raw)
    if (!getMemoryForgetter().forget(scope, id)) throw new Error('遗忘失败')
  })
  handle(MEMORY_SET_ENTRY_PINNED, async (_event, raw: unknown) => {
    const { params, scope, id, store } = entryParams(raw)
    if (typeof params.pinned !== 'boolean') throw new Error('pinned 必须是布尔值')
    if (!store.setPinned(scope, id, params.pinned)) throw new Error('置顶失败')
  })
  handle(MEMORY_DECIDE_INBOX, async (_event, raw: unknown) => {
    const { params, scope, id, store, entry } = entryParams(raw)
    if (entry.location !== 'inbox') throw new Error('条目不在 inbox')
    if (params.decision !== 'approve' && params.decision !== 'reject') throw new Error('decision 非法')
    const changed = params.decision === 'approve' ? store.approve(scope, id) : getMemoryForgetter().forget(scope, id)
    if (!changed) throw new Error('inbox 决策失败')
  })
  handle(MEMORY_SNAPSHOT_PREVIEW, async () => {
    const path = getWorkspaceService().getState().currentProjectPath
    const rendered = path ? captureMemorySnapshot(path) : renderMemorySnapshot({ capturedAt: Date.now(), global: getMemoryEntryStore().snapshotScope({ scopeKind: 'global', scopeId: GLOBAL_SCOPE_ID }) })
    return { text: rendered.text, globalCoreCount: rendered.globalCoreCount, projectCoreCount: rendered.projectCoreCount, omittedCoreCount: rendered.omittedCoreCount }
  })
  handle(MEMORY_CONSOLIDATE, async (_event, raw: unknown) => {
    const params = object(raw), scope = requestedScope(params)
    return organizeMemoryTopic(scope, text(params.relPath, 'relPath'))
  })
  handle(MEMORY_CLEAR_EPISODIC, async () => {
    const scope = projectScope(), service = getMemoryService(), store = getMemoryEntryStore()
    if (store.isReadOnly()) throw new Error('Memory files are read-only')
    const dir = join(service.stats(scope.scopeId).scopeDir, 'episodic')
    assertMemoryFilePath(join(dir, 'probe.md'), store.memoryRoot)
    if (!existsSync(dir)) return
    for (const name of readdirSync(dir)) {
      if (!/^\d{4}-(0[1-9]|1[0-2])\.md$/.test(name) && name !== 'legacy.md') continue
      const path = join(dir, name); assertMemoryFilePath(path, store.memoryRoot); unlinkSync(path)
    }
    service.reconcile(scope.scopeId)
  })
  handle(MEMORY_LIST_LEGACY, async () => listUnclaimedMemory())
  handle(MEMORY_DELETE_LEGACY, async (_event, raw: unknown) => deleteUnclaimedMemory(text(object(raw).oldHash, 'oldHash')))
  handle(MEMORY_RECONCILE, async (_event, raw: unknown) => getMemoryService().reconcile((raw === undefined ? projectScope() : requestedScope(object(raw))).scopeId))
  handle(MEMORY_STATS, async (_event, raw: unknown): Promise<MemoryScopeStats> => {
    const scope = raw === undefined ? projectScope() : requestedScope(object(raw)), store = getMemoryEntryStore(), entries = store.list(scope), diagnostic = getMemoryIndexDiagnostic()
    return { ...getMemoryService().stats(scope.scopeId), entries: { topics: entries.filter(entry => entry.location === 'topics').length, inbox: entries.filter(entry => entry.location === 'inbox').length, archive: entries.filter(entry => entry.location === 'archive').length },
      indexStatus: getMemoryIndexStatus(scope), diagnostic, ledgerBadLines: store.stats(scope).ledgerBadLines, readOnly: store.isReadOnly() }
  })
  handle(MEMORY_OPEN_DIR, async (_event, raw: unknown) => {
    const scope = raw === undefined ? projectScope() : requestedScope(object(raw)), store = getMemoryEntryStore(), dir = getMemoryService().stats(scope.scopeId).scopeDir
    assertMemoryFilePath(join(dir, 'probe.md'), store.memoryRoot); mkdirSync(dir, { recursive: true })
    const err = await shell.openPath(dir)
    if (err) throw new Error(`无法打开记忆目录：${err}`)
  })
}
