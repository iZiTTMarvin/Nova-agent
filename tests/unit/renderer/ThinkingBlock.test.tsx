// @vitest-environment jsdom

/**
 * ThinkingBlock 行为测试：状态/计时/折叠/粘性/auto-scroll/chunkFade 传递
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import React from 'react'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { ThinkingBlock } from '../../../src/renderer/features/chat/ThinkingBlock'
import {
  markThinkingEndedForMessage,
  markThinkingStarted,
  readThinkingElapsedSec,
  resetThinkingTimingMemory
} from '../../../src/renderer/lib/thinkingTimingMemory'
import { act, renderDom } from './renderDom'

vi.mock('../../../src/renderer/features/chat/MarkdownRenderer', () => ({
  MarkdownRenderer: ({
    content,
    isStreaming,
    chunkFade
  }: {
    content: string
    isStreaming: boolean
    chunkFade?: boolean
  }) => (
    <div
      data-testid="md"
      data-streaming={String(isStreaming)}
      data-chunkfade={String(chunkFade ?? false)}
    >
      {content}
    </div>
  )
}))

beforeEach(() => {
  vi.useFakeTimers()
  resetThinkingTimingMemory()
})
afterEach(() => {
  vi.useRealTimers()
  resetThinkingTimingMemory()
})

describe('ThinkingBlock 状态与计时', () => {
  it('无 thinking 内容时不渲染', () => {
    const r = renderDom(<ThinkingBlock thinking="" active={false} />)
    expect(r.container.querySelector('.thinking-block')).toBeNull()
    expect(r.container.textContent).toBe('')
    r.unmount()
  })

  it('active 时标题仅为 Thinking…，不显示耗时，挂 shimmer，并向 MarkdownRenderer 传 isStreaming 与 chunkFade', () => {
    const r = renderDom(<ThinkingBlock thinking="正在分析" active={true} />)
    const title = r.container.querySelector('.thinking-block__title')
    expect(title?.textContent).toBe('Thinking…')
    expect(r.container.querySelector('.thinking-block__title--shimmer')).not.toBeNull()

    const md = r.container.querySelector('[data-testid="md"]')
    expect(md?.getAttribute('data-streaming')).toBe('true')
    expect(md?.getAttribute('data-chunkfade')).toBe('true')
    r.unmount()
  })

  it('非 active 且无耗时来源时（旧消息）标题仅为 Thought，不伪造 0s', () => {
    const r = renderDom(<ThinkingBlock thinking="已完成" active={false} />)
    const title = r.container.querySelector('.thinking-block__title')
    expect(title?.textContent).toBe('Thought')
    expect(r.container.querySelector('.thinking-block__title--shimmer')).toBeNull()
    expect(r.container.querySelector('[data-testid="md"]')?.getAttribute('data-streaming')).toBe('false')
    r.unmount()
  })

  it('计时：active 期间标题仍为 Thinking…，不提前露出耗时', () => {
    const r = renderDom(<ThinkingBlock thinking="思考中" active={true} />)
    act(() => {
      vi.advanceTimersByTime(1500)
    })
    expect(r.container.querySelector('.thinking-block__title')?.textContent).toBe('Thinking…')
    r.unmount()
  })

  it('结束：补算最终耗时并切换为 Thought for Xs', () => {
    const r = renderDom(<ThinkingBlock thinking="思考中" active={true} />)
    act(() => {
      vi.advanceTimersByTime(3200)
    })
    r.render(<ThinkingBlock thinking="思考中" active={false} />)
    const title = r.container.querySelector('.thinking-block__title')
    expect(title?.textContent).toBe('Thought for 3.2s')
    r.unmount()
  })

  it('有 messageId 时，即使 remount 后 active=false 仍显示 memory 中的耗时', () => {
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
    markThinkingStarted('msg_remount', 0)
    vi.setSystemTime(new Date('2026-01-01T00:00:02.500Z'))
    markThinkingEndedForMessage('msg_remount')

    const r = renderDom(
      <ThinkingBlock thinking="已完成" active={false} messageId="msg_remount" blockIndex={0} />
    )
    expect(r.container.querySelector('.thinking-block__title')?.textContent).toBe('Thought for 2.5s')
    r.unmount()
  })

  it('非 active 的前一段思考不会把后一段正在计时的耗时打成 0', () => {
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
    markThinkingStarted('msg_two', 0)
    vi.setSystemTime(new Date('2026-01-01T00:00:01.600Z'))
    markThinkingEndedForMessage('msg_two')
    markThinkingStarted('msg_two', 2)
    vi.setSystemTime(new Date('2026-01-01T00:00:02.200Z'))

    const r = renderDom(
      <ThinkingBlock thinking="第一段" active={false} messageId="msg_two" blockIndex={0} />
    )
    expect(readThinkingElapsedSec('msg_two', 2)).toBeCloseTo(0.6, 5)
    r.unmount()
  })

  it('持久化 durationMs 优先于本地 0，重启后仍显示 Thought for Xs', () => {
    const r = renderDom(
      <ThinkingBlock
        thinking="已完成"
        active={false}
        messageId="msg_persisted"
        blockIndex={0}
        durationMs={3400}
      />
    )
    expect(r.container.querySelector('.thinking-block__title')?.textContent).toBe('Thought for 3.4s')
    r.unmount()
  })
})

describe('ThinkingBlock 折叠与粘性', () => {
  it('active 自动展开，结束自动收起', () => {
    const r = renderDom(<ThinkingBlock thinking="x" active={true} />)
    expect(r.container.querySelector('.thinking-block__summary')?.getAttribute('aria-expanded')).toBe('true')
    expect(r.container.querySelector('.thinking-block__collapsible--collapsed')).toBeNull()

    r.render(<ThinkingBlock thinking="x" active={false} />)
    expect(r.container.querySelector('.thinking-block__summary')?.getAttribute('aria-expanded')).toBe('false')
    expect(r.container.querySelector('.thinking-block__collapsible--collapsed')).not.toBeNull()
    r.unmount()
  })

  it('粘性：手动收起后，后续 active 变化不再强制改其选择', () => {
    const r = renderDom(<ThinkingBlock thinking="x" active={true} />)
    const btn = r.container.querySelector('.thinking-block__summary') as HTMLButtonElement
    act(() => {
      btn.click()
    })
    expect(r.container.querySelector('.thinking-block__summary')?.getAttribute('aria-expanded')).toBe('false')

    r.render(<ThinkingBlock thinking="x" active={false} />)
    expect(r.container.querySelector('.thinking-block__summary')?.getAttribute('aria-expanded')).toBe('false')

    r.render(<ThinkingBlock thinking="x" active={true} />)
    expect(r.container.querySelector('.thinking-block__summary')?.getAttribute('aria-expanded')).toBe('false')
    r.unmount()
  })
})

describe('ThinkingBlock auto-scroll', () => {
  const stubViewport = (el: HTMLDivElement) => {
    let scrollTopVal = 0
    Object.defineProperty(el, 'scrollHeight', { configurable: true, value: 1000 })
    Object.defineProperty(el, 'scrollTop', {
      configurable: true,
      get: () => scrollTopVal,
      set: (v: number) => {
        scrollTopVal = v
      }
    })
  }

  it('active 且展开时，内容增长把视窗钉到底部', () => {
    const r = renderDom(<ThinkingBlock thinking="第一段" active={true} />)
    const viewport = r.container.querySelector('.thinking-block__markdown') as HTMLDivElement
    stubViewport(viewport)
    r.render(<ThinkingBlock thinking={'第一段\n又长了一截内容继续'} active={true} />)
    expect(viewport.scrollTop).toBe(1000)
    r.unmount()
  })

  it('非 active 时内容增长不触发钉底', () => {
    const r = renderDom(<ThinkingBlock thinking="第一段" active={false} />)
    const viewport = r.container.querySelector('.thinking-block__markdown') as HTMLDivElement
    stubViewport(viewport)
    r.render(<ThinkingBlock thinking={'第一段\n又长'} active={false} />)
    expect(viewport.scrollTop).toBe(0)
    r.unmount()
  })
})

describe('ThinkingBlock.css 视觉契约', () => {
  const css = readFileSync(
    resolve(process.cwd(), 'src/renderer/features/chat/ThinkingBlock.css'),
    'utf8'
  )
  it('shimmer 扫光 keyframes 存在', () => {
    expect(css).toMatch(/@keyframes\s+thinking-shine/)
  })
  it('左侧竖线 + 透明底，字色通过重定义 Astryx 正文主色 token 变为 muted', () => {
    expect(css).toMatch(/\.thinking-block__content[\s\S]*border-left:\s*2px/)
    expect(css).toMatch(/\.thinking-block__content[\s\S]*background:\s*transparent/)
    // token 桥接：改 --color-text-primary 的解析值，而非用 * 选择器打优先级战争
    expect(css).toMatch(/\.thinking-block__markdown\s*\{[^}]*--color-text-primary:\s*var\(--text-muted/)
    expect(css).not.toMatch(/\.markdown-body\s+\*[\s\S]*?color/)
  })
  it('可见细滚动条存在，且无顶底 mask 渐隐', () => {
    expect(css).toMatch(/scrollbar-width:\s*thin/)
    expect(css).not.toMatch(/mask-image/)
    expect(css).not.toMatch(/-webkit-mask-image/)
  })
  it('prefers-reduced-motion 降级块存在', () => {
    expect(css).toMatch(/@media\s*\(\s*prefers-reduced-motion:\s*reduce\s*\)/)
  })
  it('grid 折叠 0fr/1fr 存在', () => {
    expect(css).toMatch(/grid-template-rows:\s*1fr/)
    expect(css).toMatch(/grid-template-rows:\s*0fr/)
  })
})
