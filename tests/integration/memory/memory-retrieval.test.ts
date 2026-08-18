/**
 * 检索层集成测试（better-sqlite3 @ Node ABI）：
 * scope 隔离、supersede/retracted/needs_verification 的默认与 history 行为、
 * 结构化+文档混合检索、中文召回、source 懒校验与 prefetch 注入块构建。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, statSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { openBetterSqliteMemoryDb } from '@runtime/memory/BetterSqliteMemoryDb'
import { computeWorkspaceHash } from '@runtime/memory/MemoryPaths'
import { SqliteMemoryRepository } from '@runtime/memory/repository/SqliteMemoryRepository'
import type { MemoryRecordDraft, MemoryRepository } from '@runtime/memory/repository/MemoryRepository'
import { MemoryService } from '@runtime/memory/MemoryService'
import { computeFingerprint } from '@runtime/memory/FtsQueryBuilder'
import { StructuredMemoryRetriever } from '@runtime/memory/retrieval/StructuredMemoryRetriever'
import { DocumentMemoryRetriever } from '@runtime/memory/retrieval/DocumentMemoryRetriever'
import { MemoryRetrievalService } from '@runtime/memory/retrieval/MemoryRetrievalService'
import { MemoryPrefetchService } from '@runtime/memory/retrieval/MemoryPrefetchService'
import { MemoryVerifier } from '@runtime/memory/lifecycle/MemoryVerifier'

describe('检索层（MemoryRetrievalService + 真 SQLite）', () => {
  let tempDir: string | null = null
  let db: ReturnType<typeof openBetterSqliteMemoryDb> | null = null
  let repo: MemoryRepository
  let service: MemoryService | null = null
  let retrieval: MemoryRetrievalService
  let prefetch: MemoryPrefetchService
  let workspaceA: string
  let workspaceB: string
  let scopeA: string
  let scopeB: string

  const NOW = 1_780_000_000_000
  let clock = NOW
  let idSeq = 0

  afterEach(() => {
    service?.close()
    service = null
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
    tempDir = mkdtempSync(join(tmpdir(), 'nova-mem-retrieval-'))
    workspaceA = join(tempDir, 'ws-a')
    workspaceB = join(tempDir, 'ws-b')
    mkdirSync(workspaceA, { recursive: true })
    mkdirSync(workspaceB, { recursive: true })
    const memoryRoot = join(tempDir, 'memory')
    mkdirSync(memoryRoot, { recursive: true })
    db = openBetterSqliteMemoryDb(join(memoryRoot, 'memory.db'))
    repo = new SqliteMemoryRepository(db, {
      now: () => clock,
      generateId: () => `ev_${++idSeq}`
    })
    service = new MemoryService(memoryRoot, db, { reconcileOnSearch: false })
    retrieval = new MemoryRetrievalService({
      structuredRetriever: new StructuredMemoryRetriever(repo),
      documentRetriever: new DocumentMemoryRetriever(service),
      verifier: new MemoryVerifier({ repository: repo })
    })
    prefetch = new MemoryPrefetchService(retrieval)
    scopeA = computeWorkspaceHash(workspaceA)
    scopeB = computeWorkspaceHash(workspaceB)
  }

  const GLOBAL = { scopeKind: 'global' as const, scopeId: 'user' }

  function draft(overrides: Partial<MemoryRecordDraft> = {}): MemoryRecordDraft {
    return {
      id: 'mem_1',
      scope: { scopeKind: 'project', scopeId: scopeA },
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

  it('scope 隔离：project A 记录不进 project B 检索；global 两边都出现', async () => {
    setup()
    repo.insertRecord(
      draft({ id: 'mem_a', memoryKey: 'commit.style', content: '本项目 commit 使用 emoji 风格' })
    )
    repo.insertRecord(
      draft({
        id: 'mem_b',
        scope: { scopeKind: 'project', scopeId: scopeB },
        memoryKey: 'commit.style',
        content: '本项目 commit 使用 conventional 风格'
      })
    )
    repo.insertRecord(
      draft({
        id: 'mem_g',
        scope: GLOBAL,
        kind: 'preference',
        memoryKey: 'comment.language',
        content: '用户偏好 commit 使用中文书写',
        explicitness: 'user_explicit'
      })
    )

    const fromA = await retrieval.search({ query: 'commit 使用', projectScopeId: scopeA })
    const fromB = await retrieval.search({ query: 'commit 使用', projectScopeId: scopeB })
    const idsA = fromA.map((r) => r.id)
    const idsB = fromB.map((r) => r.id)

    expect(idsA).toContain('mem_a')
    expect(idsA).toContain('mem_g')
    expect(idsA).not.toContain('mem_b')
    expect(idsB).toContain('mem_b')
    expect(idsB).toContain('mem_g')
    expect(idsB).not.toContain('mem_a')
    expect(fromA.find((r) => r.id === 'mem_g')?.group).toBe('structured-global')
    expect(fromA.find((r) => r.id === 'mem_a')?.group).toBe('structured-project')
  })

  it('supersede 链：默认只回新记录；history 回新旧并标注', async () => {
    setup()
    repo.insertRecord(draft({ id: 'mem_old', content: '项目主数据库为 SQLite' }))
    clock += 1000
    repo.insertRecord(
      draft({ id: 'mem_new', content: '项目主数据库为 PostgreSQL', supersedesId: 'mem_old' })
    )
    repo.markSuperseded('mem_old', 'mem_new')

    const byDefault = await retrieval.search({ query: '主数据库', projectScopeId: scopeA })
    expect(byDefault.map((r) => r.id)).toEqual(['mem_new'])

    const withHistory = await retrieval.search({ query: '主数据库', projectScopeId: scopeA, history: true })
    const ids = withHistory.map((r) => r.id).sort()
    expect(ids).toEqual(['mem_new', 'mem_old'])
    expect(withHistory.find((r) => r.id === 'mem_old')?.historicalNote).toBe('superseded')
    expect(withHistory.find((r) => r.id === 'mem_new')?.historicalNote).toBeNull()
  })

  it('retracted：默认不返回；history 可追溯返回并明确标注（撤回可审计）', async () => {
    setup()
    repo.insertRecord(
      draft({ id: 'mem_retract', memoryKey: 'editor.font', content: '用户曾要求使用大字号字体' })
    )
    repo.retract('mem_retract')

    const byDefault = await retrieval.search({ query: '使用大字号', projectScopeId: scopeA })
    expect(byDefault.map((r) => r.id)).not.toContain('mem_retract')

    const withHistory = await retrieval.search({ query: '使用大字号', projectScopeId: scopeA, history: true })
    const retracted = withHistory.find((r) => r.id === 'mem_retract')
    expect(retracted).toBeDefined()
    expect(retracted?.historicalNote).toBe('retracted')
  })

  it('pending 任何模式都不外显；needs_verification 默认排除、history 带核对标注', async () => {
    setup()
    repo.insertRecord(
      draft({
        id: 'mem_pending',
        status: 'pending',
        memoryKey: 'tool.chain',
        content: '构建工具疑似使用 vite'
      })
    )
    repo.insertRecord(
      draft({
        id: 'mem_nv',
        status: 'needs_verification',
        memoryKey: 'lint.style',
        content: 'lint 配置疑似使用 eslint'
      })
    )

    const byDefault = await retrieval.search({ query: '疑似使用', projectScopeId: scopeA })
    expect(byDefault.map((r) => r.id)).toEqual([])

    const withHistory = await retrieval.search({ query: '疑似使用', projectScopeId: scopeA, history: true })
    const ids = withHistory.map((r) => r.id)
    expect(ids).not.toContain('mem_pending')
    expect(ids).toContain('mem_nv')
    expect(withHistory.find((r) => r.id === 'mem_nv')?.historicalNote).toBe('needs-verification')
  })

  it('结构化与文档混合检索：MEMORY.md 与结构化记录同回并分组', async () => {
    setup()
    service!.upsertMarkdown(scopeA, 'MEMORY.md', '# 项目记忆\n部署一律使用 pnpm，禁止使用 npm。')
    repo.insertRecord(
      draft({ id: 'mem_pnpm', kind: 'convention', memoryKey: 'pkg.manager', content: '包管理器使用 pnpm' })
    )

    const results = await retrieval.search({ query: 'pnpm', projectScopeId: scopeA })
    const ids = results.map((r) => r.id)
    expect(ids).toContain('mem_pnpm')
    expect(ids).toContain('MEMORY.md')
    expect(results.find((r) => r.id === 'MEMORY.md')?.group).toBe('document')
    expect(results.find((r) => r.id === 'mem_pnpm')?.group).toBe('structured-project')
  })

  it('中文查询召回中文内容（trigram）', async () => {
    setup()
    repo.insertRecord(
      draft({
        id: 'mem_cjk',
        kind: 'gotcha',
        memoryKey: null,
        content: '跨会话记忆需要中文子串召回能力'
      })
    )
    const results = await retrieval.search({ query: '中文子串', projectScopeId: scopeA })
    expect(results.map((r) => r.id)).toContain('mem_cjk')
  })

  it('source 懒校验：指纹一致放行；来源变化/缺失 → 剔除并标记 needs_verification', async () => {
    setup()
    const pkgPath = join(workspaceA, 'package.json')
    writeFileSync(pkgPath, '{"name":"a","dependencies":{}}', 'utf8')
    const stat = statSync(pkgPath)
    const fingerprint = computeFingerprint(stat.size, Math.floor(stat.mtimeMs))

    repo.insertRecord(
      draft({
        id: 'mem_src',
        kind: 'project_fact',
        memoryKey: 'pkg.manager',
        content: 'package.json 声明包管理器为 pnpm',
        sourcePath: 'package.json',
        sourceFingerprint: fingerprint
      })
    )
    repo.insertRecord(
      draft({
        id: 'mem_gone',
        kind: 'project_fact',
        memoryKey: 'config.build',
        content: '构建入口声明在 build.config.js 与 package.json',
        sourcePath: 'build.config.js',
        sourceFingerprint: '1-1'
      })
    )

    const first = await retrieval.search({
      query: 'package.json',
      projectScopeId: scopeA,
      workspaceRoot: workspaceA
    })
    expect(first.map((r) => r.id)).toContain('mem_src')
    expect(first.map((r) => r.id)).not.toContain('mem_gone')
    expect(repo.findById('mem_gone')?.status).toBe('needs_verification')

    // 来源内容变化（size 变了）→ 指纹失效，默认检索剔除
    writeFileSync(pkgPath, '{"name":"a","dependencies":{},"packageManager":"pnpm@9"}', 'utf8')
    const second = await retrieval.search({
      query: 'package.json',
      projectScopeId: scopeA,
      workspaceRoot: workspaceA
    })
    expect(second.map((r) => r.id)).not.toContain('mem_src')
    expect(repo.findById('mem_src')?.status).toBe('needs_verification')
  })

  it('history 检索不触发懒校验（追溯查询不做失效淘汰）', async () => {
    setup()
    writeFileSync(join(workspaceA, 'package.json'), '{"name":"a"}', 'utf8')
    repo.insertRecord(
      draft({
        id: 'mem_hist_src',
        kind: 'project_fact',
        memoryKey: 'pkg.name',
        content: 'package.json 名称为 a',
        sourcePath: 'package.json',
        sourceFingerprint: 'stale-fingerprint'
      })
    )

    const withHistory = await retrieval.search({
      query: 'package.json',
      projectScopeId: scopeA,
      workspaceRoot: workspaceA,
      history: true
    })
    expect(withHistory.map((r) => r.id)).toContain('mem_hist_src')
    expect(repo.findById('mem_hist_src')?.status).toBe('active')
  })

  it('prefetch：真实数据构建注入块，含 Project/User 分组与 Rules 三行', async () => {
    setup()
    service!.upsertMarkdown(scopeA, 'MEMORY.md', '# 项目记忆\n部署一律使用 pnpm。')
    repo.insertRecord(
      draft({ id: 'mem_conv', kind: 'convention', memoryKey: 'pkg.manager', content: '包管理器使用 pnpm' })
    )
    repo.insertRecord(
      draft({
        id: 'mem_pref',
        scope: GLOBAL,
        kind: 'preference',
        memoryKey: 'answer.language',
        content: '用户偏好使用 pnpm 管理依赖',
        explicitness: 'observed'
      })
    )

    const block = await prefetch.buildInjectionBlock({
      query: 'pnpm',
      projectScopeId: scopeA,
      workspaceRoot: workspaceA
    })
    expect(block).not.toBeNull()
    expect(block!.startsWith('=== Relevant Memory ===')).toBe(true)
    expect(block!).toContain('[convention] 包管理器使用 pnpm')
    expect(block!).toContain('[observed preference, advisory] 用户偏好使用 pnpm 管理依赖')
    expect(block!).toContain('Rules:\n- Treat memory as historical evidence.')

    const empty = await prefetch.buildInjectionBlock({
      query: '完全不相关的查询词组',
      projectScopeId: scopeB,
      workspaceRoot: workspaceB
    })
    expect(empty).toBeNull()
  })

  it('两路检索全部失败时上抛（供工具层给出可理解错误）', async () => {
    setup()
    repo.insertRecord(draft({ id: 'mem_any', content: '任意内容用于失败路径' }))
    db!.close()
    db = null
    service = null
    await expect(retrieval.search({ query: '任意内容', projectScopeId: scopeA })).rejects.toThrow()
  })
})
