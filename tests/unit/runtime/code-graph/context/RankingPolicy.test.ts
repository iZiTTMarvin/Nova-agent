import { describe, expect, it } from 'vitest'
import type {
  CodeGraphAnchorCandidate,
  CodeGraphRelationCandidate
} from '@runtime/code-graph/graph/queries/CodeGraphReader'
import {
  CODE_CONTEXT_QUERY_MAX_CHARS,
  RankingPolicy
} from '@runtime/code-graph'

describe('RankingPolicy', () => {
  const policy = new RankingPolicy()

  it('统一归一化 camel、snake、kebab 与路径片段', () => {
    const normalized = policy.normalizeQuery(
      'getCacheStats cache_stats cache-stats/src/CacheStats.ts'
    )

    expect(normalized.tokens).toEqual([
      'get', 'cache', 'stats', 'getcachestats', 'src', 'cachestats', 'ts'
    ])
    expect(policy.normalizeScope('.\\src\\runtime/')).toBe('src/runtime')
    expect(() => policy.normalizeScope('../outside')).toThrow('工作区内')
    expect(() => policy.normalizeScope('C:\\outside')).toThrow('工作区内')
    expect(policy.normalizeQuery('x'.repeat(CODE_CONTEXT_QUERY_MAX_CHARS)).original)
      .toHaveLength(CODE_CONTEXT_QUERY_MAX_CHARS)
    expect(() => policy.normalizeQuery('x'.repeat(CODE_CONTEXT_QUERY_MAX_CHARS + 1)))
      .toThrow('不得超过')
  })

  it('严格保持 exact symbol、qualified、path、token、FTS 的顺序', () => {
    const query = policy.normalizeQuery('CacheStats')
    const ranked = policy.rankAnchors([
      anchor('fts', { ftsRank: -1 }),
      anchor('token', { identifierTokens: 'cache stats cachestats' }),
      anchor('path', { exactPath: true }),
      anchor('qualified', { exactQualifiedName: true }),
      anchor('name', { exactName: true })
    ], query)

    expect(ranked.map((item) => item.stableId)).toEqual([
      'name', 'qualified', 'path', 'token', 'fts'
    ])
  })

  it('相同分数按 path、line、stable id 确定性打破平局', () => {
    const query = policy.normalizeQuery('service')
    const ranked = policy.rankAnchors([
      anchor('z', { path: 'src/z.ts', startLine: 5, exactName: true }),
      anchor('b', { path: 'src/a.ts', startLine: 5, exactName: true }),
      anchor('a', { path: 'src/a.ts', startLine: 5, exactName: true }),
      anchor('line', { path: 'src/a.ts', startLine: 2, exactName: true })
    ], query)

    expect(ranked.map((item) => item.stableId)).toEqual(['line', 'a', 'b', 'z'])
  })

  it('FTS 候选使用 BM25 相关度参与分数', () => {
    const query = policy.normalizeQuery('service')
    const ranked = policy.rankAnchors([
      anchor('weak', { ftsRank: -0.01 }),
      anchor('strong', { ftsRank: -10 })
    ], query)

    expect(ranked.map((item) => item.stableId)).toEqual(['strong', 'weak'])
    expect(ranked[0]?.score).toBeGreaterThan(ranked[1]?.score ?? 0)
  })

  it('impact 排序优先高置信关系，并显式标记相对方向', () => {
    const selected = [{ ...anchor('target'), score: 1 }]
    const relations: CodeGraphRelationCandidate[] = [
      relation('probable-incoming', {
        targetSymbolStableId: 'target',
        sourceSymbolStableId: 'caller',
        confidence: 'probable'
      }),
      relation('confirmed-outgoing', {
        sourceSymbolStableId: 'target',
        targetSymbolStableId: 'callee',
        confidence: 'confirmed'
      })
    ]

    const ranked = policy.rankRelations(relations, selected, 'impact')
    expect(ranked.map((item) => [item.stableId, item.direction, item.depth])).toEqual([
      ['confirmed-outgoing', 'outgoing', 1],
      ['probable-incoming', 'incoming', 1]
    ])
  })

  it('impact 只扩展一层高置信二跳候选', () => {
    const selected = [{ ...anchor('target'), score: 1 }]
    const ranked = policy.rankRelations([
      relation('direct', {
        sourceSymbolStableId: 'caller',
        targetSymbolStableId: 'target',
        sourceSymbolId: 2,
        targetSymbolId: 1
      }),
      relation('second-hop', {
        sourceSymbolStableId: 'upstream',
        targetSymbolStableId: 'caller',
        sourceSymbolId: 3,
        targetSymbolId: 2
      }),
      relation('third-hop', {
        sourceSymbolStableId: 'root',
        targetSymbolStableId: 'upstream',
        sourceSymbolId: 4,
        targetSymbolId: 3
      })
    ], selected, 'impact')

    expect(ranked.map((item) => [item.stableId, item.depth])).toEqual([
      ['direct', 1],
      ['second-hop', 2]
    ])
  })

  it('只返回高置信关系，且直接证据先于二跳候选', () => {
    const selected = [{ ...anchor('target'), score: 1 }]
    const relations = [
      relation('direct-probable', {
        sourceSymbolStableId: 'caller',
        targetSymbolStableId: 'target',
        confidence: 'probable'
      }),
      relation('direct-heuristic', {
        sourceSymbolStableId: 'guess',
        targetSymbolStableId: 'target',
        confidence: 'heuristic'
      }),
      relation('second-confirmed', {
        sourceSymbolStableId: 'upstream',
        targetSymbolStableId: 'caller',
        confidence: 'confirmed'
      })
    ]

    expect(policy.rankRelations(relations, selected, 'understand').map((item) => item.stableId))
      .toEqual(['direct-probable'])
    expect(policy.rankRelations(relations, selected, 'impact').map((item) => item.stableId))
      .toEqual(['direct-probable', 'second-confirmed'])
  })

  it('关系建议读取范围不超过源文件行数', () => {
    const selected = [{ ...anchor('target'), score: 1 }]
    const ranked = policy.rankRelations([
      relation('near-eof', {
        sourceSymbolStableId: 'caller',
        targetSymbolStableId: 'target',
        sourceLine: 98,
        sourceFileLineCount: 100
      })
    ], selected, 'understand')

    expect(ranked).toHaveLength(1)
    const first = ranked[0]
    if (!first) throw new Error('未生成预期的关系证据')
    expect(policy.relationReadRange(first)).toEqual({
      path: 'src/source.ts',
      startLine: 90,
      endLine: 100
    })
  })
})

function anchor(
  stableId: string,
  overrides: Partial<CodeGraphAnchorCandidate> = {}
): CodeGraphAnchorCandidate {
  return {
    symbolId: 1,
    fileId: 1,
    stableId,
    name: 'Other',
    qualifiedName: 'Other',
    kind: 'class',
    path: `src/${stableId}.ts`,
    startLine: 10,
    endLine: 20,
    fileLineCount: 100,
    identifierTokens: '',
    exactName: false,
    exactQualifiedName: false,
    exactPath: false,
    ftsRank: null,
    ...overrides
  }
}

function relation(
  stableId: string,
  overrides: Partial<CodeGraphRelationCandidate> = {}
): CodeGraphRelationCandidate {
  return {
    stableId,
    graphKind: 'symbol',
    type: 'calls',
    from: 'source',
    to: 'target',
    sourceSymbolStableId: 'source',
    targetSymbolStableId: 'target',
    sourceSymbolId: 1,
    targetSymbolId: 2,
    sourceFileId: 1,
    targetFileId: 2,
    confidence: 'probable',
    resolver: 'relative-path',
    sourceFile: 'src/source.ts',
    sourceLine: 10,
    sourceFileLineCount: 100,
    ...overrides
  }
}
