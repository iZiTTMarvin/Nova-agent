import { describe, it, expect } from 'vitest'
import { normalizeUsage } from '../../../../src/runtime/model/usage'

describe('normalizeUsage', () => {
  describe('OpenAI 格式', () => {
    it('解析 prompt_tokens_details.cached_tokens', () => {
      const result = normalizeUsage({
        prompt_tokens: 1000,
        completion_tokens: 200,
        prompt_tokens_details: {
          cached_tokens: 800
        }
      })

      expect(result).toEqual({
        promptTokens: 1000,
        completionTokens: 200,
        cachedTokens: 800,
        cacheWriteTokens: 0
      })
    })

    it('无缓存时 cached_tokens 为 0', () => {
      const result = normalizeUsage({
        prompt_tokens: 500,
        completion_tokens: 100,
        prompt_tokens_details: {
          cached_tokens: 0
        }
      })

      expect(result?.cachedTokens).toBe(0)
    })
  })

  describe('DeepSeek 格式', () => {
    it('解析 prompt_cache_hit_tokens', () => {
      const result = normalizeUsage({
        prompt_tokens: 2000,
        completion_tokens: 300,
        prompt_cache_hit_tokens: 1500,
        prompt_cache_miss_tokens: 500
      })

      expect(result).toEqual({
        promptTokens: 2000,
        completionTokens: 300,
        cachedTokens: 1500,
        cacheWriteTokens: 0
      })
    })
  })

  describe('Anthropic 中转格式', () => {
    it('解析 cache_read_input_tokens 和 cache_creation_input_tokens', () => {
      const result = normalizeUsage({
        prompt_tokens: 3000,
        completion_tokens: 400,
        cache_read_input_tokens: 2500,
        cache_creation_input_tokens: 300
      })

      expect(result).toEqual({
        promptTokens: 3000,
        completionTokens: 400,
        cachedTokens: 2500,
        cacheWriteTokens: 300
      })
    })
  })

  describe('容错处理', () => {
    it('null 输入返回 null', () => {
      expect(normalizeUsage(null)).toBeNull()
    })

    it('undefined 输入返回 null', () => {
      expect(normalizeUsage(undefined)).toBeNull()
    })

    it('空对象返回 null', () => {
      expect(normalizeUsage({})).toBeNull()
    })

    it('prompt_tokens 和 completion_tokens 都为 0 时返回 null', () => {
      expect(normalizeUsage({ prompt_tokens: 0, completion_tokens: 0 })).toBeNull()
    })

    it('字符串数字能正确解析', () => {
      const result = normalizeUsage({
        prompt_tokens: '1000',
        completion_tokens: '200'
      })

      expect(result?.promptTokens).toBe(1000)
      expect(result?.completionTokens).toBe(200)
    })

    it('非法字符串回退为 0', () => {
      const result = normalizeUsage({
        prompt_tokens: 'abc',
        completion_tokens: 100
      })

      expect(result?.promptTokens).toBe(0)
      expect(result?.completionTokens).toBe(100)
    })

    it('缺失缓存字段时 cachedTokens 为 0', () => {
      const result = normalizeUsage({
        prompt_tokens: 500,
        completion_tokens: 100
      })

      expect(result?.cachedTokens).toBe(0)
      expect(result?.cacheWriteTokens).toBe(0)
    })
  })

  describe('命中率计算辅助', () => {
    it('可正确计算命中率', () => {
      const result = normalizeUsage({
        prompt_tokens: 1000,
        completion_tokens: 200,
        prompt_tokens_details: { cached_tokens: 750 }
      })

      expect(result).not.toBeNull()
      const hitRate = result!.cachedTokens / result!.promptTokens
      expect(hitRate).toBeCloseTo(0.75)
    })
  })
})
