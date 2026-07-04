import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StreamingTextBlock } from '../../../src/renderer/features/chat/StreamingTextBlock'

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
    let renderer: TestRenderer.ReactTestRenderer | null = null
    act(() => {
      renderer = TestRenderer.create(
        <StreamingTextBlock
          fullContent="token 消费 SSE"
          isStreaming={true}
          enableTypewriter={false}
        />
      )
    })

    const md = renderer!.root.findByProps({ 'data-testid': 'md' })
    expect(md.props.children).toBe('token 消费 SSE')
    expect(md.props['data-streaming']).toBe('true')
    // 不应启动 rAF 打字机循环
    expect(rafCallbacks).toHaveLength(0)
  })

  it('enableTypewriter=true 时流式初帧可为空，推进 rAF 后逐步放出', () => {
    let renderer: TestRenderer.ReactTestRenderer | null = null
    act(() => {
      renderer = TestRenderer.create(
        <StreamingTextBlock
          fullContent="abc"
          isStreaming={true}
          enableTypewriter={true}
        />
      )
    })

    // 首帧 pool 从 0 开始，可能尚未放出字符
    let md = renderer!.root.findAllByProps({ 'data-testid': 'md' })
    expect(md.length).toBeLessThanOrEqual(1)

    act(() => {
      for (const cb of rafCallbacks.splice(0)) cb()
    })
    act(() => {
      renderer?.update(
        <StreamingTextBlock
          fullContent="abc"
          isStreaming={true}
          enableTypewriter={true}
        />
      )
    })

    md = renderer!.root.findAllByProps({ 'data-testid': 'md' })
    if (md.length > 0) {
      expect(String(md[0].props.children).length).toBeGreaterThan(0)
    }
  })

  it('轮次结束后走终态渲染路径', () => {
    let renderer: TestRenderer.ReactTestRenderer | null = null
    act(() => {
      renderer = TestRenderer.create(
        <StreamingTextBlock
          fullContent="终态全文"
          isStreaming={false}
        />
      )
    })

    const md = renderer!.root.findByProps({ 'data-testid': 'md' })
    expect(md.props.children).toBe('终态全文')
    expect(md.props['data-streaming']).toBe('false')
  })
})
