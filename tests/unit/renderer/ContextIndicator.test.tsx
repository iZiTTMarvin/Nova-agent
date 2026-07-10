import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ContextIndicator } from '../../../src/renderer/features/chat/ContextIndicator'
import { useAppStore } from '../../../src/renderer/stores/useAppStore'

vi.mock('framer-motion', () => import('./_framerMotionMock'))

function setContextState(overrides?: Partial<{
  sessionUsage: {
    totalPromptTokens: number
    totalCompletionTokens: number
    totalCachedTokens: number
    totalCacheWriteTokens: number
    hitRate: number
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
      totalPromptTokens: 1000,
      totalCompletionTokens: 120,
      totalCachedTokens: 390,
      totalCacheWriteTokens: 80,
      hitRate: 0.39
    },
    ...overrides
  })
}

describe('ContextIndicator', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    global.window = {
      ...(global.window ?? {}),
      setTimeout,
      clearTimeout
    } as unknown as Window & typeof globalThis
    setContextState()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('hover 后在弹层内展示本会话用量明细', () => {
    let renderer: TestRenderer.ReactTestRenderer | null = null
    act(() => {
      renderer = TestRenderer.create(React.createElement(ContextIndicator))
    })

    const wrap = renderer!.root.findByProps({ className: 'context-indicator-wrap' })
    act(() => {
      wrap.props.onMouseEnter()
      vi.advanceTimersByTime(100)
    })

    expect(renderer!.root.findByProps({ className: 'context-usage__title' }).children).toEqual(['本会话用量'])
    expect(renderer!.root.findByProps({ className: 'context-usage__summary' }).children.join('')).toContain('39.0%')

    const labels = renderer!.root
      .findAllByProps({ className: 'context-usage__label' })
      .map(node => node.children.join(''))
    expect(labels).toEqual(['输入', '输出', '缓存命中', '缓存写入', '总消耗'])

    act(() => {
      renderer?.unmount()
    })
  })

  it('本会话还没有 usage 时，在 hover 内明确提示未报告', () => {
    setContextState({ sessionUsage: null })

    let renderer: TestRenderer.ReactTestRenderer | null = null
    act(() => {
      renderer = TestRenderer.create(React.createElement(ContextIndicator))
    })

    const wrap = renderer!.root.findByProps({ className: 'context-indicator-wrap' })
    act(() => {
      wrap.props.onMouseEnter()
      vi.advanceTimersByTime(100)
    })

    // T1-3：无 usage 必须显示「未报告」，不得伪装成 0 命中
    expect(renderer!.root.findByProps({ className: 'context-usage__summary' }).children).toEqual(['未报告'])
    expect(renderer!.root.findByProps({ className: 'context-usage__hint' }).children.join('')).toContain('不会把未知显示为 0')

    act(() => {
      renderer?.unmount()
    })
  })
})
