import { describe, expect, it } from 'vitest'
import { applyScoreFloor, computeOverFetchLimit, sanitizeTrigramQuery } from '@runtime/memory/FtsQueryBuilder'
import { buildMemoryIndexQuery } from '@runtime/memory/index/indexTerms'

describe('memory search query and result bounds', () => {
  it('uses quoted terms/bigrams and keeps complete identifiers on the literal route', () => {
    const query = buildMemoryIndexQuery('PR 标题格式约定怎么写? NODE_MODULE_VERSION')
    expect(query.terms).toContain('"标题"')
    expect(query.terms).not.toContain('"标"')
    expect(query.literal).toContain('"node_module_version"')
    expect(query.terms).not.toContain('?')
    expect(buildMemoryIndexQuery('中文')).toEqual({ terms: '"中文"', literal: null })
  })
  it('keeps snippet punctuation cleaning separate from index terms', () => {
    expect(sanitizeTrigramQuery('  部署密令?是什么！ foo*bar ')).toBe('部署密令 是什么 foo bar')
  })
  it('bounds over-fetch and applies the score floor without violating limits', () => {
    expect(computeOverFetchLimit(10)).toBe(30)
    expect(computeOverFetchLimit(20)).toBe(50)
    const hits = [10, 2, 0.5].map((score, index) => ({ scopeId: 's', relPath: `${index}.md`, body: 'body', score }))
    expect(applyScoreFloor(hits, 10, 0.15)).toEqual(hits.slice(0, 2))
    expect(applyScoreFloor(hits, 1, 0.15)).toEqual(hits.slice(0, 1))
    expect(applyScoreFloor(hits, 0, 0)).toEqual([])
  })
})
