// @vitest-environment jsdom

import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ContextIndicator } from '../../../src/renderer/features/chat/ContextIndicator'
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
      estimatedSavedInputTokens: 390
    },
    ...overrides
  })
}

describe('ContextIndicator', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    setContextState()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('hover 后在弹层内展示平均缓存命中率', () => {
    const renderer = renderDom(React.createElement(ContextIndicator))
    const wrap = renderer.container.querySelector<HTMLElement>('.context-indicator-wrap')
    expect(wrap).not.toBeNull()
    act(() => {
      wrap?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
      vi.advanceTimersByTime(100)
    })

    expect(renderer.container.querySelector('.context-usage__title')?.textContent).toBe('平均缓存命中率')
    expect(renderer.container.querySelector('.context-usage__summary')?.textContent ?? '').toContain('39.0%')
    expect(renderer.container.querySelectorAll('.context-usage__label')).toHaveLength(0)

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
