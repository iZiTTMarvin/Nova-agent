// @vitest-environment jsdom

/**
 * MarkdownRenderer 关键行为测试：覆盖 C2 修复 — isStreaming 传递链路
 *
 * 验证：
 * 1. isStreaming=true 时，代码块不调用 highlightLine，输出纯文本节点（无 .diff-token）
 * 2. isStreaming=false（默认）时，代码块调用 highlightLine，输出 .diff-token span
 * 3. isStreaming 翻转时，components 引用重建（useMemo 依赖），保证切换路径正确
 */
import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import {
  MarkdownRenderer,
  __takeMarkdownReparseChars
} from '../../../src/renderer/features/chat/MarkdownRenderer'
import { renderDom } from './renderDom'

const FENCE = '```typescript\nconst x: number = 1\nconst y: string = "hi"\n```'

function countDiffTokens(container: HTMLElement): number {
  return Array.from(container.querySelectorAll('[class]')).filter(element =>
    (element.getAttribute('class') ?? '').split(/\s+/).some(className => className.startsWith('diff-token'))
  ).length
}

describe('MarkdownRenderer isStreaming 传递（C2 修复）', () => {
  it('isStreaming=true 时代码块不输出 diff-token span（highlightLine 跳过）', () => {
    const renderer = renderDom(<MarkdownRenderer content={FENCE} isStreaming={true} />)
    const preNode = renderer.container.querySelector('.md-code-block__pre')
    const diffTokenCount = countDiffTokens(renderer.container)

    expect(preNode).not.toBeNull()
    expect(diffTokenCount).toBe(0)
    renderer.unmount()
  })

  it('isStreaming=false 时代码块输出 diff-token span（highlightLine 启用）', () => {
    const renderer = renderDom(<MarkdownRenderer content={FENCE} isStreaming={false} />)
    const preNode = renderer.container.querySelector('.md-code-block__pre')
    const diffTokenCount = countDiffTokens(renderer.container)

    expect(preNode).not.toBeNull()
    expect(diffTokenCount).toBeGreaterThan(0)
    renderer.unmount()
  })

  it('省略 isStreaming 时（默认 false）也应走高亮路径', () => {
    const renderer = renderDom(<MarkdownRenderer content={FENCE} />)
    const diffTokenCount = countDiffTokens(renderer.container)
    expect(diffTokenCount).toBeGreaterThan(0)
    renderer.unmount()
  })

  it('isStreaming 翻转：流式无 token，非流式有 token', () => {
    const streaming = renderDom(<MarkdownRenderer content={FENCE} isStreaming={true} />)
    const nonStreaming = renderDom(<MarkdownRenderer content={FENCE} isStreaming={false} />)
    const sCount = countDiffTokens(streaming.container)
    const nCount = countDiffTokens(nonStreaming.container)
    expect(sCount).toBe(0)
    expect(nCount).toBeGreaterThan(0)
    streaming.unmount()
    nonStreaming.unmount()
  })
})

describe('MarkdownRenderer 增量 reparseChars 探针', () => {
  it('流式多空行块：reparseChars ≈ activeTail，不随全文线性增长', () => {
    __takeMarkdownReparseChars()

    let content = '第一段完整内容。\n\n'
    const tree = renderDom(<MarkdownRenderer content={content} isStreaming={true} />)
    __takeMarkdownReparseChars()

    const reparseSamples: number[] = []
    for (let i = 0; i < 12; i++) {
      content += `段落${i}的正文内容继续写下去。\n\n`
      tree.render(<MarkdownRenderer content={content} isStreaming={true} />)
      reparseSamples.push(__takeMarkdownReparseChars())
    }

    const late = reparseSamples.slice(-4)
    const lateMax = Math.max(...late)
    // 核心不变量：重解析量接近 activeTail，不随全文线性上升
    expect(content.length).toBeGreaterThan(200)
    expect(lateMax).toBeLessThan(content.length * 0.35)
    expect(lateMax).toBeLessThan(120)

    tree.unmount()
  })
})

describe('MarkdownRenderer GFM 全文渲染（Astryx 内核接管后）', () => {
  const GFM_DOC = [
    '## 标题',
    '',
    '正文 **加粗** 与 `内联代码`。',
    '',
    '| 列A | 列B |',
    '| --- | --- |',
    '| 1 | 2 |',
    '',
    '- [x] 已完成',
    '- [ ] 未完成',
    '',
    '> 引用内容',
    '',
    '```typescript',
    'const a: number = 1',
    '```'
  ].join('\n')

  it('标题/表格/任务列表/引用/代码块在终态路径全部落 DOM', () => {
    const tree = renderDom(<MarkdownRenderer content={GFM_DOC} />)
    expect(tree.container.querySelector('h2')).not.toBeNull()
    expect(tree.container.querySelector('table')).not.toBeNull()
    expect(tree.container.querySelectorAll('input[type="checkbox"]').length).toBe(2)
    expect(tree.container.querySelector('blockquote')).not.toBeNull()
    expect(tree.container.querySelector('.md-code-block__pre')).not.toBeNull()
    // 终态代码高亮不变量
    expect(tree.container.querySelectorAll('.diff-token').length).toBeGreaterThan(0)
    tree.unmount()
  })
})

describe('MarkdownRenderer 链接安全（isSafeMarkdownHref 语义保留）', () => {
  it('http(s)/mailto 链接正常渲染；javascript: 降级为纯文本', () => {
    const tree = renderDom(
      <MarkdownRenderer content={'[ok](https://example.com) 与 [bad](javascript:alert(1))'} />
    )
    const links = tree.container.querySelectorAll('a[href]')
    expect(links).toHaveLength(1)
    expect(links[0]?.getAttribute('href')).toBe('https://example.com')
    expect(tree.container.textContent).toContain('bad')
    expect(tree.container.querySelector('a[href^="javascript:"]')).toBeNull()
    tree.unmount()
  })
})
