/**
 * NovaMemEval — Nova 自有记忆评测门禁（真 SQLite / FTS5 / 组合检索全链路）。
 *
 * 正确性门槛：
 * - Recall@5 ≥ 0.90
 * - 默认检索过期记忆率（Stale）= 0
 * - 跨项目泄漏率（Scope Leakage）= 0
 * - 已撤回记忆默认检索率（Retracted）= 0
 * - observed 全局偏好必须有晋升门槛：单项目观察不得直接 active，
 *   pending 不得进入默认检索与 prefetch 注入。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { openBetterSqliteMemoryDb } from '@runtime/memory/BetterSqliteMemoryDb'
import { computeWorkspaceHash, GLOBAL_SCOPE_ID } from '@runtime/memory/MemoryPaths'
import { SqliteMemoryRepository } from '@runtime/memory/repository/SqliteMemoryRepository'
import type { MemoryRepository } from '@runtime/memory/repository/MemoryRepository'
import { MemoryService } from '@runtime/memory/MemoryService'
import { StructuredMemoryRetriever } from '@runtime/memory/retrieval/StructuredMemoryRetriever'
import { DocumentMemoryRetriever } from '@runtime/memory/retrieval/DocumentMemoryRetriever'
import { MemoryRetrievalService } from '@runtime/memory/retrieval/MemoryRetrievalService'
import { MemoryPrefetchService } from '@runtime/memory/retrieval/MemoryPrefetchService'
import { MemoryCandidateProcessor } from '@runtime/memory/policy/MemoryCandidateProcessor'
import type { MemoryCandidate } from '@runtime/memory/types'
import { buildSeedDrafts, EVAL_CASES, EVAL_CATEGORY_COUNTS } from './evalCases'
import { evaluateOutcome, computeMetrics, type EvalCaseOutcome } from './evalHarness'

const FIXED_NOW = 1_782_000_000_000

describe('NovaMemEval（确定性评测门禁）', () => {
  let tempDir: string
  let db: ReturnType<typeof openBetterSqliteMemoryDb>
  let repo: MemoryRepository
  let service: MemoryService
  let retrieval: MemoryRetrievalService
  let prefetch: MemoryPrefetchService
  let scopeA: string
  let scopeB: string
  let outcomes: EvalCaseOutcome[]
  let injectedChars: number[]

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'nova-memeval-'))
    const wsA = join(tempDir, 'ws-a')
    const wsB = join(tempDir, 'ws-b')
    mkdirSync(wsA, { recursive: true })
    mkdirSync(wsB, { recursive: true })
    const memoryRoot = join(tempDir, 'memory')
    mkdirSync(memoryRoot, { recursive: true })
    db = openBetterSqliteMemoryDb(join(memoryRoot, 'memory.db'))
    repo = new SqliteMemoryRepository(db, { now: () => FIXED_NOW })
    service = new MemoryService(memoryRoot, db, { reconcileOnSearch: false })
    scopeA = computeWorkspaceHash(wsA)
    scopeB = computeWorkspaceHash(wsB)

    for (const draft of buildSeedDrafts({ projectA: scopeA, projectB: scopeB, global: GLOBAL_SCOPE_ID })) {
      repo.insertRecord(draft)
    }

    retrieval = new MemoryRetrievalService({
      structuredRetriever: new StructuredMemoryRetriever(repo),
      documentRetriever: new DocumentMemoryRetriever(service),
      now: () => FIXED_NOW
    })
    prefetch = new MemoryPrefetchService(retrieval)
  })

  afterAll(() => {
    service.close()
    db.close()
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('数据集规模满足最低覆盖（≥60 用例，各类别齐全）', () => {
    expect(EVAL_CASES.length).toBeGreaterThanOrEqual(60)
    expect(EVAL_CATEGORY_COUNTS['global-explicit-preference']).toBeGreaterThanOrEqual(10)
    expect(EVAL_CATEGORY_COUNTS['global-observed-preference']).toBeGreaterThanOrEqual(8)
    expect(EVAL_CATEGORY_COUNTS['project-decision-convention']).toBeGreaterThanOrEqual(10)
    expect(EVAL_CATEGORY_COUNTS['gotcha-workflow']).toBeGreaterThanOrEqual(10)
    expect(EVAL_CATEGORY_COUNTS['conflict-supersede-retract']).toBeGreaterThanOrEqual(10)
    expect(EVAL_CATEGORY_COUNTS['project-scope-isolation']).toBeGreaterThanOrEqual(6)
    expect(EVAL_CATEGORY_COUNTS['irrelevant-abstention']).toBeGreaterThanOrEqual(6)
    expect(EVAL_CATEGORY_COUNTS['history-query']).toBeGreaterThanOrEqual(4)
  })

  it('全部用例：命中与禁用断言（含逐用例诊断输出）', async () => {
    outcomes = []
    for (const evalCase of EVAL_CASES) {
      const scopeId = evalCase.perspective === 'project-b' ? scopeB : scopeA
      const started = performance.now()
      const results = await retrieval.search({
        query: evalCase.query,
        projectScopeId: scopeId,
        history: evalCase.history ?? false,
        limit: 5
      })
      const durationMs = performance.now() - started
      const outcome = evaluateOutcome(evalCase, results.map((r) => r.id), durationMs)
      outcomes.push(outcome)

      const missing = evalCase.expectedMemoryIds.filter((id) => !outcome.returnedIds.includes(id))
      expect(
        missing,
        `用例 ${evalCase.id}（${evalCase.category}）query="${evalCase.query}" 期望 ${evalCase.expectedMemoryIds.join(',')} 但 top5=${outcome.returnedIds.join(',')}`
      ).toEqual([])
      expect(
        outcome.forbiddenLeak,
        `用例 ${evalCase.id} 出现禁止记忆：${outcome.forbiddenLeak.join(',')}`
      ).toEqual([])
    }
  })

  it('指标门槛：Recall@5 ≥ 0.90，Stale/ScopeLeak/Retracted = 0', () => {
    const metrics = computeMetrics(outcomes, EVAL_CASES)
    // eslint-disable-next-line no-console
    console.info(
      `[NovaMemEval] cases=${metrics.caseCount} R@1=${metrics.recallAt1.toFixed(2)} R@5=${metrics.recallAt5.toFixed(2)} ` +
      `MRR=${metrics.mrr.toFixed(2)} stale=${metrics.staleRate} leak=${metrics.scopeLeakageRate} ` +
      `retracted=${metrics.retractedLeakRate} abstainP=${metrics.abstentionPrecision.toFixed(2)} ` +
      `latency(p50/p95/p99)=${metrics.latency.p50.toFixed(1)}/${metrics.latency.p95.toFixed(1)}/${metrics.latency.p99.toFixed(1)}ms`
    )
    expect(metrics.recallAt5).toBeGreaterThanOrEqual(0.9)
    expect(metrics.staleRate).toBe(0)
    expect(metrics.scopeLeakageRate).toBe(0)
    expect(metrics.retractedLeakRate).toBe(0)
  })

  it('prefetch 注入块：预算内、无命中为 null、平均注入字符有观测值', async () => {
    injectedChars = []
    for (const evalCase of EVAL_CASES) {
      if (evalCase.expectedBehavior === 'abstention') {
        const block = await prefetch.buildInjectionBlock({
          query: evalCase.query,
          projectScopeId: scopeA,
          workspaceRoot: join(tempDir, 'ws-a')
        })
        expect(block, `无关查询 ${evalCase.id} 不应注入记忆块`).toBeNull()
        continue
      }
      const block = await prefetch.buildInjectionBlock({
        query: evalCase.query,
        projectScopeId: scopeA,
        workspaceRoot: join(tempDir, 'ws-a')
      })
      if (block !== null) {
        expect(block.length).toBeLessThanOrEqual(2400)
        injectedChars.push(block.length)
      }
    }
    // eslint-disable-next-line no-console
    console.info(
      `[NovaMemEval] prefetch 平均注入 ${injectedChars.length ? Math.round(injectedChars.reduce((a, b) => a + b, 0) / injectedChars.length) : 0} 字符（${injectedChars.length}/${EVAL_CASES.length} 用例注入）`
    )
    expect(injectedChars.length).toBeGreaterThan(0)
  })

  it('observed 全局偏好晋升门槛：单项目观察 → pending 且不进默认检索；跨两项目 → active', async () => {
    const candidate = (projectScopeId: string): MemoryCandidate => ({
      kind: 'preference',
      scopeHint: 'global',
      memoryKey: 'editor.habit',
      content: '用户经常使用 Neovim 编辑器写代码',
      explicitness: 'observed',
      confidence: 0.75,
      intent: 'assert',
      evidence: [{ type: 'tool_result', excerpt: '工具输出显示 Neovim 为默认编辑器', sessionId: `sess-${projectScopeId}`, sourcePath: undefined }]
    })

    let clock = FIXED_NOW
    let seq = 0
    const processor = new MemoryCandidateProcessor({
      repository: repo,
      now: () => clock,
      generateRecordId: () => `mem_promo_${++seq}`
    })

    const first = processor.process({ sessionId: 'sess-1', projectScopeId: scopeA, candidates: [candidate(scopeA)] })
    expect(first.added).toBe(1)
    const afterFirst = repo.listByScope(
      { scopeKind: 'global', scopeId: GLOBAL_SCOPE_ID },
      { limit: 500 }
    ).find((r) => r.memoryKey === 'editor.habit')
    expect(afterFirst?.status).toBe('pending')

    // pending 不进入默认检索与 prefetch
    const defaultHits = await retrieval.search({ query: '编辑器习惯用什么', projectScopeId: scopeA, limit: 5 })
    expect(defaultHits.map((r) => r.id)).not.toContain(afterFirst!.id)
    const block = await prefetch.buildInjectionBlock({ query: '编辑器习惯用什么', projectScopeId: scopeA })
    expect(block === null || !block.includes('Neovim')).toBe(true)

    // 第二个不同项目的观察触发晋升
    clock += 60_000
    const second = processor.process({ sessionId: 'sess-2', projectScopeId: scopeB, candidates: [candidate(scopeB)] })
    expect(second.merged).toBe(1)
    expect(second.promoted).toBe(1)
    const afterSecond = repo.findById(afterFirst!.id)
    expect(afterSecond?.status).toBe('active')

    // 晋升后进入默认检索，且以 advisory 身份出现
    const promotedHits = await retrieval.search({ query: '编辑器习惯用什么', projectScopeId: scopeA, limit: 5 })
    const promoted = promotedHits.find((r) => r.id === afterFirst!.id)
    expect(promoted).toBeDefined()
    expect(promoted!.advisory).toBe(true)
  })
})
