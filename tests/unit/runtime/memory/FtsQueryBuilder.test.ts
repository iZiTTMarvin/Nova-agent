import { describe, it, expect } from 'vitest'
import {
  buildMatchQuery,
  buildTrigramMatchQuery,
  buildUnicode61MatchQuery,
  applyScoreFloor,
  computeOverFetchLimit,
  sanitizeTrigramQuery,
  TRIGRAM_MIN_QUERY_LEN
} from '../../../../src/runtime/memory/FtsQueryBuilder'
import type { MemorySearchHit } from '../../../../src/runtime/memory/types'

describe('FtsQueryBuilder（P1-A2 纯逻辑）', () => {
  describe('trigram 路径', () => {
    it('中文整串清洗后返回 MATCH 串', () => {
      const q = buildTrigramMatchQuery('  中文检索  ')
      expect(q).toBe('中文检索')
    })

    it(`不足 ${TRIGRAM_MIN_QUERY_LEN} 字符返回 null`, () => {
      expect(buildTrigramMatchQuery('ab')).toBeNull()
      expect(buildMatchQuery('x').path).toBe('none')
    })

    it('含 CJK 时走 trigram 分派', () => {
      const { query, path } = buildMatchQuery('用户偏好设置')
      expect(path).toBe('trigram')
      expect(query).toBe('用户偏好设置')
    })

    it('清洗 FTS 特殊字符（旧黑名单路径）', () => {
      expect(sanitizeTrigramQuery('foo*bar')).toBe('foo bar')
    })

    it('白名单清洗：中英文标点均不入 MATCH', () => {
      const punctuated = '本项目的部署密令是什么?我是谁！'
      const cleaned = sanitizeTrigramQuery(punctuated)
      expect(cleaned).toBe('本项目的部署密令是什么 我是谁')
      expect(cleaned).not.toMatch(/[^\p{L}\p{N}\s]/u)

      for (const sample of ['？', '。', '，', '、', '!', '*', '(', ')', ':', '^', '-', '+', '{', '}']) {
        const out = sanitizeTrigramQuery(`测试${sample}内容`)
        expect(out).not.toMatch(/[^\p{L}\p{N}\s]/u)
        expect(out).toContain('测试')
        expect(out).toContain('内容')
      }
    })

    it('纯 CJK 无标点串与旧逻辑一致', () => {
      expect(sanitizeTrigramQuery('用户偏好设置')).toBe('用户偏好设置')
      expect(buildMatchQuery('用户偏好设置')).toEqual({
        query: '用户偏好设置',
        path: 'trigram'
      })
    })

    it('buildMatchQuery 输出不含 FTS 危险字符', () => {
      const { query } = buildMatchQuery('部署密令?是什么！')
      expect(query).not.toBeNull()
      expect(query!).not.toMatch(/[^\p{L}\p{N}\s]/u)
    })
  })

  describe('unicode61 路径', () => {
    it('英文分词 OR 连接', () => {
      const q = buildUnicode61MatchQuery('authentication authorization')
      expect(q).toContain(' OR ')
      expect(q).toContain('authentication')
      expect(q).toContain('authorization')
    })

    it('双引号短语保留', () => {
      const q = buildUnicode61MatchQuery('"exact phrase" token')
      expect(q).toContain('"exact phrase"')
      expect(q).toContain('token')
    })

    it('纯英文走 unicode61 分派', () => {
      const { path, query } = buildMatchQuery('database migration')
      expect(path).toBe('unicode61')
      expect(query).toContain('database')
    })

    it('unicode61 不以 - 开头 bareword（防 FTS 运算符）', () => {
      const q = buildUnicode61MatchQuery('-authentication token')
      expect(q).not.toBeNull()
      expect(q!).not.toMatch(/\b-/)
      expect(q).toContain('authentication')
    })
  })

  describe('BM25 裁剪与 over-fetch', () => {
    it('over-fetch = limit*3 且封顶 50', () => {
      expect(computeOverFetchLimit(10)).toBe(30)
      expect(computeOverFetchLimit(20)).toBe(50)
    })

    it('top1 恒留，其余按 score >= top*floor 过滤', () => {
      const hits: MemorySearchHit[] = [
        { scopeId: 's', relPath: 'a.md', body: 'a', score: 10 },
        { scopeId: 's', relPath: 'b.md', body: 'b', score: 2 },
        { scopeId: 's', relPath: 'c.md', body: 'c', score: 0.5 }
      ]
      const out = applyScoreFloor(hits, 10, 0.15)
      expect(out).toHaveLength(2)
      expect(out[0].relPath).toBe('a.md')
      expect(out[1].relPath).toBe('b.md')
    })
  })
})
