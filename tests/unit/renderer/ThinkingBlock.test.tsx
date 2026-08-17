// @vitest-environment jsdom

/**
 * ThinkingBlock 行为测试：单行流式吐字/状态/计时/点击折叠展开
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

describe('ThinkingBlock 单行流式与状态', () => {
  it('无 thinking 内容时不渲染', () => {
    const r = renderDom(<ThinkingBlock thinking="" active={false} />)
    expect(r.container.querySelector('.thinking-block')).toBeNull()
    expect(r.container.textContent).toBe('')
    r.unmount()
  })

  it('active 时在单行内展示最新流式内容，不默认展开大卡片', () => {
    const r = renderDom(<ThinkingBlock thinking={'第一句\n正在分析第二句'} active={true} />)
    const title = r.container.querySelector('.thinking-block__title')
    expect(title?.textContent).toBe('Think')
    const lineText = r.container.querySelector('.thinking-block__line-text')
    expect(lineText?.textContent).toBe('正在分析第二句')
    expect(r.container.querySelector('.thinking-block__collapsible')).toBeNull()
    r.unmount()
  })

  it('非 active 时单行展示首行摘要', () => {
    const r = renderDom(<ThinkingBlock thinking={'思考总结第一句\n后面更多分析'} active={false} />)
    const lineText = r.container.querySelector('.thinking-block__line-text')
    expect(lineText?.textContent).toBe('思考总结第一句')
    expect(r.container.querySelector('.thinking-block__collapsible')).toBeNull()
    r.unmount()
  })

  it('计时与 memory 联动', () => {
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
    markThinkingStarted('msg_remount', 0)
    vi.setSystemTime(new Date('2026-01-01T00:00:02.500Z'))
    markThinkingEndedForMessage('msg_remount')

    const r = renderDom(
      <ThinkingBlock thinking="已完成" active={false} messageId="msg_remount" blockIndex={0} />
    )
    expect(readThinkingElapsedSec('msg_remount', 0)).toBeCloseTo(2.5, 5)
    r.unmount()
  })
})

describe('ThinkingBlock 点击展开与折叠', () => {
  it('默认折叠，点击后展开完整 Markdown 详情，再次点击收起', () => {
    const r = renderDom(<ThinkingBlock thinking="完整思考内容" active={false} />)
    expect(r.container.querySelector('.thinking-block__collapsible')).toBeNull()

    const btn = r.container.querySelector('.thinking-block__summary') as HTMLButtonElement
    act(() => {
      btn.click()
    })
    expect(r.container.querySelector('.thinking-block__collapsible')).not.toBeNull()
    const md = r.container.querySelector('[data-testid="md"]')
    expect(md?.textContent).toBe('完整思考内容')

    act(() => {
      btn.click()
    })
    expect(r.container.querySelector('.thinking-block__collapsible')).toBeNull()
    r.unmount()
  })
})

describe('ThinkingBlock.css 视觉契约', () => {
  const css = readFileSync(
    resolve(process.cwd(), 'src/renderer/features/chat/ThinkingBlock.css'),
    'utf8'
  )
  it('单行高度 28px 锁定', () => {
    expect(css).toMatch(/height:\s*28px/)
    expect(css).toMatch(/white-space:\s*nowrap/)
  })
  it('左侧竖线 + 透明底，展开后有细滚动条', () => {
    expect(css).toMatch(/\.thinking-block__content[\s\S]*border-left:\s*2px/)
    expect(css).toMatch(/\.thinking-block__content[\s\S]*background:\s*transparent/)
    expect(css).toMatch(/scrollbar-width:\s*thin/)
  })
})
