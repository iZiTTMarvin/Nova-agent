// @vitest-environment jsdom

import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StreamingTextBlock } from '../../../src/renderer/features/chat/StreamingTextBlock'
import { act, renderDom } from './renderDom'

vi.mock('../../../src/renderer/features/chat/MarkdownRenderer', () => ({
  MarkdownRenderer: ({ content, isStreaming }: { content: string; isStreaming: boolean }) => (
    <div data-testid="md" data-streaming={String(isStreaming)}>{content}</div>
  )
}))

describe('StreamingTextBlock', () => {
  let rafCallbacks: Array<() => void> = []
  const originalRaf = globalThis.requestAnimationFrame
  const originalCancelRaf = globalThis.cancelAnimationFrame

  beforeEach(() => {
    rafCallbacks = []
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      rafCallbacks.push(cb as () => void)
      return rafCallbacks.length
    }) as typeof globalThis.requestAnimationFrame
    globalThis.cancelAnimationFrame = (() => {}) as typeof globalThis.cancelAnimationFrame
  })

  afterEach(() => {
    globalThis.requestAnimationFrame = originalRaf
    globalThis.cancelAnimationFrame = originalCancelRaf
  })

  it('轮次进行中但 enableTypewriter=false 时立刻展示全文，不走打字机切片', () => {
    const renderer = renderDom(
      <StreamingTextBlock
        fullContent="token 消费 SSE"
        isStreaming={true}
        enableTypewriter={false}
      />
    )

    const md = renderer.container.querySelector<HTMLElement>('[data-testid="md"]')
    expect(md?.textContent).toBe('token 消费 SSE')
    expect(md?.getAttribute('data-streaming')).toBe('true')
    // 不应启动 rAF 打字机循环
    expect(rafCallbacks).toHaveLength(0)
    renderer.unmount()
  })

  it('默认 agile 在流式期间立即展示已收到全文，不启动逐字放出', () => {
    const renderer = renderDom(
      <StreamingTextBlock
        fullContent="abc"
        isStreaming={true}
        enableTypewriter={true}
      />
    )

    const md = renderer.container.querySelector<HTMLElement>('[data-testid="md"]')
    expect(md?.textContent).toBe('abc')
    expect(rafCallbacks).toHaveLength(0)
    renderer.unmount()
  })

  it('elegant 在流式期间保留逐步放出节奏', () => {
    const renderer = renderDom(
      <StreamingTextBlock
        fullContent="abc"
        isStreaming={true}
        enableTypewriter={true}
        style="elegant"
      />
    )

    expect(renderer.container.textContent).toBe('')
    expect(rafCallbacks).toHaveLength(1)

    act(() => {
      for (const cb of rafCallbacks.splice(0)) cb()
    })
    expect((renderer.container.textContent ?? '').length).toBeGreaterThan(0)
    renderer.unmount()
  })

  it('轮次结束后走终态渲染路径', () => {
    const renderer = renderDom(
      <StreamingTextBlock
        fullContent="终态全文"
        isStreaming={false}
      />
    )

    const md = renderer.container.querySelector<HTMLElement>('[data-testid="md"]')
    expect(md?.textContent).toBe('终态全文')
    expect(md?.getAttribute('data-streaming')).toBe('false')
    renderer.unmount()
  })
})
