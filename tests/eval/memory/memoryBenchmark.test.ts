/**
 * 结构化记忆检索性能基准：10,000 条记录 + 200 次查询（真 SQLite / FTS5）。
 * 只测检索热路径（不含落库）；预热 20 次后计时。
 * 目标：warm P95 ≤ 100ms；CI 宽松硬顶 200ms（机器差异容忍）。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { openBetterSqliteMemoryDb } from '@runtime/memory/BetterSqliteMemoryDb'
import { computeWorkspaceHash } from '@runtime/memory/MemoryPaths'
import { SqliteMemoryRepository } from '@runtime/memory/repository/SqliteMemoryRepository'
import type { MemoryRecordDraft } from '@runtime/memory/repository/MemoryRepository'
import { MemoryService } from '@runtime/memory/MemoryService'
import { StructuredMemoryRetriever } from '@runtime/memory/retrieval/StructuredMemoryRetriever'
import { DocumentMemoryRetriever } from '@runtime/memory/retrieval/DocumentMemoryRetriever'
import { MemoryRetrievalService } from '@runtime/memory/retrieval/MemoryRetrievalService'
import { percentile } from './evalHarness'

const RECORD_COUNT = 10_000
const QUERY_COUNT = 200
const WARMUP_COUNT = 20
const CI_P95_CEILING_MS = 200
const FIXED_NOW = 1_782_000_000_000

const DOMAINS = [
  '数据库连接池配置', '登录鉴权流程', '支付回调处理', '消息队列消费', '缓存失效策略',
  '文件上传校验', '定时任务调度', '配置热更新', '日志采样收集', '接口限流实现'
] as const

const ASPECTS = ['踩坑记录', '设计决策', '编码约定', '运维流程', '故障复盘'] as const

function buildContent(index: number): string {
  const domain = DOMAINS[index % DOMAINS.length]
  const aspect = ASPECTS[Math.floor(index / DOMAINS.length) % ASPECTS.length]
  return `${domain}的${aspect}：第 ${index} 号条目，涉及模块 mod-${Math.floor(index / 7)} 与批次 batch-${Math.floor(index / 13)}`
}

describe('记忆检索性能基准（10k 记录 / 200 查询）', () => {
  let tempDir: string
  let db: ReturnType<typeof openBetterSqliteMemoryDb>
  let service: MemoryService
  let retrieval: MemoryRetrievalService
  let scopeA: string
  const queries: string[] = []

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'nova-membench-'))
    const wsA = join(tempDir, 'ws-a')
    mkdirSync(wsA, { recursive: true })
    const memoryRoot = join(tempDir, 'memory')
    mkdirSync(memoryRoot, { recursive: true })
    db = openBetterSqliteMemoryDb(join(memoryRoot, 'memory.db'))
    const repo = new SqliteMemoryRepository(db, { now: () => FIXED_NOW })
    service = new MemoryService(memoryRoot, db, { reconcileOnSearch: false })
    scopeA = computeWorkspaceHash(wsA)

    const drafts: MemoryRecordDraft[] = []
    for (let i = 0; i < RECORD_COUNT; i += 1) {
      drafts.push({
        id: `bench_${i}`,
        scope: { scopeKind: 'project', scopeId: scopeA },
        kind: (['gotcha', 'decision', 'convention', 'workflow', 'project_fact'] as const)[i % 5],
        memoryKey: `bench.key.${i}`,
        content: buildContent(i),
        status: i % 50 === 0 ? 'superseded' : 'active',
        confidence: 0.5 + ((i % 10) / 20),
        explicitness: (['workspace_verified', 'observed', 'user_explicit'] as const)[i % 3],
        sourceType: 'workspace',
        supersedesId: null,
        evidence: [{ evidenceType: 'workspace', excerpt: '基准种子' }]
      })
    }
    for (const draft of drafts) {
      repo.insertRecord(draft)
    }

    retrieval = new MemoryRetrievalService({
      structuredRetriever: new StructuredMemoryRetriever(repo),
      documentRetriever: new DocumentMemoryRetriever(service),
      now: () => FIXED_NOW
    })

    // 查询集：领域词 + 模块编号混合，覆盖高频与低频命中形态
    for (let i = 0; i < QUERY_COUNT; i += 1) {
      const domain = DOMAINS[i % DOMAINS.length]
      if (i % 3 === 0) {
        queries.push(`${domain}怎么处理`)
      } else if (i % 3 === 1) {
        queries.push(`mod-${Math.floor((i * 31) % 1400)} 模块问题`)
      } else {
        queries.push(`${domain}的${ASPECTS[i % ASPECTS.length]}`)
      }
    }
  }, 240_000)

  afterAll(() => {
    service.close()
    db.close()
    rmSync(tempDir, { recursive: true, force: true })
  })

  it(`warm 查询 P95 ≤ ${CI_P95_CEILING_MS}ms（目标 100ms）且结果遵守 limit`, async () => {
    for (let i = 0; i < WARMUP_COUNT; i += 1) {
      await retrieval.search({ query: queries[i % queries.length], projectScopeId: scopeA, limit: 10 })
    }

    const durations: number[] = []
    for (const query of queries) {
      const started = performance.now()
      const results = await retrieval.search({ query, projectScopeId: scopeA, limit: 10 })
      durations.push(performance.now() - started)
      expect(results.length).toBeLessThanOrEqual(10)
    }

    durations.sort((a, b) => a - b)
    const p50 = percentile(durations, 0.5)
    const p95 = percentile(durations, 0.95)
    const p99 = percentile(durations, 0.99)
    // eslint-disable-next-line no-console
    console.info(
      `[NovaMemBench] records=${RECORD_COUNT} queries=${QUERY_COUNT} ` +
      `P50=${p50.toFixed(1)}ms P95=${p95.toFixed(1)}ms P99=${p99.toFixed(1)}ms max=${durations.at(-1)!.toFixed(1)}ms`
    )
    expect(p95).toBeLessThanOrEqual(CI_P95_CEILING_MS)
  }, 240_000)
})
