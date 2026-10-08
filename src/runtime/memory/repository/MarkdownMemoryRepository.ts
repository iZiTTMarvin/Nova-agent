import type { MemoryEntryStore } from '../markdown/MemoryEntryStore'
import type { MemoryIndex } from '../index/MemoryIndex'
import type { MemoryKind, MemoryRecord, MemoryRecordStatsRow, MemoryScope, MemoryStatus } from '../types'
import type { MemoryEvidenceMergeInput, MemoryFtsSearchOptions, MemoryRecordDraft, MemoryRecordFtsHit, MemoryRecordListOptions, MemoryRepository, MemoryStatusUpdateOptions } from './MemoryRepository'
import { DEFAULT_RECORD_LIST_LIMIT } from './MemoryRepository'

const scopeOf = (record: MemoryRecord): MemoryScope => ({ scopeKind: record.scopeKind, scopeId: record.scopeId })

export class MarkdownMemoryRepository implements MemoryRepository {
  /**
   * @param forget 彻底遗忘入口。生产接线必须注入 MemoryForgetter（无默认值，防止漏注入
   *   走回不彻底的删除路径），让 memory_manage 用户证据否定与设置页走同一完整遗忘流程。
   */
  constructor(
    readonly store: MemoryEntryStore,
    private readonly index: MemoryIndex | null,
    private readonly onIndexError: (error: unknown) => void,
    private readonly forget: (scope: MemoryScope, id: string) => boolean
  ) {}

  insertRecord(draft: MemoryRecordDraft): MemoryRecord {
    if (draft.status === 'active' && draft.memoryKey && this.countActiveByKey(draft.scope, draft.kind, draft.memoryKey)) throw new Error('Active memory key already exists')
    return this.store.insert(draft)
  }
  findById(id: string): MemoryRecord | null { return this.store.find(id)?.record ?? null }
  findActiveByKey(scope: MemoryScope, kind: MemoryKind, memoryKey: string): MemoryRecord | null {
    return this.store.list(scope).find(entry => entry.record.status === 'active' && entry.record.kind === kind && entry.record.memoryKey === memoryKey)?.record ?? null
  }
  countActiveByKey(scope: MemoryScope, kind: MemoryKind, memoryKey: string): number {
    return this.store.list(scope).filter(entry => entry.record.status === 'active' && entry.record.kind === kind && entry.record.memoryKey === memoryKey).length
  }
  listByScope(scope: MemoryScope, options: MemoryRecordListOptions = {}): MemoryRecord[] {
    return this.store.list(scope).map(entry => entry.record).filter(record => (!options.kind || record.kind === options.kind) && (!options.status || record.status === options.status)).sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id)).slice(0, options.limit ?? DEFAULT_RECORD_LIST_LIMIT)
  }
  listEvidence(id: string) {
    const entry = this.store.find(id)
    return entry ? this.store.listEvidence(scopeOf(entry.record), id) : []
  }
  updateStatus(id: string, status: MemoryStatus, options?: MemoryStatusUpdateOptions): boolean {
    const record = this.findById(id)
    return record ? this.store.updateStatus(scopeOf(record), id, status, options) : false
  }
  supersedeWithInsert(oldId: string, draft: MemoryRecordDraft): MemoryRecord { return this.store.supersede(draft.scope, oldId, draft) }
  mergeEvidence(id: string, input: MemoryEvidenceMergeInput): boolean {
    const record = this.findById(id)
    return record ? this.store.mergeEvidence(scopeOf(record), id, input) : false
  }
  searchFts(query: string, options: MemoryFtsSearchOptions = {}): MemoryRecordFtsHit[] {
    const scopes = options.scope ? [options.scope] : options.scopes ?? this.store.listScopes().filter(scope => !options.scopeKinds || options.scopeKinds.includes(scope.scopeKind))
    const limit = options.limit ?? 10
    const history = !!options.status && options.status !== 'active'
    const hits: MemoryRecordFtsHit[] = []
    let indexed: ReturnType<MemoryIndex['searchScopes']> | null = null
    try {
      if (!this.index) throw new Error('Memory index unavailable')
      for (const scope of scopes) {
        this.store.findByIds(scope, [])
        if (this.index.isDirty(scope)) this.index.rebuild(scope, this.store.list(scope))
      }
      indexed = this.index.searchScopes(scopes, query, limit, history)
    } catch (error) { if (this.index) this.onIndexError(error) }
    for (const scope of scopes) {
      const lexical = indexed?.get(scope.scopeId) ?? this.store.scan(scope, query, limit, history)
      const entries = this.store.findByIds(scope, lexical.map(hit => hit.id))
      const scores = new Map(lexical.map(hit => [hit.id, hit.score]))
      for (const { record, relPath } of entries) if (!options.status || options.status === 'any' || options.status === record.status) hits.push({ record, relPath, score: scores.get(record.id)! })
    }
    return hits.sort((a, b) => b.score - a.score || a.record.id.localeCompare(b.record.id)).slice(0, limit)
  }
  retract(id: string): boolean { return this.updateStatus(id, 'retracted') }
  purge(id: string): boolean {
    const record = this.findById(id)
    return record ? this.forget(scopeOf(record), id) : false
  }
  stats(scope?: MemoryScope): MemoryRecordStatsRow[] {
    const counts = new Map<string, MemoryRecordStatsRow>()
    for (const current of scope ? [scope] : this.store.listScopes()) for (const { record } of this.store.list(current)) {
      const key = `${record.scopeId}/${record.kind}/${record.status}`
      const row = counts.get(key) ?? { ...current, kind: record.kind, status: record.status, count: 0 }
      row.count++
      counts.set(key, row)
    }
    return [...counts.values()]
  }
}
