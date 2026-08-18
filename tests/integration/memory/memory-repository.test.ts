/**
 * 结构化记忆仓储集成测试（better-sqlite3 @ Node ABI）：
 * CRUD 往返、状态转移与 FTS 过滤、事务回滚、scope 隔离、中文召回、stats 聚合。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { openBetterSqliteMemoryDb } from '@runtime/memory/BetterSqliteMemoryDb'
import { SqliteMemoryRepository } from '@runtime/memory/repository/SqliteMemoryRepository'
import type {
  MemoryRecordDraft,
  MemoryRepository
} from '@runtime/memory/repository/MemoryRepository'

describe('结构化记忆仓储（SqliteMemoryRepository）', () => {
  let tempDir: string | null = null
  let db: ReturnType<typeof openBetterSqliteMemoryDb> | null = null

  const NOW = 1_780_000_000_000
  let clock = NOW
  let idSeq = 0

  afterEach(() => {
    db?.close()
    db = null
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true })
      tempDir = null
    }
    clock = NOW
    idSeq = 0
  })

  function openRepo(): MemoryRepository {
    tempDir = mkdtempSync(join(tmpdir(), 'nova-mem-repo-'))
    db = openBetterSqliteMemoryDb(join(tempDir, 'memory.db'))
    return new SqliteMemoryRepository(db, {
      now: () => clock,
      generateId: () => `ev_${++idSeq}`
    })
  }

  const SCOPE_A = { scopeKind: 'project' as const, scopeId: 'a'.repeat(16) }
  const SCOPE_B = { scopeKind: 'project' as const, scopeId: 'b'.repeat(16) }
  const SCOPE_GLOBAL = { scopeKind: 'global' as const, scopeId: 'user' }

  function draft(overrides: Partial<MemoryRecordDraft> = {}): MemoryRecordDraft {
    return {
      id: 'mem_1',
      scope: SCOPE_A,
      kind: 'decision',
      memoryKey: 'database.primary',
      content: '项目主数据库使用 PostgreSQL',
      status: 'active',
      confidence: 0.9,
      explicitness: 'workspace_verified',
      sourceType: 'workspace',
      evidence: [{ evidenceType: 'workspace', excerpt: 'package.json 依赖显示 pg' }],
      ...overrides
    }
  }

  it('CRUD 往返：全字段、可空列与 metadata JSON 对象往返', () => {
    const repo = openRepo()

    const saved = repo.insertRecord(
      draft({
        id: 'mem_crud',
        sourcePath: 'package.json',
        sourceFingerprint: '1024-1700000000',
        distinctSessionCount: 2,
        distinctProjectCount: 1,
        metadata: { nested: { count: 2 }, tags: ['pg', 'db'] },
        evidence: [
          {
            id: 'evx_1',
            sessionId: 'sess-1',
            messageId: 'msg-1',
            projectScopeId: SCOPE_A.scopeId,
            evidenceType: 'user_message',
            excerpt: '数据库就用 PostgreSQL',
            createdAt: NOW - 100
          },
          { evidenceType: 'tool_result', excerpt: null, sessionId: null, messageId: null }
        ]
      })
    )

    expect(saved).toMatchObject({
      id: 'mem_crud',
      scopeKind: 'project',
      scopeId: SCOPE_A.scopeId,
      kind: 'decision',
      memoryKey: 'database.primary',
      content: '项目主数据库使用 PostgreSQL',
      status: 'active',
      confidence: 0.9,
      explicitness: 'workspace_verified',
      sourceType: 'workspace',
      validFrom: NOW,
      validTo: null,
      supersedesId: null,
      evidenceCount: 2,
      distinctSessionCount: 2,
      distinctProjectCount: 1,
      sourcePath: 'package.json',
      sourceFingerprint: '1024-1700000000',
      createdAt: NOW,
      updatedAt: NOW,
      lastSeenAt: NOW
    })
    expect(saved.metadata).toEqual({ nested: { count: 2 }, tags: ['pg', 'db'] })

    const evidence = repo.listEvidence('mem_crud')
    expect(evidence).toHaveLength(2)
    expect(evidence[0]).toEqual({
      id: 'evx_1',
      memoryId: 'mem_crud',
      sessionId: 'sess-1',
      messageId: 'msg-1',
      projectScopeId: SCOPE_A.scopeId,
      evidenceType: 'user_message',
      excerpt: '数据库就用 PostgreSQL',
      createdAt: NOW - 100
    })
    expect(evidence[1].id).toBe('ev_1')
    expect(evidence[1].memoryId).toBe('mem_crud')
    expect(evidence[1].evidenceType).toBe('tool_result')

    expect(repo.findById('mem_crud')?.metadata).toEqual(saved.metadata)
    expect(repo.findById('missing')).toBeNull()
  })

  it('scope 隔离：project A / project B / global 互不串', () => {
    const repo = openRepo()

    repo.insertRecord(
      draft({ id: 'mem_a', memoryKey: 'commit.style', content: '本项目 commit 使用 emoji 风格' })
    )
    repo.insertRecord(
      draft({
        id: 'mem_b',
        scope: SCOPE_B,
        memoryKey: 'commit.style',
        content: '本项目 commit 使用 conventional 风格'
      })
    )
    repo.insertRecord(
      draft({
        id: 'mem_g',
        scope: SCOPE_GLOBAL,
        kind: 'preference',
        memoryKey: 'comment.language',
        content: '用户偏好使用中文注释',
        explicitness: 'user_explicit'
      })
    )

    expect(repo.listByScope(SCOPE_A).map((r) => r.id)).toEqual(['mem_a'])
    expect(repo.listByScope(SCOPE_B).map((r) => r.id)).toEqual(['mem_b'])
    expect(repo.listByScope(SCOPE_GLOBAL).map((r) => r.id)).toEqual(['mem_g'])

    const scoped = repo.searchFts('commit 使用', { scope: SCOPE_A })
    expect(scoped.map((h) => h.record.id)).toEqual(['mem_a'])

    const unscoped = repo.searchFts('commit 使用')
    expect(unscoped.map((h) => h.record.id).sort()).toEqual(['mem_a', 'mem_b'])

    const globalOnly = repo.searchFts('中文注释', { scopeKinds: ['global'] })
    expect(globalOnly.map((h) => h.record.id)).toEqual(['mem_g'])

    expect(repo.searchFts('中文注释', { scope: SCOPE_A })).toEqual([])
    expect(repo.searchFts('中文注释', { scope: SCOPE_B })).toEqual([])
  })

  it('状态转移：supersedeWithInsert 后默认 FTS 只回 active，历史检索可回 superseded', () => {
    const repo = openRepo()

    repo.insertRecord(draft({ id: 'mem_old', content: '项目主数据库为 SQLite' }))
    clock += 1000
    const saved = repo.supersedeWithInsert(
      'mem_old',
      draft({ id: 'mem_new', content: '项目主数据库为 PostgreSQL' })
    )
    expect(saved.id).toBe('mem_new')

    const old = repo.findById('mem_old')
    expect(old?.status).toBe('superseded')
    expect(old?.validTo).toBe(NOW + 1000)
    const fresh = repo.findById('mem_new')
    expect(fresh?.status).toBe('active')
    expect(fresh?.supersedesId).toBe('mem_old')

    expect(repo.searchFts('主数据库').map((h) => h.record.id)).toEqual(['mem_new'])
    expect(repo.searchFts('主数据库', { status: 'any' })).toHaveLength(2)
    expect(repo.searchFts('主数据库', { status: 'superseded' }).map((h) => h.record.id)).toEqual([
      'mem_old'
    ])

    expect(repo.findActiveByKey(SCOPE_A, 'decision', 'database.primary')?.id).toBe('mem_new')
    expect(repo.countActiveByKey(SCOPE_A, 'decision', 'database.primary')).toBe(1)
  })

  it('supersedeWithInsert：插入失败或旧目标非 live 时整体回滚', () => {
    const repo = openRepo()

    repo.insertRecord(draft({ id: 'mem_old', content: '项目主数据库为 SQLite' }))
    clock += 1000
    expect(() =>
      repo.supersedeWithInsert(
        'mem_old',
        draft({
          id: 'mem_new',
          content: '项目主数据库为 PostgreSQL',
          evidence: [
            { id: 'dup_ev', evidenceType: 'workspace' },
            { id: 'dup_ev', evidenceType: 'tool_result' }
          ]
        })
      )
    ).toThrow()
    expect(repo.findById('mem_new')).toBeNull()
    expect(repo.findById('mem_old')?.status).toBe('active')
    expect(repo.countActiveByKey(SCOPE_A, 'decision', 'database.primary')).toBe(1)

    repo.retract('mem_old')
    clock += 1000
    expect(() =>
      repo.supersedeWithInsert(
        'mem_old',
        draft({ id: 'mem_rejected', content: '项目主数据库为 PostgreSQL' })
      )
    ).toThrow()
    expect(repo.findById('mem_rejected')).toBeNull()
    expect(repo.findById('mem_old')?.status).toBe('retracted')
  })

  it('retract：撤回后默认检索不再返回，重复撤回状态保持不变', () => {
    const repo = openRepo()

    repo.insertRecord(draft({ id: 'mem_retract' }))
    expect(repo.searchFts('PostgreSQL').map((h) => h.record.id)).toEqual(['mem_retract'])

    expect(repo.retract('mem_retract')).toBe(true)
    expect(repo.findById('mem_retract')?.status).toBe('retracted')
    expect(repo.searchFts('PostgreSQL')).toEqual([])
    expect(repo.searchFts('PostgreSQL', { status: 'retracted' })).toHaveLength(1)

    clock += 100
    repo.retract('mem_retract')
    const row = repo.findById('mem_retract')
    expect(row?.status).toBe('retracted')
    expect(repo.searchFts('PostgreSQL')).toEqual([])
    expect(repo.retract('mem_missing')).toBe(false)

    expect(repo.findActiveByKey(SCOPE_A, 'decision', 'database.primary')).toBeNull()
  })

  it('updateStatus：写入状态与 validTo / supersedesId 选项', () => {
    const repo = openRepo()

    repo.insertRecord(draft({ id: 'mem_status' }))
    clock += 500

    expect(repo.updateStatus('mem_status', 'needs_verification', { validTo: NOW + 1, supersedesId: 'mem_other' })).toBe(true)
    const row = repo.findById('mem_status')
    expect(row?.status).toBe('needs_verification')
    expect(row?.validTo).toBe(NOW + 1)
    expect(row?.supersedesId).toBe('mem_other')
    expect(row?.updatedAt).toBe(NOW + 500)

    expect(repo.updateStatus('missing', 'active')).toBe(false)
  })

  it('evidence 事务性：证据插入失败时记录与证据整体回滚', () => {
    const repo = openRepo()

    expect(() =>
      repo.insertRecord(
        draft({
          id: 'mem_tx',
          evidence: [
            { id: 'dup_ev', evidenceType: 'user_message' },
            { id: 'dup_ev', evidenceType: 'tool_result' }
          ]
        })
      )
    ).toThrow()
    expect(repo.findById('mem_tx')).toBeNull()
    expect(repo.listEvidence('mem_tx')).toEqual([])

    repo.insertRecord(draft({ id: 'mem_keep' }))
    clock += 1
    expect(() =>
      repo.mergeEvidence('mem_keep', {
        evidence: [
          { id: 'dup2_ev', evidenceType: 'workspace' },
          { id: 'dup2_ev', evidenceType: 'tool_result' }
        ]
      })
    ).toThrow()

    const kept = repo.findById('mem_keep')
    expect(kept?.evidenceCount).toBe(1)
    expect(kept?.updatedAt).toBe(NOW)
    expect(repo.listEvidence('mem_keep')).toHaveLength(1)
  })

  it('mergeEvidence：追加证据并同步计数、lastSeenAt 与置信度', () => {
    const repo = openRepo()

    repo.insertRecord(
      draft({
        id: 'mem_merge',
        confidence: 0.5,
        distinctSessionCount: 1,
        distinctProjectCount: 1
      })
    )
    clock += 5000

    const ok = repo.mergeEvidence('mem_merge', {
      evidence: [{ evidenceType: 'user_message', sessionId: 'sess-2', excerpt: '再次确认用 PostgreSQL' }],
      confidence: 0.7,
      distinctSessionCount: 2,
      distinctProjectCount: 3,
      lastSeenAt: NOW + 6000
    })
    expect(ok).toBe(true)

    const row = repo.findById('mem_merge')
    expect(row?.evidenceCount).toBe(2)
    expect(row?.confidence).toBe(0.7)
    expect(row?.distinctSessionCount).toBe(2)
    expect(row?.distinctProjectCount).toBe(3)
    expect(row?.lastSeenAt).toBe(NOW + 6000)
    expect(row?.updatedAt).toBe(NOW + 5000)

    const evidence = repo.listEvidence('mem_merge')
    expect(evidence).toHaveLength(2)
    expect(evidence[1]).toMatchObject({ sessionId: 'sess-2', evidenceType: 'user_message' })

    expect(repo.mergeEvidence('mem_missing', { evidence: [] })).toBe(false)
  })

  it('FTS 中文 trigram 子串召回，memory_key 列参与索引，pending 默认不参与检索', () => {
    const repo = openRepo()

    repo.insertRecord(
      draft({
        id: 'mem_cjk',
        memoryKey: null,
        content: '跨会话记忆需要中文子串召回能力'
      })
    )
    repo.insertRecord(
      draft({
        id: 'mem_pending',
        memoryKey: null,
        status: 'pending',
        content: '另一条同样包含中文子串的待定记忆'
      })
    )
    repo.insertRecord(
      draft({
        id: 'mem_key',
        memoryKey: 'repo.url',
        content: '与查询词完全无关的正文内容'
      })
    )

    expect(repo.searchFts('中文子串').map((h) => h.record.id)).toEqual(['mem_cjk'])
    expect(repo.searchFts('中文子串', { status: 'any' }).map((h) => h.record.id).sort()).toEqual([
      'mem_cjk',
      'mem_pending'
    ])
    expect(repo.searchFts('repo').map((h) => h.record.id)).toEqual(['mem_key'])
    expect(repo.searchFts('ab')).toEqual([])
  })

  it('stats：按 scope/kind/status 聚合计数，可按 scope 过滤', () => {
    const repo = openRepo()

    repo.insertRecord(draft({ id: 'mem_s1', kind: 'decision', status: 'active' }))
    repo.insertRecord(
      draft({ id: 'mem_s2', kind: 'preference', status: 'pending', memoryKey: 'editor.font' })
    )
    repo.insertRecord(
      draft({
        id: 'mem_s3',
        scope: SCOPE_GLOBAL,
        kind: 'preference',
        status: 'active',
        memoryKey: 'comment.language'
      })
    )

    const all = repo.stats()
    expect(all).toEqual([
      { scopeKind: 'global', scopeId: 'user', kind: 'preference', status: 'active', count: 1 },
      { scopeKind: 'project', scopeId: SCOPE_A.scopeId, kind: 'decision', status: 'active', count: 1 },
      { scopeKind: 'project', scopeId: SCOPE_A.scopeId, kind: 'preference', status: 'pending', count: 1 }
    ])

    expect(repo.stats(SCOPE_A)).toEqual([
      { scopeKind: 'project', scopeId: SCOPE_A.scopeId, kind: 'decision', status: 'active', count: 1 },
      { scopeKind: 'project', scopeId: SCOPE_A.scopeId, kind: 'preference', status: 'pending', count: 1 }
    ])
  })

  it('listByScope：status/kind 过滤、updated_at 倒序与 limit 截断', () => {
    const repo = openRepo()

    repo.insertRecord(draft({ id: 'mem_l1', status: 'pending', memoryKey: 'k1' }))
    clock += 1
    repo.insertRecord(draft({ id: 'mem_l2', status: 'active', memoryKey: 'k2' }))
    clock += 1
    repo.insertRecord(draft({ id: 'mem_l3', kind: 'gotcha', status: 'active', memoryKey: null }))

    expect(repo.listByScope(SCOPE_A).map((r) => r.id)).toEqual(['mem_l3', 'mem_l2', 'mem_l1'])
    expect(repo.listByScope(SCOPE_A, { status: 'active' }).map((r) => r.id)).toEqual([
      'mem_l3',
      'mem_l2'
    ])
    expect(repo.listByScope(SCOPE_A, { kind: 'gotcha' }).map((r) => r.id)).toEqual(['mem_l3'])
    expect(repo.listByScope(SCOPE_A, { limit: 1 }).map((r) => r.id)).toEqual(['mem_l3'])
    expect(repo.listByScope(SCOPE_B)).toEqual([])
  })
})
