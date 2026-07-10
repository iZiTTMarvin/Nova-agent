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
      expect(result).not.toHaveProperty('cacheMissTokens')
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
    it('解析 prompt_cache_hit_tokens 与 prompt_cache_miss_tokens', () => {
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
        cacheWriteTokens: 0,
        cacheMissTokens: 500
      })
    })

    it('仅有 hit 无 miss 字段时不带 cacheMissTokens', () => {
      const result = normalizeUsage({
        prompt_tokens: 2000,
        completion_tokens: 300,
        prompt_cache_hit_tokens: 1500
      })

      expect(result?.cachedTokens).toBe(1500)
      expect(result).not.toHaveProperty('cacheMissTokens')
    })
  })

  describe('Kimi 格式', () => {
    it('解析顶层 cached_tokens（嵌套缺失时回退）', () => {
      const result = normalizeUsage({
        prompt_tokens: 1200,
        completion_tokens: 80,
        cached_tokens: 900
      })

      expect(result).toEqual({
        promptTokens: 1200,
        completionTokens: 80,
        cachedTokens: 900,
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
      expect(result).not.toHaveProperty('cacheMissTokens')
    })
  })

  describe('解析优先级与字段冲突', () => {
    it('嵌套与顶层同时存在时嵌套优先', () => {
      const result = normalizeUsage({
        prompt_tokens: 1000,
        completion_tokens: 50,
        prompt_tokens_details: { cached_tokens: 700 },
        cached_tokens: 999,
        prompt_cache_hit_tokens: 888
      })

      expect(result?.cachedTokens).toBe(700)
    })

    it('嵌套 cached_tokens 为 0 时仍优先于顶层（不回退）', () => {
      const result = normalizeUsage({
        prompt_tokens: 1000,
        completion_tokens: 50,
        prompt_tokens_details: { cached_tokens: 0 },
        cached_tokens: 500
      })

      expect(result?.cachedTokens).toBe(0)
    })

    it('顶层字段冲突时 DeepSeek hit 优先于 Kimi cached_tokens', () => {
      const result = normalizeUsage({
        prompt_tokens: 1000,
        completion_tokens: 50,
        prompt_cache_hit_tokens: 600,
        cached_tokens: 400
      })

      expect(result?.cachedTokens).toBe(600)
    })
  })

  describe('四家真实样例', () => {
    it('OpenAI 嵌套 cached_tokens', () => {
      expect(
        normalizeUsage({
          prompt_tokens: 1523,
          completion_tokens: 87,
          prompt_tokens_details: { cached_tokens: 1280, audio_tokens: 0 }
        })
      ).toMatchObject({ cachedTokens: 1280, cacheWriteTokens: 0 })
    })

    it('DeepSeek 顶层 hit/miss', () => {
      expect(
        normalizeUsage({
          prompt_tokens: 4096,
          completion_tokens: 256,
          prompt_cache_hit_tokens: 3072,
          prompt_cache_miss_tokens: 1024,
          total_tokens: 4352
        })
      ).toEqual({
        promptTokens: 4096,
        completionTokens: 256,
        cachedTokens: 3072,
        cacheWriteTokens: 0,
        cacheMissTokens: 1024
      })
    })

    it('Kimi 顶层 cached_tokens', () => {
      expect(
        normalizeUsage({
          prompt_tokens: 2048,
          completion_tokens: 128,
          cached_tokens: 1800,
          total_tokens: 2176
        })
      ).toMatchObject({ cachedTokens: 1800 })
    })

    it('Anthropic cache_read / cache_creation', () => {
      expect(
        normalizeUsage({
          prompt_tokens: 10000,
          completion_tokens: 500,
          cache_read_input_tokens: 8500,
          cache_creation_input_tokens: 1200
        })
      ).toEqual({
        promptTokens: 10000,
        completionTokens: 500,
        cachedTokens: 8500,
        cacheWriteTokens: 1200
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

    it('字符串数字能正确解析（含缓存字段）', () => {
      const result = normalizeUsage({
        prompt_tokens: '1000',
        completion_tokens: '200',
        prompt_cache_hit_tokens: '750',
        prompt_cache_miss_tokens: '250'
      })

      expect(result?.promptTokens).toBe(1000)
      expect(result?.completionTokens).toBe(200)
      expect(result?.cachedTokens).toBe(750)
      expect(result?.cacheMissTokens).toBe(250)
    })

    it('非法字符串回退为 0', () => {
      const result = normalizeUsage({
        prompt_tokens: 'abc',
        completion_tokens: 100
      })

      expect(result?.promptTokens).toBe(0)
      expect(result?.completionTokens).toBe(100)
    })

    it('缺失缓存字段时 cachedTokens 为 0 且无 cacheMissTokens', () => {
      const result = normalizeUsage({
        prompt_tokens: 500,
        completion_tokens: 100
      })

      expect(result?.cachedTokens).toBe(0)
      expect(result?.cacheWriteTokens).toBe(0)
      expect(result).not.toHaveProperty('cacheMissTokens')
    })

    it('缺失 usage（仅 completion）仍可解析', () => {
      const result = normalizeUsage({
        completion_tokens: 42
      })
      expect(result).toEqual({
        promptTokens: 0,
        completionTokens: 42,
        cachedTokens: 0,
        cacheWriteTokens: 0
      })
    })
  })

  describe('命中率计算辅助', () => {
    it('可正确计算命中率（无 miss 时用 prompt 分母）', () => {
      const result = normalizeUsage({
        prompt_tokens: 1000,
        completion_tokens: 200,
        prompt_tokens_details: { cached_tokens: 750 }
      })

      expect(result).not.toBeNull()
      const hitRate = result!.cachedTokens / result!.promptTokens
      expect(hitRate).toBeCloseTo(0.75)
    })

    it('DeepSeek hit+miss 同时存在时可按 hit/(hit+miss) 计算', () => {
      const result = normalizeUsage({
        prompt_tokens: 2000,
        completion_tokens: 100,
        prompt_cache_hit_tokens: 1500,
        prompt_cache_miss_tokens: 500
      })

      expect(result?.cacheMissTokens).toBe(500)
      const hitRate = result!.cachedTokens / (result!.cachedTokens + result!.cacheMissTokens!)
      expect(hitRate).toBeCloseTo(0.75)
    })
  })
})
