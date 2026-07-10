/**
 * T1-1：CacheProfile 判定与旧配置兼容
 */
import { describe, expect, it } from 'vitest'
import {
  getCacheProfileCatalog,
  resolveCacheProfile,
  type CacheProfileId
} from '../../../../src/runtime/model/cacheProfile'

describe('resolveCacheProfile', () => {
  describe('显式 cacheProfile 覆盖', () => {
    it('手工指定 deepseek 优先于 URL/modelId', () => {
      const p = resolveCacheProfile('https://api.openai.com/v1', 'gpt-4o', {
        cacheProfile: 'deepseek'
      })
      expect(p.id).toBe('deepseek')
      expect(p.marker).toBe('none')
      expect(p.reasoningReplay).toBe('tool-call-history')
    })

    it('手工指定 anthropic 得到 cache_control', () => {
      const p = resolveCacheProfile('https://custom.example/v1', 'my-model', {
        cacheProfile: 'anthropic'
      })
      expect(p.id).toBe('anthropic')
      expect(p.marker).toBe('cache_control')
    })

    it("cacheProfile:'auto' 不强制，继续走后续判定", () => {
      const p = resolveCacheProfile('https://api.deepseek.com/v1', 'deepseek-chat', {
        cacheProfile: 'auto'
      })
      expect(p.id).toBe('deepseek')
    })
  })

  describe('旧 cacheStrategy 兼容', () => {
    it("cacheStrategy:'anthropic' → anthropic 档案（即使 URL 非 anthropic）", () => {
      const p = resolveCacheProfile('https://api.openai.com/v1', 'gpt-4o', {
        cacheStrategy: 'anthropic'
      })
      expect(p.id).toBe('anthropic')
      expect(p.marker).toBe('cache_control')
    })

    it("deepseek.com + cacheStrategy:'auto' → 仍为 deepseek（不钉死 generic）", () => {
      const p = resolveCacheProfile('https://api.deepseek.com/v1', 'deepseek-chat', {
        cacheStrategy: 'auto'
      })
      expect(p.id).toBe('deepseek')
      expect(p.marker).toBe('none')
      expect(p.reasoningReplay).toBe('tool-call-history')
    })

    it("anthropic.com + cacheStrategy:'auto' → id 仍 anthropic，仅 marker 压成 none", () => {
      const p = resolveCacheProfile('https://api.anthropic.com/v1', 'claude-3-5-sonnet', {
        cacheStrategy: 'auto'
      })
      expect(p.id).toBe('anthropic')
      expect(p.marker).toBe('none')
      expect(p.idlePolicy).toBe('anthropic-short-ttl')
    })

    it("kimi + cacheStrategy:'auto' → id kimi，promptCacheKey 仍为 session", () => {
      const p = resolveCacheProfile('https://api.moonshot.cn/v1', 'kimi-k2', {
        cacheStrategy: 'auto'
      })
      expect(p.id).toBe('kimi')
      expect(p.marker).toBe('none')
      expect(p.promptCacheKey).toBe('session')
    })

    it('显式 cacheProfile 优先于 cacheStrategy', () => {
      const p = resolveCacheProfile('https://api.anthropic.com/v1', 'claude', {
        cacheProfile: 'kimi',
        cacheStrategy: 'anthropic'
      })
      expect(p.id).toBe('kimi')
      expect(p.marker).toBe('none')
    })
  })

  describe('官方域名自动判定', () => {
    it('anthropic.com → anthropic', () => {
      expect(resolveCacheProfile('https://api.anthropic.com/v1', 'x').id).toBe('anthropic')
    })

    it('deepseek.com → deepseek', () => {
      expect(resolveCacheProfile('https://api.deepseek.com/v1', 'x').id).toBe('deepseek')
    })

    it('moonshot.cn / moonshot.ai → kimi', () => {
      expect(resolveCacheProfile('https://api.moonshot.cn/v1', 'x').id).toBe('kimi')
      expect(resolveCacheProfile('https://api.moonshot.ai/v1', 'x').id).toBe('kimi')
    })

    it('bigmodel.cn → glm', () => {
      expect(resolveCacheProfile('https://open.bigmodel.cn/api/paas/v4', 'x').id).toBe('glm')
    })

    it('minimax 域名 → minimax', () => {
      expect(resolveCacheProfile('https://api.minimax.chat/v1', 'x').id).toBe('minimax')
      expect(resolveCacheProfile('https://api.minimax.io/v1', 'x').id).toBe('minimax')
    })

    it('openai.com → openai', () => {
      expect(resolveCacheProfile('https://api.openai.com/v1', 'x').id).toBe('openai')
    })
  })

  describe('modelId 分词自动判定', () => {
    it('claude / anthropic → anthropic', () => {
      expect(resolveCacheProfile('https://proxy.example/v1', 'claude-3-5-sonnet').id).toBe(
        'anthropic'
      )
    })

    it('deepseek → deepseek', () => {
      expect(resolveCacheProfile('https://proxy.example/v1', 'deepseek-chat').id).toBe('deepseek')
    })

    it('kimi / moonshot → kimi', () => {
      expect(resolveCacheProfile('https://proxy.example/v1', 'kimi-k2').id).toBe('kimi')
      expect(resolveCacheProfile('https://proxy.example/v1', 'moonshot-v1').id).toBe('kimi')
    })

    it('glm / chatglm → glm', () => {
      expect(resolveCacheProfile('https://proxy.example/v1', 'glm-4.5').id).toBe('glm')
      expect(resolveCacheProfile('https://proxy.example/v1', 'chatglm-turbo').id).toBe('glm')
    })

    it('minimax / abab → minimax', () => {
      expect(resolveCacheProfile('https://proxy.example/v1', 'MiniMax-M2').id).toBe('minimax')
      expect(resolveCacheProfile('https://proxy.example/v1', 'abab6.5s').id).toBe('minimax')
    })

    it('gpt / o1 → openai', () => {
      expect(resolveCacheProfile('https://proxy.example/v1', 'gpt-4o').id).toBe('openai')
      expect(resolveCacheProfile('https://proxy.example/v1', 'o1-preview').id).toBe('openai')
    })
  })

  describe('OpenRouter 聚合站', () => {
    it('按 modelId provider 前缀判定', () => {
      expect(
        resolveCacheProfile('https://openrouter.ai/api/v1', 'anthropic/claude-3.5-sonnet').id
      ).toBe('anthropic')
      expect(
        resolveCacheProfile('https://openrouter.ai/api/v1', 'deepseek/deepseek-chat').id
      ).toBe('deepseek')
      expect(resolveCacheProfile('https://openrouter.ai/api/v1', 'openai/gpt-4o').id).toBe(
        'openai'
      )
      expect(resolveCacheProfile('https://openrouter.ai/api/v1', 'moonshot/kimi-k2').id).toBe(
        'kimi'
      )
    })

    it('无法识别前缀时回退 generic', () => {
      expect(
        resolveCacheProfile('https://openrouter.ai/api/v1', 'some-vendor/unknown-model').id
      ).toBe('generic')
    })
  })

  describe('自定义 / 本地端点', () => {
    it('vLLM / Ollama 自定义 URL 且无已知 modelId → generic', () => {
      expect(resolveCacheProfile('http://127.0.0.1:8000/v1', 'llama-3-8b').id).toBe('generic')
      expect(resolveCacheProfile('http://localhost:11434/v1', 'local-model').id).toBe('generic')
    })

    it('generic 档案 marker 为 none', () => {
      const p = resolveCacheProfile('http://127.0.0.1:8000/v1', 'llama-3')
      expect(p.marker).toBe('none')
      expect(p.promptCacheKey).toBe('never')
      expect(p.reasoningReplay).toBe('none')
      expect(p.idlePolicy).toBe('unknown')
    })
  })

  describe('档案字段完整性', () => {
    it('每个 CacheProfileId 都有完整能力字段', () => {
      const catalog = getCacheProfileCatalog()
      const ids: CacheProfileId[] = [
        'anthropic',
        'deepseek',
        'kimi',
        'glm',
        'minimax',
        'openai',
        'generic'
      ]
      for (const id of ids) {
        const p = catalog[id]
        expect(p.id).toBe(id)
        expect(['cache_control', 'none']).toContain(p.marker)
        expect(['never', 'session']).toContain(p.promptCacheKey)
        expect(['none', 'tool-call-history', 'all-history']).toContain(p.reasoningReplay)
        expect(['anthropic-short-ttl', 'provider-managed', 'unknown']).toContain(p.idlePolicy)
      }
    })

    it('仅 anthropic 使用 cache_control marker', () => {
      const catalog = getCacheProfileCatalog()
      for (const [id, p] of Object.entries(catalog)) {
        if (id === 'anthropic') {
          expect(p.marker).toBe('cache_control')
        } else {
          expect(p.marker).toBe('none')
        }
      }
    })
  })
})
