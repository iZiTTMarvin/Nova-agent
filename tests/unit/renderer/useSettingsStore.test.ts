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

function usage(partial: Partial<NormalizedUsage> & Pick<NormalizedUsage, 'promptTokens' | 'completionTokens' | 'cachedTokens' | 'cacheWriteTokens'>): NormalizedUsage {
  const cacheRead = partial.cacheReadTokens ?? partial.cachedTokens
  const output = partial.outputTokens ?? partial.completionTokens
  const uncached =
    partial.uncachedInputTokens ??
    (partial.cacheMissTokens !== undefined
      ? partial.cacheMissTokens
      : Math.max(0, partial.promptTokens - cacheRead))
  return {
    uncachedInputTokens: uncached,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: partial.cacheWriteTokens,
    outputTokens: output,
    rawUsage: partial.rawUsage ?? {},
    usageDialect: partial.usageDialect ?? 'openai',
    promptTokens: partial.promptTokens,
    completionTokens: partial.completionTokens,
    cachedTokens: partial.cachedTokens,
    ...(partial.cacheMissTokens !== undefined
      ? { cacheMissTokens: partial.cacheMissTokens }
      : {})
  }
}

describe('useSettingsStore.handleUsage', () => {
  beforeEach(() => {
    resetSettingsStoreForTests()
  })

  it('第一次调用累计基础用量', () => {
    useSettingsStore.getState().handleUsage(
      usage({
        promptTokens: 1000,
        completionTokens: 200,
        cachedTokens: 0,
        cacheWriteTokens: 0
      })
    )
    const stats = useSettingsStore.getState().sessionUsage

    expect(stats).not.toBeNull()
    expect(stats!.totalPromptTokens).toBe(1000)
    expect(stats!.totalCompletionTokens).toBe(200)
    expect(stats!.totalCachedTokens).toBe(0)
    expect(stats!.totalCacheWriteTokens).toBe(0)
    expect(stats!.hitRate).toBe(0)
    expect(stats!.lastRoundHitRate).toBe(0)
  })

  it('Anthropic 场景下命中率含 cacheWrite：cacheRead/(uncached+read+write)', () => {
    // uncached=1000, read=7000, write=2000 → 7000/10000 = 0.7
    useSettingsStore.getState().handleUsage(
      usage({
        promptTokens: 8000,
        completionTokens: 500,
        cachedTokens: 7000,
        cacheWriteTokens: 2000,
        uncachedInputTokens: 1000,
        usageDialect: 'anthropic'
      })
    )
    const stats = useSettingsStore.getState().sessionUsage
    expect(stats!.hitRate).toBeCloseTo(0.7)
    expect(stats!.lastRoundHitRate).toBeCloseTo(0.7)
    expect(stats!.estimatedSavedInputTokens).toBe(7000)
  })

  it('多轮累计后命中率保持正确', () => {
    useSettingsStore.getState().handleUsage(
      usage({
        promptTokens: 8000,
        completionTokens: 500,
        cachedTokens: 7000,
        cacheWriteTokens: 2000,
        uncachedInputTokens: 1000
      })
    )
    useSettingsStore.getState().handleUsage(
      usage({
        promptTokens: 3000,
        completionTokens: 300,
        cachedTokens: 2500,
        cacheWriteTokens: 0,
        uncachedInputTokens: 500
      })
    )
    const stats = useSettingsStore.getState().sessionUsage

    expect(stats!.totalPromptTokens).toBe(11000)
    expect(stats!.totalCachedTokens).toBe(9500)
    expect(stats!.totalCacheWriteTokens).toBe(2000)
    // 9500 / (1500 + 9500 + 2000) = 9500/13000
    expect(stats!.hitRate).toBeCloseTo(9500 / 13000)
    expect(stats!.lastRoundHitRate).toBeCloseTo(2500 / 3000)
  })

  it('当没有缓存命中且没有缓存写入时命中率为 0', () => {
    useSettingsStore.getState().handleUsage(
      usage({
        promptTokens: 5000,
        completionTokens: 1000,
        cachedTokens: 0,
        cacheWriteTokens: 0
      })
    )
    expect(useSettingsStore.getState().sessionUsage!.hitRate).toBe(0)
  })

  it('当所有输入都来自缓存时命中率为 1', () => {
    useSettingsStore.getState().handleUsage(
      usage({
        promptTokens: 5000,
        completionTokens: 1000,
        cachedTokens: 5000,
        cacheWriteTokens: 0,
        uncachedInputTokens: 0
      })
    )
    expect(useSettingsStore.getState().sessionUsage!.hitRate).toBe(1)
  })

  it('重置后会话用量统计清空', () => {
    useSettingsStore.getState().handleUsage(
      usage({
        promptTokens: 1000,
        completionTokens: 200,
        cachedTokens: 800,
        cacheWriteTokens: 100
      })
    )
    expect(useSettingsStore.getState().sessionUsage).not.toBeNull()
    useSettingsStore.getState().resetSessionUsage()
    expect(useSettingsStore.getState().sessionUsage).toBeNull()
  })

  it('DeepSeek 有 miss 时仍用统一公式，曲线与 hit/(hit+miss) 一致', () => {
    useSettingsStore.getState().handleUsage(
      usage({
        promptTokens: 2000,
        completionTokens: 100,
        cachedTokens: 1500,
        cacheWriteTokens: 0,
        cacheMissTokens: 500,
        uncachedInputTokens: 500,
        usageDialect: 'deepseek'
      })
    )
    const stats = useSettingsStore.getState().sessionUsage
    expect(stats!.totalCacheMissTokens).toBe(500)
    expect(stats!.hitRate).toBeCloseTo(0.75)
  })

  it('混合轮次（一轮带 miss、一轮不带）命中率曲线连续', () => {
    useSettingsStore.getState().handleUsage(
      usage({
        promptTokens: 2000,
        completionTokens: 100,
        cachedTokens: 1500,
        cacheWriteTokens: 0,
        cacheMissTokens: 500,
        uncachedInputTokens: 500
      })
    )
    const afterMiss = useSettingsStore.getState().sessionUsage!.hitRate
    expect(afterMiss).toBeCloseTo(0.75)

    useSettingsStore.getState().handleUsage(
      usage({
        promptTokens: 3000,
        completionTokens: 50,
        cachedTokens: 2000,
        cacheWriteTokens: 0,
        uncachedInputTokens: 1000
      })
    )
    // (1500+2000) / (500+1000 + 1500+2000 + 0) = 3500/5000 = 0.7
    expect(useSettingsStore.getState().sessionUsage!.hitRate).toBeCloseTo(0.7)
    expect(useSettingsStore.getState().sessionUsage!.lastRoundHitRate).toBeCloseTo(2000 / 3000)
  })

  it('无 miss 字段时不写入 totalCacheMissTokens', () => {
    useSettingsStore.getState().handleUsage(
      usage({
        promptTokens: 8000,
        completionTokens: 500,
        cachedTokens: 7000,
        cacheWriteTokens: 2000,
        uncachedInputTokens: 1000
      })
    )
    const stats = useSettingsStore.getState().sessionUsage
    expect(stats).not.toHaveProperty('totalCacheMissTokens')
    expect(stats!.hitRate).toBeCloseTo(0.7)
  })

  it('按 cacheProfileId 分桶累计；fallback 后进新桶', () => {
    useSettingsStore.getState().handleUsage(
      usage({
        promptTokens: 1000,
        completionTokens: 50,
        cachedTokens: 800,
        cacheWriteTokens: 0
      }),
      'openai'
    )
    useSettingsStore.getState().handleUsage(
      usage({
        promptTokens: 2000,
        completionTokens: 100,
        cachedTokens: 1500,
        cacheWriteTokens: 0,
        cacheMissTokens: 500,
        uncachedInputTokens: 500
      }),
      'deepseek'
    )

    const buckets = useSettingsStore.getState().sessionUsageByProfile
    expect(Object.keys(buckets).sort()).toEqual(['deepseek', 'openai'])
    expect(buckets.openai.totalPromptTokens).toBe(1000)
    expect(buckets.deepseek.totalPromptTokens).toBe(2000)
    expect(buckets.deepseek.hitRate).toBeCloseTo(0.75)
    expect(useSettingsStore.getState().sessionUsage!.totalPromptTokens).toBe(3000)
  })

  it('resetSessionUsage 清空全部分桶', () => {
    useSettingsStore.getState().handleUsage(
      usage({ promptTokens: 100, completionTokens: 10, cachedTokens: 0, cacheWriteTokens: 0 }),
      'kimi'
    )
    useSettingsStore.getState().resetSessionUsage()
    expect(useSettingsStore.getState().sessionUsage).toBeNull()
    expect(useSettingsStore.getState().sessionUsageByProfile).toEqual({})
  })
})
