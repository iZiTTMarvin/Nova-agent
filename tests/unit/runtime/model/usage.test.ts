import { describe, it, expect } from 'vitest'
import { normalizeUsage } from '../../../../src/runtime/model/usage'
import { computeCacheHitRate } from '../../../../src/shared/model/types'

describe('normalizeUsage', () => {
  describe('OpenAI 格式', () => {
    it('解析 prompt_tokens_details.cached_tokens 并派生四元组', () => {
      const result = normalizeUsage({
        prompt_tokens: 1000,
        completion_tokens: 200,
        prompt_tokens_details: {
          cached_tokens: 800
        }
      })

      expect(result).toMatchObject({
        uncachedInputTokens: 200,
        cacheReadTokens: 800,
        cacheWriteTokens: 0,
        outputTokens: 200,
        promptTokens: 1000,
        completionTokens: 200,
        cachedTokens: 800,
        usageDialect: 'openai'
      })
      expect(result?.rawUsage).toBeDefined()
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
      expect(result?.uncachedInputTokens).toBe(500)
    })
  })

  describe('DeepSeek 格式', () => {
    it('有 miss 字段时优先用 miss 作 uncached', () => {
      const result = normalizeUsage({
        prompt_tokens: 2000,
        completion_tokens: 300,
        prompt_cache_hit_tokens: 1500,
        prompt_cache_miss_tokens: 500
      })

      expect(result).toMatchObject({
        uncachedInputTokens: 500,
        cacheReadTokens: 1500,
        cacheWriteTokens: 0,
        outputTokens: 300,
        promptTokens: 2000,
        cachedTokens: 1500,
        cacheMissTokens: 500,
        usageDialect: 'deepseek'
      })
    })

    it('仅有 hit 无 miss 字段时不带 cacheMissTokens', () => {
      const result = normalizeUsage({
        prompt_tokens: 2000,
        completion_tokens: 300,
        prompt_cache_hit_tokens: 1500
      })

      expect(result?.uncachedInputTokens).toBe(500)
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

      expect(result).toMatchObject({
        uncachedInputTokens: 300,
        cacheReadTokens: 900,
        promptTokens: 1200,
        cachedTokens: 900,
        usageDialect: 'openai'
      })
    })
  })

  describe('Anthropic 中转与原生', () => {
    it('中转格式：prompt_tokens + cache_read / cache_creation', () => {
      const result = normalizeUsage({
        prompt_tokens: 3000,
        completion_tokens: 400,
        cache_read_input_tokens: 2500,
        cache_creation_input_tokens: 300
      })

      expect(result).toMatchObject({
        uncachedInputTokens: 500,
        cacheReadTokens: 2500,
        cacheWriteTokens: 300,
        outputTokens: 400,
        promptTokens: 3000,
        usageDialect: 'openai'
      })
    })

    it('原生 input_tokens / output_tokens 不再返回 null', () => {
      const result = normalizeUsage({
        input_tokens: 1000,
        output_tokens: 200,
        cache_read_input_tokens: 7000,
        cache_creation_input_tokens: 2000
      })

      expect(result).toMatchObject({
        uncachedInputTokens: 1000,
        cacheReadTokens: 7000,
        cacheWriteTokens: 2000,
        outputTokens: 200,
        promptTokens: 8000,
        completionTokens: 200,
        cachedTokens: 7000,
        usageDialect: 'anthropic'
      })
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
      expect(result?.usageDialect).toBe('deepseek')
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
      ).toMatchObject({
        cachedTokens: 1280,
        cacheWriteTokens: 0,
        uncachedInputTokens: 243
      })
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
      ).toMatchObject({
        promptTokens: 4096,
        completionTokens: 256,
        cachedTokens: 3072,
        cacheWriteTokens: 0,
        cacheMissTokens: 1024,
        uncachedInputTokens: 1024
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
      ).toMatchObject({ cachedTokens: 1800, uncachedInputTokens: 248 })
    })

    it('Anthropic cache_read / cache_creation（中转）', () => {
      expect(
        normalizeUsage({
          prompt_tokens: 10000,
          completion_tokens: 500,
          cache_read_input_tokens: 8500,
          cache_creation_input_tokens: 1200
        })
      ).toMatchObject({
        promptTokens: 10000,
        completionTokens: 500,
        cachedTokens: 8500,
        cacheWriteTokens: 1200,
        uncachedInputTokens: 1500
      })
    })

    it('GLM 语义同 OpenAI 嵌套', () => {
      expect(
        normalizeUsage({
          prompt_tokens: 4096,
          completion_tokens: 128,
          prompt_tokens_details: { cached_tokens: 3000 }
        })
      ).toMatchObject({
        uncachedInputTokens: 1096,
        cacheReadTokens: 3000,
        usageDialect: 'openai'
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
      expect(result?.uncachedInputTokens).toBe(250)
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
      expect(result).toMatchObject({
        promptTokens: 0,
        completionTokens: 42,
        cachedTokens: 0,
        cacheWriteTokens: 0,
        uncachedInputTokens: 0,
        outputTokens: 42
      })
    })
  })

  describe('统一命中率公式', () => {
    it('四类样例 hitRate ≤ 1 且符合手算', () => {
      const openai = normalizeUsage({
        prompt_tokens: 1000,
        completion_tokens: 200,
        prompt_tokens_details: { cached_tokens: 750 }
      })!
      expect(
        computeCacheHitRate({
          uncachedInputTokens: openai.uncachedInputTokens,
          cacheReadTokens: openai.cacheReadTokens,
          cacheWriteTokens: openai.cacheWriteTokens
        })
      ).toBeCloseTo(750 / (250 + 750 + 0))

      const deepseek = normalizeUsage({
        prompt_tokens: 2000,
        completion_tokens: 100,
        prompt_cache_hit_tokens: 1500,
        prompt_cache_miss_tokens: 500
      })!
      expect(
        computeCacheHitRate({
          uncachedInputTokens: deepseek.uncachedInputTokens,
          cacheReadTokens: deepseek.cacheReadTokens,
          cacheWriteTokens: deepseek.cacheWriteTokens
        })
      ).toBeCloseTo(0.75)

      const anthropic = normalizeUsage({
        input_tokens: 1000,
        output_tokens: 200,
        cache_read_input_tokens: 7000,
        cache_creation_input_tokens: 2000
      })!
      expect(
        computeCacheHitRate({
          uncachedInputTokens: anthropic.uncachedInputTokens,
          cacheReadTokens: anthropic.cacheReadTokens,
          cacheWriteTokens: anthropic.cacheWriteTokens
        })
      ).toBeCloseTo(0.7)

      const glm = normalizeUsage({
        prompt_tokens: 4096,
        completion_tokens: 128,
        prompt_tokens_details: { cached_tokens: 3000 }
      })!
      const glmRate = computeCacheHitRate({
        uncachedInputTokens: glm.uncachedInputTokens,
        cacheReadTokens: glm.cacheReadTokens,
        cacheWriteTokens: glm.cacheWriteTokens
      })
      expect(glmRate).toBeLessThanOrEqual(1)
      expect(glmRate).toBeCloseTo(3000 / (1096 + 3000))
    })
  })
})
