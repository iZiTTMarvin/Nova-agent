/**
 * 确定性 rerank 纯函数测试：各排序因子、稳定性与多样性去重。
 * 保护契约：scope 分档顺序、stable 类型不因陈旧降权、同输入同序、同 (group,kind,key) 只保最高分。
 */
import { describe, it, expect } from 'vitest'
import {
  freshnessScore,
  kindRelevanceScore,
  rankMemoryResults,
  scopeTierOf
} from '../../../../../src/runtime/memory/retrieval/memoryRanking'
import type { ScoredMemoryResult, StructuredMemoryResult } from '../../../../../src/runtime/memory/retrieval/MemoryRetriever'

const NOW = 1_780_000_000_000

function structured(overrides: Partial<StructuredMemoryResult> = {}): ScoredMemoryResult {
  return {
    id: 'mem_x',
    group: 'structured-project',
    kind: 'decision',
    content: '内容',
    status: 'active',
    explicitness: 'workspace_verified',
    confidence: 0.8,
    memoryKey: null,
    lastSeenAt: NOW,
    advisory: false,
    historicalNote: null,
    source: null,
    lexicalScore: 1,
    ...overrides
  }
}

function document(overrides: Partial<Extract<ScoredMemoryResult, { group: 'document' }>> = {}): ScoredMemoryResult {
  return {
    id: 'MEMORY.md',
    group: 'document',
    kind: 'document',
    relPath: 'MEMORY.md',
    body: '正文',
    advisory: false,
    historicalNote: null,
    lexicalScore: 1,
    ...overrides
  }
}

describe('scope 分档', () => {
  it('project structured > manual doc > global explicit > global observed > episodic', () => {
    const projectFact = structured({ id: 'a-project', group: 'structured-project' })
    const manualDoc = document({ id: 'b-doc' })
    const globalExplicit = structured({
      id: 'c-global-explicit',
      group: 'structured-global',
      explicitness: 'user_explicit'
    })
    const globalObserved = structured({
      id: 'd-global-observed',
      group: 'structured-global',
      explicitness: 'observed'
    })
    const episodic = document({ id: 'e-episodic', relPath: 'episodic/summary.md' })

    expect(scopeTierOf(projectFact)).toBeGreaterThan(scopeTierOf(manualDoc))
    expect(scopeTierOf(manualDoc)).toBeGreaterThan(scopeTierOf(globalExplicit))
    expect(scopeTierOf(globalExplicit)).toBeGreaterThan(scopeTierOf(globalObserved))
    expect(scopeTierOf(globalObserved)).toBeGreaterThan(scopeTierOf(episodic))

    const ranked = rankMemoryResults(
      [episodic, globalObserved, globalExplicit, manualDoc, projectFact],
      '查询',
      NOW
    )
    expect(ranked.map((r) => r.id)).toEqual(['a-project', 'b-doc', 'c-global-explicit', 'd-global-observed', 'e-episodic'])
  })
})

describe('lexical 因子', () => {
  it('同档位下 lexical 高者在前', () => {
    const ranked = rankMemoryResults(
      [structured({ id: 'low', lexicalScore: 0.2 }), structured({ id: 'high', lexicalScore: 1 })],
      '查询',
      NOW
    )
    expect(ranked.map((r) => r.id)).toEqual(['high', 'low'])
  })
})

describe('freshness 因子', () => {
  it('project_fact 按 lastSeenAt 衰减；preference 陈旧不降权', () => {
    const halfLifeMs = 90 * 86_400_000
    const oldFact = structured({ id: 'old-fact', kind: 'project_fact', lastSeenAt: NOW - halfLifeMs })
    const freshFact = structured({ id: 'fresh-fact', kind: 'project_fact', lastSeenAt: NOW })
    const oldPreference = structured({ id: 'old-pref', kind: 'preference', lastSeenAt: NOW - halfLifeMs * 10 })
    const freshPreference = structured({ id: 'fresh-pref', kind: 'preference', lastSeenAt: NOW })

    expect(freshnessScore(oldFact, NOW)).toBeLessThan(freshnessScore(freshFact, NOW))
    expect(freshnessScore(oldFact, NOW)).toBeGreaterThan(0)
    expect(freshnessScore(oldPreference, NOW)).toBe(1)
    expect(freshnessScore(freshPreference, NOW)).toBe(1)

    const ranked = rankMemoryResults([oldFact, freshFact], '查询', NOW)
    expect(ranked.map((r) => r.id)).toEqual(['fresh-fact', 'old-fact'])

    // 偏好不因陈旧降权：两条 preference 同分，按 id 稳定排序
    const prefs = rankMemoryResults([oldPreference, freshPreference], '查询', NOW)
    expect(prefs.map((r) => r.id)).toEqual(['fresh-pref', 'old-pref'])
  })
})

describe('kind 相关性词典', () => {
  it('查询命中 kind 词典得高分，未命中中性', () => {
    expect(kindRelevanceScore('为什么选这个数据库', 'decision')).toBe(1)
    expect(kindRelevanceScore('上次踩过什么坑', 'gotcha')).toBe(1)
    expect(kindRelevanceScore('用户偏好', 'preference')).toBe(1)
    expect(kindRelevanceScore('无关查询', 'decision')).toBe(0.5)
    expect(kindRelevanceScore('任意查询', 'document')).toBe(0.5)

    const decision = structured({ id: 'dec', kind: 'decision', lexicalScore: 1 })
    const gotcha = structured({ id: 'got', kind: 'gotcha', lexicalScore: 1 })
    const ranked = rankMemoryResults([gotcha, decision], '之前踩过什么坑', NOW)
    expect(ranked.map((r) => r.id)).toEqual(['got', 'dec'])
  })
})

describe('多样性去重', () => {
  it('同 (group, kind, key) 只保最高分；keyless 与文档不去重', () => {
    const ranked = rankMemoryResults(
      [
        structured({ id: 'dup-weak', memoryKey: 'db.primary', lexicalScore: 0.3 }),
        structured({ id: 'dup-strong', memoryKey: 'db.primary', lexicalScore: 1 }),
        structured({ id: 'keyless-a', memoryKey: null, lexicalScore: 0.9 }),
        structured({ id: 'keyless-b', memoryKey: null, lexicalScore: 0.8 }),
        document({ id: 'MEMORY.md' })
      ],
      '查询',
      NOW
    )
    expect(ranked.map((r) => r.id)).toEqual(['dup-strong', 'keyless-a', 'MEMORY.md', 'keyless-b'])
  })

  it('历史记录与其同 key 继任者共存（追溯链不被去重折叠）', () => {
    const ranked = rankMemoryResults(
      [
        structured({
          id: 'mem-old',
          memoryKey: 'db.primary',
          status: 'superseded',
          historicalNote: 'superseded',
          lexicalScore: 1
        }),
        structured({ id: 'mem-new', memoryKey: 'db.primary', status: 'active', lexicalScore: 0.8 })
      ],
      '查询',
      NOW
    )
    expect(ranked.map((r) => r.id).sort()).toEqual(['mem-new', 'mem-old'])
  })

  it('不同 scope 的同 key 记录都保留', () => {
    const ranked = rankMemoryResults(
      [
        structured({ id: 'g', group: 'structured-global', memoryKey: 'style', lexicalScore: 0.9 }),
        structured({ id: 'p', group: 'structured-project', memoryKey: 'style', lexicalScore: 1 })
      ],
      '查询',
      NOW
    )
    expect(ranked).toHaveLength(2)
  })
})

describe('确定性', () => {
  it('同输入同序；平分按 id 升序兜底', () => {
    const input = [
      structured({ id: 'z', lexicalScore: 0.5 }),
      structured({ id: 'a', lexicalScore: 0.5 }),
      structured({ id: 'm', lexicalScore: 0.7 })
    ]
    const first = rankMemoryResults(input, '查询', NOW).map((r) => r.id)
    const second = rankMemoryResults(input, '查询', NOW).map((r) => r.id)
    expect(first).toEqual(['m', 'a', 'z'])
    expect(first).toEqual(second)
  })
})
