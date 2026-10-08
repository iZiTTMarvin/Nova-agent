import { afterEach, describe, expect, it } from 'vitest'
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openBetterSqliteMemoryDb } from '@runtime/memory/BetterSqliteMemoryDb'
import type { MemoryRecordDraft } from '@runtime/memory/repository/MemoryRepository'
import { createMarkdownMemoryFixture } from '../../fixtures/memory/MarkdownMemoryFixture'
import { getProjectMemoryDir } from '@runtime/memory/MemoryPaths'
import { localMemoryDate } from '@runtime/memory/markdown/entryFormat'

const scope = { scopeKind: 'project' as const, scopeId: 'a'.repeat(16) }
const other = { scopeKind: 'project' as const, scopeId: 'b'.repeat(16) }
const global = { scopeKind: 'global' as const, scopeId: 'user' }
const id = (n: number): string => `m_${String(n).padStart(10, '0')}`
const NOW = 1780000000000

describe('Markdown repository with rebuildable SQLite projection', () => {
  let root: string
  let db: ReturnType<typeof openBetterSqliteMemoryDb> | undefined
  let clock = NOW
  afterEach(() => { db?.close(); db = undefined; if (root) rmSync(root, { recursive: true, force: true }); clock = NOW })
  function setup(options: Parameters<typeof createMarkdownMemoryFixture>[3] = {}) {
    root = mkdtempSync(join(tmpdir(), 'nova-markdown-repo-'))
    db = openBetterSqliteMemoryDb(join(root, 'memory.db'))
    return createMarkdownMemoryFixture(root, db, () => clock, options)
  }
  function draft(overrides: Partial<MemoryRecordDraft> = {}): MemoryRecordDraft {
    return { id: id(1), scope, kind: 'decision', memoryKey: 'database.primary', content: '项目主数据库使用 PostgreSQL', status: 'active', confidence: 0.9, explicitness: 'workspace_verified', sourceType: 'workspace', evidence: [{ evidenceType: 'workspace', sessionId: 's1', projectScopeId: scope.scopeId, excerpt: '使用 PostgreSQL' }], ...overrides }
  }
  it('round-trips file fields and derives timestamps/counts only from provenance', () => {
    const { repository: repo } = setup()
    const saved = repo.insertRecord(draft({ sourcePath: 'package.json', sourceFingerprint: '1024-1700000000', aliases: ['database', '数据库'], evidence: [{ evidenceType: 'user_message', sessionId: 's1', messageId: 'msg1', projectScopeId: scope.scopeId, excerpt: '数据库使用 PostgreSQL', createdAt: NOW - 100 }, { evidenceType: 'workspace', sessionId: 's2', projectScopeId: scope.scopeId }] }))
    expect(saved).toMatchObject({ id: id(1), ...scope, kind: 'decision', status: 'active', sourcePath: 'package.json', sourceFingerprint: '1024-1700000000', createdAt: NOW, validFrom: NOW, validTo: null, supersedesId: null, evidenceCount: 2, distinctSessionCount: 2, distinctProjectCount: 1, metadata: null })
    expect(repo.listEvidence(id(1))).toHaveLength(2)
    expect(repo.listEvidence(id(1))[0]).toMatchObject({ memoryId: id(1), sessionId: 's1', messageId: 'msg1', excerpt: '数据库使用 PostgreSQL', createdAt: NOW - 100 })
    expect(repo.findById(id(1))).toEqual(saved)
    expect(repo.findById(id(99))).toBeNull()
    expect(repo.searchFts('database')[0].record.id).toBe(id(1))
  })
  it('isolates projects and global preferences', () => {
    const { repository: repo } = setup()
    repo.insertRecord(draft({ content: '项目 commit 使用 emoji 风格' }))
    repo.insertRecord(draft({ id: id(2), scope: other, content: '项目 commit 使用 conventional 风格' }))
    repo.insertRecord(draft({ id: id(3), scope: global, kind: 'preference', content: '用户偏好中文注释' }))
    expect(repo.searchFts('commit', { scope }).map(hit => hit.record.id)).toEqual([id(1)])
    expect(repo.searchFts('commit').map(hit => hit.record.id).sort()).toEqual([id(1), id(2)])
    expect(repo.searchFts('中文注释', { scopeKinds: ['global'] }).map(hit => hit.record.id)).toEqual([id(3)])
    expect(repo.searchFts('中文注释', { scope })).toEqual([])
    expect(() => repo.insertRecord(draft({ id: id(4), scope: global, kind: 'project_fact' }))).toThrow('Global memory')
  })
  it('supersedes once and reconstructs history through the archive replacement link', () => {
    const { repository: repo } = setup()
    repo.insertRecord(draft({ content: '项目主数据库为 SQLite' }))
    clock += 1000
    const fresh = repo.supersedeWithInsert(id(1), draft({ id: id(2) }))
    expect(fresh.supersedesId).toBe(id(1))
    expect(repo.findById(id(1))?.status).toBe('superseded')
    expect(localMemoryDate(repo.findById(id(1))!.validTo!)).toBe(localMemoryDate(clock))
    expect(repo.searchFts('主数据库').map(hit => hit.record.id)).toEqual([id(2)])
    expect(repo.searchFts('主数据库', { status: 'any' })).toHaveLength(2)
    expect(repo.searchFts('主数据库', { status: 'superseded' }).map(hit => hit.record.id)).toEqual([id(1)])
    expect(repo.countActiveByKey(scope, 'decision', 'database.primary')).toBe(1)
    expect(repo.findActiveByKey(scope, 'decision', 'database.primary')?.id).toBe(id(2))
  })
  it('rejects duplicate IDs/active keys and superseding an archived predecessor without altering facts', () => {
    const { repository: repo } = setup()
    repo.insertRecord(draft())
    expect(() => repo.supersedeWithInsert(id(1), draft())).toThrow('Duplicate')
    expect(repo.findById(id(1))?.status).toBe('active')
    expect(() => repo.insertRecord(draft({ id: id(2) }))).toThrow('Active memory key')
    repo.retract(id(1))
    expect(() => repo.supersedeWithInsert(id(1), draft({ id: id(2) }))).toThrow('archived')
    expect(repo.findById(id(2))).toBeNull()
    expect(repo.findById(id(1))?.status).toBe('retracted')
  })
  it('archives retractions idempotently and completely purges forgotten entries/provenance', () => {
    const { repository: repo } = setup()
    repo.insertRecord(draft())
    expect(repo.retract(id(1))).toBe(true)
    expect(repo.retract(id(1))).toBe(true)
    expect(repo.searchFts('PostgreSQL')).toEqual([])
    expect(repo.searchFts('PostgreSQL', { status: 'retracted' })).toHaveLength(1)
    expect(repo.purge(id(1))).toBe(true)
    expect(repo.purge(id(1))).toBe(false)
    expect(repo.searchFts('PostgreSQL', { status: 'any' })).toEqual([])
    expect(repo.listEvidence(id(1))).toEqual([])
    expect(readFileSync(join(getProjectMemoryDir(root, scope.scopeId), '.ledger.jsonl'), 'utf8')).not.toContain(id(1))
  })
  it('writes verification to the topic file and re-confirmation removes it on the same ID', () => {
    const { repository: repo } = setup()
    repo.insertRecord(draft())
    clock += 500
    expect(repo.updateStatus(id(1), 'needs_verification')).toBe(true)
    expect(readFileSync(join(getProjectMemoryDir(root, scope.scopeId), 'decisions.md'), 'utf8')).toContain('verify=1')
    expect(repo.findById(id(1))?.updatedAt).toBe(clock)
    expect(repo.searchFts('PostgreSQL')).toEqual([])
    expect(repo.searchFts('PostgreSQL', { status: 'needs_verification' })).toHaveLength(1)
    repo.mergeEvidence(id(1), { evidence: [{ evidenceType: 'user_message', sessionId: 's2' }] })
    expect(repo.findById(id(1))?.status).toBe('active')
    expect(readFileSync(join(getProjectMemoryDir(root, scope.scopeId), 'decisions.md'), 'utf8')).not.toContain('verify=1')
    expect(repo.updateStatus(id(99), 'active')).toBe(false)
  })
  it('rolls back file changes when provenance append fails during insert, merge or supersede', () => {
    let failing = false
    const { repository: repo } = setup({ appendLedgerFile: (path, data, options) => { if (failing) throw new Error('ledger disk failure'); appendFileSync(path, data, options) } })
    failing = true
    expect(() => repo.insertRecord(draft())).toThrow('ledger disk failure')
    expect(repo.findById(id(1))).toBeNull()
    expect(repo.listEvidence(id(1))).toEqual([])
    failing = false
    repo.insertRecord(draft())
    const before = repo.findById(id(1))
    failing = true
    clock += 100
    expect(() => repo.mergeEvidence(id(1), { evidence: [{ evidenceType: 'tool_result', sessionId: 's2' }] })).toThrow('ledger disk failure')
    expect(() => repo.supersedeWithInsert(id(1), draft({ id: id(2) }))).toThrow('ledger disk failure')
    expect(repo.findById(id(1))).toEqual(before)
    expect(repo.listEvidence(id(1))).toHaveLength(1)
    expect(repo.findById(id(2))).toBeNull()
  })
  it('derives distinct evidence counters and merge timestamps without trusting synthetic totals', () => {
    const { repository: repo } = setup()
    repo.insertRecord(draft({ confidence: 0.5 }))
    clock += 5000
    expect(repo.mergeEvidence(id(1), { evidence: [{ evidenceType: 'user_message', sessionId: 's2', projectScopeId: other.scopeId }, { evidenceType: 'tool_result', sessionId: 's2', projectScopeId: other.scopeId }], confidence: 0.7, distinctSessionCount: 999, distinctProjectCount: 999, lastSeenAt: clock + 1000 })).toBe(true)
    expect(repo.findById(id(1))).toMatchObject({ evidenceCount: 3, distinctSessionCount: 2, distinctProjectCount: 2, confidence: 0.7, updatedAt: clock + 1000, lastSeenAt: clock + 1000 })
    expect(repo.mergeEvidence(id(99), { evidence: [] })).toBe(false)
  })
  it('retrieves Chinese bigrams, aliases and keys while excluding pending in every retrieval mode', () => {
    const { repository: repo } = setup()
    repo.insertRecord(draft({ memoryKey: null, content: '中文子串召回', aliases: ['ghost_text'] }))
    repo.insertRecord(draft({ id: id(2), status: 'pending', memoryKey: null, content: '中文子串待定记忆' }))
    repo.insertRecord(draft({ id: id(3), memoryKey: 'repo.url', content: '其他文档地址' }))
    expect(repo.searchFts('中文').map(hit => hit.record.id)).toEqual([id(1)])
    expect(repo.searchFts('中文', { status: 'any' }).map(hit => hit.record.id)).toEqual([id(1)])
    expect(repo.searchFts('repo').map(hit => hit.record.id)).toEqual([id(3)])
    expect(repo.searchFts('ghost_text')[0].record.id).toBe(id(1))
    expect(repo.searchFts('xy')).toEqual([])
  })
  it('groups statistics by scope/kind/status', () => {
    const { repository: repo } = setup()
    repo.insertRecord(draft())
    repo.insertRecord(draft({ id: id(2), kind: 'preference', status: 'pending', memoryKey: 'editor.font' }))
    repo.insertRecord(draft({ id: id(3), scope: global, kind: 'preference' }))
    expect(repo.stats()).toEqual([{ ...global, kind: 'preference', status: 'active', count: 1 }, { ...scope, kind: 'decision', status: 'active', count: 1 }, { ...scope, kind: 'preference', status: 'pending', count: 1 }])
    expect(repo.stats(scope)).toHaveLength(2)
  })
  it('filters lists and preserves updated timestamp ordering and limits', () => {
    const { repository: repo } = setup()
    repo.insertRecord(draft({ status: 'pending' }))
    clock++
    repo.insertRecord(draft({ id: id(2), memoryKey: 'k2' }))
    clock++
    repo.insertRecord(draft({ id: id(3), kind: 'gotcha', memoryKey: null }))
    expect(repo.listByScope(scope, { status: 'active', limit: 1 }).map(record => record.id)).toEqual([id(3)])
    expect(repo.listByScope(scope, { kind: 'decision' }).map(record => record.id)).toEqual([id(2), id(1)])
  })
})
