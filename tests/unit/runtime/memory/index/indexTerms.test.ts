import { describe, expect, it } from 'vitest'
import { buildIndexTerms, buildMemoryIndexQuery, buildQueryTerms, mergeLexicalHits } from '@runtime/memory/index/indexTerms'

describe('memory index terms', () => {
  it('normalizes width and retains identifiers plus component words', () => {
    expect(buildIndexTerms('ＮＯＤＥ_MODULE_VERSION ghost_text parseHTTPResponse foo-bar.ts')).toBe('node_module_version node module version ghost_text ghost text parsehttpresponse parse http response foo-bar.ts foo bar ts')
    expect(buildIndexTerms('CAFÉ déjà-vu')).toBe('café déjà-vu déjà vu')
  })
  it('indexes CJK unigrams and adjacent pairs', () => {
    expect(buildIndexTerms('缓存前缀')).toBe('缓 存 前 缀 缓存 存前 前缀')
    expect(buildQueryTerms('缓存前缀')).toEqual(['缓存', '存前', '前缀'])
    expect(buildQueryTerms('缓')).toEqual(['缓'])
    expect(buildQueryTerms('a 缓')).toEqual(['a'])
    expect(buildQueryTerms('かなカナ 한글')).toContain('한글')
  })
  it('bounds and quotes MATCH input without query syntax injection', () => {
    const built = buildMemoryIndexQuery('foo" OR ghost_text 缓存 NOT *')
    expect(built.terms).toBe('"foo" OR "or" OR "ghost_text" OR "ghost" OR "text" OR "缓存" OR "not"')
    expect(built.literal).toBe('"foo" OR "ghost_text" OR "not"')
    expect(buildQueryTerms(Array.from({ length: 50 }, (_, i) => `word${i}`).join(' '))).toHaveLength(24)
    expect(buildMemoryIndexQuery('!!!')).toEqual({ terms: null, literal: null })
  })
  it('merges by id using each route normalized score and literal bonus', () => {
    expect(mergeLexicalHits([{ id: 'a', score: 10 }, { id: 'b', score: 5 }], [{ id: 'b', score: 2 }, { id: 'c', score: 1 }], undefined, 0.15)).toEqual([{ id: 'b', score: 1.15 }, { id: 'a', score: 1 }, { id: 'c', score: 0.65 }])
  })
  it('retains relative strengths across visible scopes when normalizers are shared', () => {
    const normalizers = { terms: 10, literal: 4 }
    expect(mergeLexicalHits([{ id: 'weak', score: 2 }], [], normalizers)).toEqual([{ id: 'weak', score: 0.2 }])
    expect(mergeLexicalHits([{ id: 'strong', score: 10 }], [], normalizers)).toEqual([{ id: 'strong', score: 1 }])
  })
})
