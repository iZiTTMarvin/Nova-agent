import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useSettingsStore, resetSettingsStoreForTests } from '../../../src/renderer/stores/useSettingsStore'
import type { NormalizedUsage } from '../../../src/runtime/model/types'

// 模拟 window.api，避免 loadModelConfig 等 IPC 调用失败
const mockInvoke = vi.fn()
const mockOn = vi.fn(() => () => {})

global.window = {
  ...global.window,
  api: {
    invoke: mockInvoke,
    on: mockOn,
    removeAllListeners: vi.fn()
  }
} as unknown as Window & typeof globalThis

describe('useSettingsStore.handleUsage', () => {
  beforeEach(() => {
    resetSettingsStoreForTests()
  })

  it('第一次调用累计基础用量', () => {
    const usage: NormalizedUsage = {
      promptTokens: 1000,
      completionTokens: 200,
      cachedTokens: 0,
      cacheWriteTokens: 0
    }

    useSettingsStore.getState().handleUsage(usage)
    const stats = useSettingsStore.getState().sessionUsage

    expect(stats).not.toBeNull()
    expect(stats!.totalPromptTokens).toBe(1000)
    expect(stats!.totalCompletionTokens).toBe(200)
    expect(stats!.totalCachedTokens).toBe(0)
    expect(stats!.totalCacheWriteTokens).toBe(0)
    expect(stats!.hitRate).toBe(0)
  })

  it('Anthropic 场景下命中率包含 cache_creation_input_tokens', () => {
    // Anthropic 典型返回：
    // input_tokens = 1000, cache_read_input_tokens = 7000, cache_creation_input_tokens = 2000
    // promptTokens 归一化为 8000（input + cache_read）
    const usage: NormalizedUsage = {
      promptTokens: 8000,
      completionTokens: 500,
      cachedTokens: 7000,
      cacheWriteTokens: 2000
    }

    useSettingsStore.getState().handleUsage(usage)
    const stats = useSettingsStore.getState().sessionUsage

    // 错误算法：7000 / 8000 = 87.5%
    // 正确算法：7000 / (8000 + 2000) = 70%
    expect(stats!.hitRate).toBeCloseTo(0.7)
  })

  it('多轮累计后命中率保持正确', () => {
    const u1: NormalizedUsage = {
      promptTokens: 8000,
      completionTokens: 500,
      cachedTokens: 7000,
      cacheWriteTokens: 2000
    }
    const u2: NormalizedUsage = {
      promptTokens: 3000,
      completionTokens: 300,
      cachedTokens: 2500,
      cacheWriteTokens: 0
    }

    useSettingsStore.getState().handleUsage(u1)
    useSettingsStore.getState().handleUsage(u2)
    const stats = useSettingsStore.getState().sessionUsage

    expect(stats!.totalPromptTokens).toBe(11000)
    expect(stats!.totalCachedTokens).toBe(9500)
    expect(stats!.totalCacheWriteTokens).toBe(2000)
    // 9500 / (11000 + 2000) = 9500 / 13000 ≈ 0.7308
    expect(stats!.hitRate).toBeCloseTo(9500 / 13000)
  })

  it('当没有缓存命中且没有缓存写入时命中率为 0', () => {
    const usage: NormalizedUsage = {
      promptTokens: 5000,
      completionTokens: 1000,
      cachedTokens: 0,
      cacheWriteTokens: 0
    }

    useSettingsStore.getState().handleUsage(usage)
    const stats = useSettingsStore.getState().sessionUsage

    expect(stats!.hitRate).toBe(0)
  })

  it('当所有输入都来自缓存时命中率为 1', () => {
    const usage: NormalizedUsage = {
      promptTokens: 5000,
      completionTokens: 1000,
      cachedTokens: 5000,
      cacheWriteTokens: 0
    }

    useSettingsStore.getState().handleUsage(usage)
    const stats = useSettingsStore.getState().sessionUsage

    expect(stats!.hitRate).toBe(1)
  })

  it('重置后会话用量统计清空', () => {
    useSettingsStore.getState().handleUsage({
      promptTokens: 1000,
      completionTokens: 200,
      cachedTokens: 800,
      cacheWriteTokens: 100
    })

    expect(useSettingsStore.getState().sessionUsage).not.toBeNull()

    useSettingsStore.getState().resetSessionUsage()

    expect(useSettingsStore.getState().sessionUsage).toBeNull()
  })

  it('DeepSeek 本轮有 miss 时命中率用 hit/(hit+miss)', () => {
    useSettingsStore.getState().handleUsage({
      promptTokens: 2000,
      completionTokens: 100,
      cachedTokens: 1500,
      cacheWriteTokens: 0,
      cacheMissTokens: 500
    })
    const stats = useSettingsStore.getState().sessionUsage

    expect(stats!.totalCacheMissTokens).toBe(500)
    // 1500 / (1500 + 500) = 0.75；不得误用 1500/2000
    expect(stats!.hitRate).toBeCloseTo(0.75)
  })

  it('无 miss 字段时不写入 totalCacheMissTokens，保持 Anthropic 口径', () => {
    useSettingsStore.getState().handleUsage({
      promptTokens: 8000,
      completionTokens: 500,
      cachedTokens: 7000,
      cacheWriteTokens: 2000
    })
    const stats = useSettingsStore.getState().sessionUsage

    expect(stats).not.toHaveProperty('totalCacheMissTokens')
    expect(stats!.hitRate).toBeCloseTo(0.7)
  })

  it('按 cacheProfileId 分桶累计；fallback 后进新桶', () => {
    useSettingsStore.getState().handleUsage(
      {
        promptTokens: 1000,
        completionTokens: 50,
        cachedTokens: 800,
        cacheWriteTokens: 0
      },
      'openai'
    )
    useSettingsStore.getState().handleUsage(
      {
        promptTokens: 2000,
        completionTokens: 100,
        cachedTokens: 1500,
        cacheWriteTokens: 0,
        cacheMissTokens: 500
      },
      'deepseek'
    )

    const buckets = useSettingsStore.getState().sessionUsageByProfile
    expect(Object.keys(buckets).sort()).toEqual(['deepseek', 'openai'])
    expect(buckets.openai.totalPromptTokens).toBe(1000)
    expect(buckets.deepseek.totalPromptTokens).toBe(2000)
    expect(buckets.deepseek.hitRate).toBeCloseTo(0.75)
    // 合计仍写入 sessionUsage（兼容旧 UI）
    expect(useSettingsStore.getState().sessionUsage!.totalPromptTokens).toBe(3000)
  })

  it('resetSessionUsage 清空全部分桶', () => {
    useSettingsStore.getState().handleUsage(
      { promptTokens: 100, completionTokens: 10, cachedTokens: 0, cacheWriteTokens: 0 },
      'kimi'
    )
    useSettingsStore.getState().resetSessionUsage()
    expect(useSettingsStore.getState().sessionUsage).toBeNull()
    expect(useSettingsStore.getState().sessionUsageByProfile).toEqual({})
  })
})

