/**
 * 候选落库管线集成（better-sqlite3 @ Node ABI）：
 * candidate → processor（查询 → policy → repository）端到端断言：
 * ADD 缓行、MERGE 计数与晋升、SUPERSEDE 链、RETRACT 软删除与防复活、scope 纠偏、keyless 等价、单条失败 fail-soft。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { openBetterSqliteMemoryDb } from '@runtime/memory/BetterSqliteMemoryDb'
import { SqliteMemoryRepository } from '@runtime/memory/repository/SqliteMemoryRepository'
import type { MemoryRepository } from '@runtime/memory/repository/MemoryRepository'
import { MemoryCandidateProcessor } from '@runtime/memory/policy/MemoryCandidateProcessor'
import { computeFingerprint } from '@runtime/memory/FtsQueryBuilder'
import type { MemoryCandidate } from '@runtime/memory/types'

describe('候选落库管线（MemoryCandidateProcessor + 真 SQLite）', () => {
  let tempDir: string | null = null
  let db: ReturnType<typeof openBetterSqliteMemoryDb> | null = null

  const NOW = 1_780_000_000_000
  let clock = NOW
  let idSeq = 0
  let repo: MemoryRepository
  let processor: MemoryCandidateProcessor

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

  function setup(): void {
    tempDir = mkdtempSync(join(tmpdir(), 'nova-mem-proc-'))
    db = openBetterSqliteMemoryDb(join(tempDir, 'memory.db'))
    repo = new SqliteMemoryRepository(db, {
      now: () => clock,
      generateId: () => `ev_${++idSeq}`
    })
    processor = new MemoryCandidateProcessor({
      repository: repo,
      now: () => clock,
      generateRecordId: () => `mem_${++idSeq}`
    })
  }

  const PROJECT_A = { scopeKind: 'project' as const, scopeId: 'a'.repeat(16) }
  const PROJECT_B = { scopeKind: 'project' as const, scopeId: 'b'.repeat(16) }
  const GLOBAL = { scopeKind: 'global' as const, scopeId: 'user' }

  function writeWorkspaceFile(
    relPath: string,
    body: string
  ): { workspaceRoot: string; fingerprint: string } {
    if (!tempDir) {
      throw new Error('setup() must run before writeWorkspaceFile')
    }
    const workspaceRoot = join(tempDir, 'workspace')
    mkdirSync(workspaceRoot, { recursive: true })
    const fullPath = join(workspaceRoot, relPath)
    writeFileSync(fullPath, body)
    const stat = statSync(fullPath)
    return {
      workspaceRoot,
      fingerprint: computeFingerprint(stat.size, Math.floor(stat.mtimeMs))
    }
  }

  function candidate(overrides: Partial<MemoryCandidate> = {}): MemoryCandidate {
    return {
      kind: 'workflow',
      scopeHint: 'project',
      memoryKey: 'build.verify',
      content: '修改原生模块依赖后先跑单测再重建原生绑定',
      explicitness: 'observed',
      confidence: 0.6,
      intent: 'assert',
      evidence: [{ type: 'tool_result', excerpt: 'npm run rebuild 后测试通过' }],
      ...overrides
    }
  }

  it('observed 首次 ADD 缓行 pending；跨 session MERGE 去重计数并晋升 active', () => {
    setup()

    const first = processor.process({
      sessionId: 'sess-1',
      projectScopeId: PROJECT_A.scopeId,
      candidates: [candidate()]
    })
    expect(first).toMatchObject({ candidates: 1, added: 1, promoted: 0 })

    const pending = repo.findActiveByKey(PROJECT_A, 'workflow', 'build.verify')
    expect(pending).toBeNull()
    const rows = repo.listByScope(PROJECT_A, { status: 'pending' })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      evidenceCount: 1,
      distinctSessionCount: 1,
      confidence: 0.6,
      status: 'pending'
    })
    expect(repo.listEvidence(rows[0].id)).toHaveLength(1)

    clock += 1000
    const second = processor.process({
      sessionId: 'sess-2',
      projectScopeId: PROJECT_A.scopeId,
      candidates: [candidate()]
    })
    expect(second).toMatchObject({ candidates: 1, merged: 1, promoted: 1, added: 0 })

    const promoted = repo.findActiveByKey(PROJECT_A, 'workflow', 'build.verify')
    expect(promoted?.id).toBe(rows[0].id)
    expect(promoted).toMatchObject({
      status: 'active',
      evidenceCount: 2,
      distinctSessionCount: 2,
      confidence: 0.65
    })
    expect(repo.listEvidence(promoted!.id)).toHaveLength(2)
    expect(repo.listByScope(PROJECT_A)).toHaveLength(1)
  })

  it('同 session 重复观察只累积证据，不推进计数、不晋升', () => {
    setup()

    processor.process({
      sessionId: 'sess-1',
      projectScopeId: PROJECT_A.scopeId,
      candidates: [candidate()]
    })
    clock += 1000
    const counts = processor.process({
      sessionId: 'sess-1',
      projectScopeId: PROJECT_A.scopeId,
      candidates: [candidate()]
    })
    expect(counts).toMatchObject({ merged: 1, promoted: 0 })

    const row = repo.listByScope(PROJECT_A, { status: 'pending' })[0]
    expect(row).toMatchObject({ evidenceCount: 2, distinctSessionCount: 1, status: 'pending' })
  })

  it('SUPERSEDE 链：旧记录 superseded+validTo，新记录 active+supersedesId，默认检索只见新', () => {
    setup()
    const source = writeWorkspaceFile('package.json', '{"dependencies":{"pg":"latest"}}')

    processor.process({
      sessionId: 'sess-1',
      projectScopeId: PROJECT_A.scopeId,
      workspaceRoot: source.workspaceRoot,
      candidates: [
        candidate({
          kind: 'project_fact',
          memoryKey: 'database.primary',
          content: '项目主数据库为 SQLite',
          explicitness: 'workspace_verified',
          confidence: 0.9,
          evidence: [{ type: 'workspace', excerpt: 'package.json 依赖 better-sqlite3', sourcePath: 'package.json' }]
        })
      ]
    })

    clock += 1000
    const counts = processor.process({
      sessionId: 'sess-1',
      projectScopeId: PROJECT_A.scopeId,
      workspaceRoot: source.workspaceRoot,
      candidates: [
        candidate({
          kind: 'project_fact',
          memoryKey: 'database.primary',
          content: '项目主数据库为 PostgreSQL',
          explicitness: 'workspace_verified',
          confidence: 0.95,
          evidence: [{ type: 'workspace', excerpt: 'package.json 依赖 pg', sourcePath: 'package.json' }]
        })
      ]
    })
    expect(counts).toMatchObject({ superseded: 1 })

    const oldRow = repo.listByScope(PROJECT_A, { status: 'superseded' })[0]
    const newRow = repo.findActiveByKey(PROJECT_A, 'project_fact', 'database.primary')
    expect(oldRow?.validTo).toBe(NOW + 1000)
    expect(newRow?.supersedesId).toBe(oldRow?.id)
    expect(newRow?.sourcePath).toBe('package.json')
    expect(newRow?.sourceFingerprint).toBe(source.fingerprint)

    const activeHits = repo.searchFts('主数据库')
    expect(activeHits.map((h) => h.record.id)).toEqual([newRow?.id])
    const historyHits = repo.searchFts('主数据库', { status: 'any' })
    expect(historyHits).toHaveLength(2)
  })

  it('RETRACT 软删除后默认检索消失；user_explicit 重申新增 active，非明确等价候选不复活', () => {
    setup()

    processor.process({
      sessionId: 'sess-1',
      projectScopeId: PROJECT_A.scopeId,
      candidates: [
        candidate({
          kind: 'convention',
          memoryKey: 'commit.style',
          content: 'commit message 使用 emoji 风格',
          explicitness: 'user_explicit',
          confidence: 0.9,
          evidence: [{ type: 'user_message', excerpt: '以后 commit 都用 emoji' }]
        })
      ]
    })
    const target = repo.findActiveByKey(PROJECT_A, 'convention', 'commit.style')
    expect(target).not.toBeNull()

    clock += 1000
    const retractCounts = processor.process({
      sessionId: 'sess-2',
      projectScopeId: PROJECT_A.scopeId,
      candidates: [
        candidate({
          kind: 'convention',
          memoryKey: 'commit.style',
          content: 'commit message 不再使用 emoji 风格',
          explicitness: 'user_explicit',
          confidence: 0.9,
          intent: 'negate',
          evidence: [{ type: 'user_message', excerpt: '以后 commit 别用 emoji 了' }]
        })
      ]
    })
    expect(retractCounts).toMatchObject({ retracted: 1 })
    expect(repo.findById(target!.id)?.status).toBe('retracted')
    expect(repo.searchFts('commit message')).toEqual([])

    clock += 1000
    const passive = processor.process({
      sessionId: 'sess-3',
      projectScopeId: PROJECT_A.scopeId,
      candidates: [
        candidate({
          kind: 'convention',
          memoryKey: 'commit.style',
          content: 'commit message 使用 emoji 风格',
          explicitness: 'observed',
          confidence: 0.8,
          evidence: [{ type: 'tool_result', excerpt: '最近几次 commit 均带 emoji' }]
        })
      ]
    })
    expect(passive).toMatchObject({ ignored: 1 })
    expect(repo.listByScope(PROJECT_A)).toHaveLength(1)
    expect(repo.findById(target!.id)?.status).toBe('retracted')

    clock += 1000
    const resurrect = processor.process({
      sessionId: 'sess-4',
      projectScopeId: PROJECT_A.scopeId,
      candidates: [
        candidate({
          kind: 'convention',
          memoryKey: 'commit.style',
          content: 'commit message 使用 emoji 风格',
          explicitness: 'user_explicit',
          confidence: 0.95,
          evidence: [{ type: 'user_message', excerpt: '还是继续用 emoji 吧' }]
        })
      ]
    })
    expect(resurrect).toMatchObject({ added: 1 })
    expect(repo.listByScope(PROJECT_A)).toHaveLength(2)
    expect(repo.findById(target!.id)?.status).toBe('retracted')
    const revived = repo.findActiveByKey(PROJECT_A, 'convention', 'commit.style')
    expect(revived?.status).toBe('active')
    expect(revived?.id).not.toBe(target!.id)
  })

  it('scope 纠偏：global 提示的 project_fact 落入当前 project scope', () => {
    setup()

    processor.process({
      sessionId: 'sess-1',
      projectScopeId: PROJECT_A.scopeId,
      candidates: [
        candidate({
          scopeHint: 'global',
          kind: 'project_fact',
          memoryKey: 'repo.url',
          content: '本仓库托管在内部 GitLab',
          explicitness: 'workspace_verified',
          evidence: [{ type: 'workspace', excerpt: 'git remote 显示内部地址' }]
        })
      ]
    })

    expect(repo.listByScope(GLOBAL)).toEqual([])
    const rows = repo.listByScope(PROJECT_A, { status: 'active' })
    expect(rows).toHaveLength(1)
    expect(rows[0].memoryKey).toBe('repo.url')
  })

  it('global observed 跨 project 晋升；证据行保留项目归属', () => {
    setup()

    const globalCandidate = candidate({
      scopeHint: 'global',
      kind: 'preference',
      memoryKey: 'stack.ui',
      content: '用户经常使用 React',
      explicitness: 'observed',
      evidence: [{ type: 'tool_result', excerpt: 'package.json 依赖 react' }]
    })

    processor.process({
      sessionId: 'sess-1',
      projectScopeId: PROJECT_A.scopeId,
      candidates: [globalCandidate]
    })
    const pending = repo.listByScope(GLOBAL, { status: 'pending' })[0]
    expect(pending).toBeDefined()

    clock += 1000
    const counts = processor.process({
      sessionId: 'sess-9',
      projectScopeId: PROJECT_B.scopeId,
      candidates: [globalCandidate]
    })
    expect(counts).toMatchObject({ merged: 1, promoted: 1 })

    const active = repo.findActiveByKey(GLOBAL, 'preference', 'stack.ui')
    expect(active?.id).toBe(pending.id)
    expect(active).toMatchObject({ distinctProjectCount: 2, evidenceCount: 2 })
    const evidence = repo.listEvidence(active!.id)
    expect(evidence.map((e) => e.projectScopeId).sort()).toEqual([
      PROJECT_A.scopeId,
      PROJECT_B.scopeId
    ])
  })

  it('keyless 相似 gotcha 合并为单条记录', () => {
    setup()

    const gotcha = '升级 better-sqlite3 后原生模块编译失败需要 electron-rebuild 重建才能加载'
    processor.process({
      sessionId: 'sess-1',
      projectScopeId: PROJECT_A.scopeId,
      candidates: [
        candidate({
          kind: 'gotcha',
          memoryKey: null,
          content: gotcha,
          explicitness: 'observed',
          confidence: 0.5,
          evidence: [{ type: 'tool_result', excerpt: '构建日志显示编译失败' }]
        })
      ]
    })
    clock += 1000
    const counts = processor.process({
      sessionId: 'sess-2',
      projectScopeId: PROJECT_A.scopeId,
      candidates: [
        candidate({
          kind: 'gotcha',
          memoryKey: null,
          content: `${gotcha}，Windows 下还需删除 build 缓存`,
          explicitness: 'observed',
          confidence: 0.5,
          evidence: [{ type: 'tool_result', excerpt: '删除缓存后构建成功' }]
        })
      ]
    })
    expect(counts).toMatchObject({ merged: 1 })
    const rows = repo.listByScope(PROJECT_A, { kind: 'gotcha' })
    expect(rows).toHaveLength(1)
    expect(rows[0].evidenceCount).toBe(2)
  })

  it('单条候选落库异常 fail-soft：计数失败并继续处理其余候选', () => {
    setup()

    let insertCalls = 0
    const failingRepo: MemoryRepository = new Proxy(repo, {
      get(target, prop, receiver) {
        if (prop === 'insertRecord') {
          return (...args: unknown[]) => {
            insertCalls += 1
            if (insertCalls === 1) {
              throw new Error('db write failed')
            }
            return (target.insertRecord as (...a: unknown[]) => unknown).apply(target, args)
          }
        }
        const value = Reflect.get(target, prop, receiver)
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value
      }
    })
    const failSoftProcessor = new MemoryCandidateProcessor({
      repository: failingRepo,
      now: () => clock,
      generateRecordId: () => `mem_${++idSeq}`
    })

    const counts = failSoftProcessor.process({
      sessionId: 'sess-1',
      projectScopeId: PROJECT_A.scopeId,
      candidates: [
        candidate({ memoryKey: 'k.first' }),
        candidate({ memoryKey: 'k.second', evidence: [{ type: 'tool_result', excerpt: '另一条证据' }] })
      ]
    })
    expect(counts).toMatchObject({ candidates: 2, failed: 1, added: 1 })
    expect(repo.listByScope(PROJECT_A, { kind: 'workflow' })).toHaveLength(1)
  })
})
