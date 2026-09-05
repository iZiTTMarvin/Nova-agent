// @vitest-environment jsdom

import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ContextIndicator, formatTokens } from '../../../src/renderer/features/chat/ContextIndicator'
import { useAppStore } from '../../../src/renderer/stores/useAppStore'
import { act, renderDom } from './renderDom'

vi.mock('framer-motion', () => import('./_framerMotionMock'))

function setContextState(overrides?: Partial<{
  sessionUsage: {
    totalUncachedInputTokens: number
    totalCacheReadTokens: number
    totalCacheWriteTokens: number
    totalOutputTokens: number
    totalPromptTokens: number
    totalCompletionTokens: number
    totalCachedTokens: number
    hitRate: number
    lastRoundHitRate: number
    estimatedSavedInputTokens: number
    cacheCountCoverage: { reportedPositive: number; reportedZero: number; unreported: number }
  } | null
}>) {
  useAppStore.setState({
    contextLimit: 200_000,
    contextBreakdown: {
      sessionId: 'sess_context_indicator',
      messageId: '',
      breakdown: {
        systemPrompt: 320,
        skills: 180,
        tools: 140,
        messages: 460,
        other: 0
      },
      totalEstimated: 1100,
      promptTokensActual: 0,
      capturedAt: 1,
      contextLimit: 200_000
    },
    sessionUsage: {
      totalUncachedInputTokens: 610,
      totalCacheReadTokens: 390,
      totalCacheWriteTokens: 80,
      totalOutputTokens: 120,
      totalPromptTokens: 1000,
      totalCompletionTokens: 120,
      totalCachedTokens: 390,
      hitRate: 0.39,
      lastRoundHitRate: 0.39,
      estimatedSavedInputTokens: 390,
      cacheCountCoverage: { reportedPositive: 1, reportedZero: 0, unreported: 0 }
    },
    ...overrides
  })
}

describe('formatTokens', () => {
  it('正确将 token 数格式化为 K / M / B 国际标准单位，不包含万或亿', () => {
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(-10)).toBe('0')
    expect(formatTokens(NaN)).toBe('0')
    expect(formatTokens(460)).toBe('460')
    expect(formatTokens(999)).toBe('999')
    expect(formatTokens(1_000)).toBe('1K')
    expect(formatTokens(1_100)).toBe('1.1K')
    expect(formatTokens(8_192)).toBe('8.2K')
    expect(formatTokens(32_000)).toBe('32K')
    expect(formatTokens(128_000)).toBe('128K')
    expect(formatTokens(200_000)).toBe('200K')
    expect(formatTokens(1_000_000)).toBe('1M')
    expect(formatTokens(1_500_000)).toBe('1.5M')
    expect(formatTokens(2_000_000)).toBe('2M')
    expect(formatTokens(1_000_000_000)).toBe('1B')
  })
})

describe('ContextIndicator', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    setContextState()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('hover 后在弹层内展示平均缓存命中率与正规 K/M 格式的上下文容量', () => {
    const renderer = renderDom(React.createElement(ContextIndicator))
    const wrap = renderer.container.querySelector<HTMLElement>('.context-indicator-wrap')
    expect(wrap).not.toBeNull()
    act(() => {
      wrap?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
      vi.advanceTimersByTime(100)
    })

    expect(renderer.container.querySelector('.context-popover__total')?.textContent).toBe('1.1K / 200K (0.6%)')
    expect(renderer.container.querySelector('.context-usage__title')?.textContent).toBe('平均缓存命中率')
    expect(renderer.container.querySelector('.context-usage__summary')?.textContent ?? '').toContain('39.0%')
    expect(renderer.container.querySelectorAll('.context-usage__label')).toHaveLength(0)

    renderer.unmount()
  })

  it.each(['provider', 'anchored-estimate'] as const)('展示预算 Owner 的总量、窗口与来源 %s', source => {
    const current = useAppStore.getState().contextBreakdown!
    useAppStore.setState({ contextBreakdown: { ...current, budget: { status: 'compact', estimatedTokens: 400_000,
      contextWindow: 500_000, threshold: 400_000, marginTokens: source === 'provider' ? 0 : 256, source, reason: 'compatible-main-anchor' } } })
    const renderer = renderDom(React.createElement(ContextIndicator))
    act(() => {
      renderer.container.querySelector('.context-indicator-wrap')?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
      vi.advanceTimersByTime(100)
    })
    expect(renderer.container.querySelector('.context-popover__total')?.textContent).toBe('400K / 500K' + (source === 'provider' ? ' 实际' : ' 估算') + ' (80%)')
    renderer.unmount()
  })

  it('本会话还没有 usage 时，在 hover 内明确提示未报告', () => {
    setContextState({ sessionUsage: null })

    const renderer = renderDom(React.createElement(ContextIndicator))
    const wrap = renderer.container.querySelector<HTMLElement>('.context-indicator-wrap')
    expect(wrap).not.toBeNull()
    act(() => {
      wrap?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
      vi.advanceTimersByTime(100)
    })

    // 无 usage 必须显示「未报告」，不得伪装成 0 命中
    expect(renderer.container.querySelector('.context-usage__summary')?.textContent).toBe('未报告')
    expect(renderer.container.querySelector('.context-usage__hint')?.textContent ?? '').toContain('不会把未知显示为 0')

    renderer.unmount()
  })
})
