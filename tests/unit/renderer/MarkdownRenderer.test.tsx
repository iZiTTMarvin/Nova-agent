// @vitest-environment jsdom

/**
 * MarkdownRenderer 关键行为测试
 *
 * 验证：
 * 1. 代码高亮是块级渐进门控：sealed 块（含终态）立即高亮，active tail 无高亮
 * 2. 数学语法转译后经代码通路渲染 KaTeX（$$ 块级 / $ 行内）
 * 3. mermaid 围栏：tail 占位不加载，封口/终态触发渲染
 * 4. 链接安全与 chunkFade 等既有行为不回归
 */
import { describe, it, expect, vi, beforeAll } from 'vitest'
import React from 'react'

vi.mock('mermaid', () => {
  const api = { initialize: vi.fn(), render: vi.fn(() => Promise.resolve({ svg: '<svg data-mermaid-mock="1"></svg>' })) }
  return { default: api }
})

import mermaidMock from 'mermaid'
import {
  MarkdownRenderer,
  __takeMarkdownReparseChars
} from '../../../src/renderer/features/chat/MarkdownRenderer'
import { ensureKatexLoaded } from '../../../src/renderer/features/chat/MathBlock'
import { renderDom, waitFor, act } from './renderDom'

const FENCE = '```typescript\nconst x: number = 1\nconst y: string = "hi"\n```'

/** 动态 import 需要宏任务节拍；懒加载组件（KaTeX/mermaid）落地前先给一拍 */
async function flushLazyModules(): Promise<void> {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 10))
  })
}

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

describe('MarkdownRenderer 纯文本围栏与盒绘框图对齐', () => {
  it('无语言围栏与 plaintext 围栏隐藏顶栏 PLAINTEXT 标签，且不对数字或符号做语法染色', () => {
    const doc = [
      '```',
      'planner(温度0.3) → workers (Node ≥18, 6 个运行时依赖)',
      '```',
      '',
      '```plaintext',
      'plain line 42',
      '```'
    ].join('\n')

    const tree = renderDom(<MarkdownRenderer content={doc} isStreaming={false} />)
    const blocks = tree.container.querySelectorAll('.md-code-block')
    expect(blocks.length).toBe(2)
    expect(tree.container.querySelector('.md-code-block__header')).toBeNull()
    expect(tree.container.querySelector('.md-code-block__lang')).toBeNull()
    expect(tree.container.querySelectorAll('.md-code-block--plain').length).toBe(2)
    expect(tree.container.querySelectorAll('.md-code-block__copy--floating').length).toBe(2)
    expect(countDiffTokens(tree.container)).toBe(0)
    tree.unmount()
  })

  it('含盒绘符的中英混排框图锁定中文 2ch 与盒绘 1ch 网格，并自动补偿右侧竖向脊线错位', () => {
    const diagram = [
      '```',
      'CLI (cli.ts)  ──┬──► MiniAgent (agent.ts)   ┐',
      '  readline      │     think→tool→observe 循环  │',
      '  /orchestrate  │     文本模式 / 原生 FC 双模式 ├──► Tools · Skills',
      '                └──► Orchestrator            │     Config · Logger',
      '                      planner(温度0.3) → workers ┘',
      '```'
    ].join('\n')

    const tree = renderDom(<MarkdownRenderer content={diagram} isStreaming={false} />)
    const pre = tree.container.querySelector('.md-code-block__pre--diagram')
    expect(pre).not.toBeNull()

    const cjkNodes = Array.from(tree.container.querySelectorAll<HTMLElement>('.md-diagram-cjk'))
    expect(cjkNodes.length).toBeGreaterThan(0)
    const loopNode = cjkNodes.find(node => node.textContent === '循环')
    expect(loopNode?.style.width).toBe('4ch')

    const boxNodes = Array.from(tree.container.querySelectorAll<HTMLElement>('.md-diagram-box'))
    expect(boxNodes.length).toBeGreaterThan(0)
    const branchNode = boxNodes.find(node => node.textContent === '├──')
    expect(branchNode?.style.width).toBe('3ch')

    const symNodes = Array.from(tree.container.querySelectorAll<HTMLElement>('.md-diagram-sym'))
    expect(symNodes.some(node => node.textContent === '►')).toBe(true)
    expect(symNodes.some(node => node.textContent === '→')).toBe(true)

    // 第 2、3 行因中文与单宽箭头导致右侧竖线多出列偏移，应生成 .md-diagram-pad 自动收敛到同一列
    const padNodes = Array.from(tree.container.querySelectorAll<HTMLElement>('.md-diagram-pad'))
    expect(padNodes.length).toBeGreaterThanOrEqual(2)

    // 复制文本与原文完全一致，不增删任何空格字符
    expect(pre?.textContent).toContain('think→tool→observe 循环  │')
    expect(pre?.textContent).toContain('文本模式 / 原生 FC 双模式 ├──► Tools · Skills')
    tree.unmount()
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
    const checkboxes = tree.container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
    expect(checkboxes.length).toBe(2)
    expect(checkboxes[0]?.checked).toBe(true)
    expect(checkboxes[1]?.checked).toBe(false)
    expect(tree.container.querySelector('blockquote')).not.toBeNull()
    expect(tree.container.querySelector('.md-code-block__pre')).not.toBeNull()
    // 终态代码高亮不变量
    expect(tree.container.querySelectorAll('.diff-token').length).toBeGreaterThan(0)
    tree.unmount()
  })

  it('普通无序列表与 Task List 任务列表共存时结构互不干扰', () => {
    const doc = [
      '### 任务列表',
      '- [x] 任务A',
      '- [ ] 任务B',
      '',
      '### 普通列表',
      '- 普通项1',
      '- 普通项2'
    ].join('\n')
    const tree = renderDom(<MarkdownRenderer content={doc} />)
    // 任务列表应落在 .astryx-checkbox-list 下
    const checkboxList = tree.container.querySelector('.astryx-checkbox-list')
    expect(checkboxList).not.toBeNull()
    expect(checkboxList?.querySelectorAll('input[type="checkbox"]').length).toBe(2)

    // 普通无序列表应落在独立的 .astryx-list (非 checkbox list) 下
    const regularLists = Array.from(tree.container.querySelectorAll('.astryx-list')).filter(
      el => !el.closest('.astryx-checkbox-list')
    )
    expect(regularLists.length).toBe(1)
    expect(regularLists[0]?.querySelectorAll('.astryx-list-item').length).toBe(2)
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

describe('MarkdownRenderer chunkFade（sealed 段逐段淡入）', () => {
  it('chunkFade 开启时，流式增量封口的每个 sealed 段裹 fade wrapper', () => {
    let content = '第一段内容。\n\n'
    const tree = renderDom(<MarkdownRenderer content={content} isStreaming={true} chunkFade />)
    content += '第二段内容。\n\n'
    tree.render(<MarkdownRenderer content={content} isStreaming={true} chunkFade />)
    content += '第三段正在写'
    tree.render(<MarkdownRenderer content={content} isStreaming={true} chunkFade />)
    // 前两段被空行逐步封口为 sealed，各裹 fade；尾段「第三段正在写」是 active tail，不裹
    const fadeWrappers = tree.container.querySelectorAll('.md-sealed-chunk--fade')
    expect(fadeWrappers.length).toBeGreaterThanOrEqual(2)
    tree.unmount()
  })

  it('默认不传 chunkFade 时，sealed 段用普通 wrapper，无 fade class', () => {
    let content = '第一段内容。\n\n'
    const tree = renderDom(<MarkdownRenderer content={content} isStreaming={true} />)
    content += '第二段内容。\n\n'
    tree.render(<MarkdownRenderer content={content} isStreaming={true} />)
    content += '第三段正在写'
    tree.render(<MarkdownRenderer content={content} isStreaming={true} />)
    expect(tree.container.querySelector('.md-sealed-chunk--fade')).toBeNull()
    expect(tree.container.querySelectorAll('.md-sealed-chunk').length).toBeGreaterThan(0)
    tree.unmount()
  })
})

describe('MarkdownRenderer 块级渐进门控', () => {
  it('流式中已封口的代码块立即高亮（sealed 走 complete 组件集）', () => {
    const content = '前文。\n\n```typescript\nconst x: number = 1\n```\n\n结尾还在写'
    const tree = renderDom(<MarkdownRenderer content={content} isStreaming={true} />)
    expect(countDiffTokens(tree.container)).toBeGreaterThan(0)
    tree.unmount()
  })
})

describe('MarkdownRenderer 数学渲染（转译路线 + 真实 KaTeX）', () => {
  beforeAll(async () => {
    await ensureKatexLoaded()
  })

  it('终态 $$ 块转译为 math 围栏并渲染 display 公式，反斜杠保真', () => {
    const content = '公式：\n\n$$\n\\frac{a}{b} + \\sum_{i=1}^n i\n$$\n\n结束'
    const tree = renderDom(<MarkdownRenderer content={content} />)
    expect(tree.container.querySelector('.katex-display')).not.toBeNull()
    // 定界符被转译消费；源码仅存在于 KaTeX 的 MathML annotation（复制/无障碍用）
    expect(tree.container.textContent).not.toContain('$$')
    tree.unmount()
  })

  it('流式行内 $...$ 即时渲染 KaTeX', async () => {
    const tree = renderDom(<MarkdownRenderer content={'价值 $x^2+1$ 左右'} isStreaming={true} />)
    await flushLazyModules()
    await waitFor(() => tree.container.querySelector('.katex') !== null)
    tree.unmount()
  })

  it('流式未闭合 $$ 块保持原文，不误渲染半截公式', () => {
    const tree = renderDom(<MarkdownRenderer content={'$$\n\\frac{a}{b}'} isStreaming={true} />)
    expect(tree.container.querySelector('.katex')).toBeNull()
    expect(tree.container.textContent).toContain('$$')
    tree.unmount()
  })

  it('货币文本不被误判为公式', async () => {
    const tree = renderDom(<MarkdownRenderer content={'价格 $5 和 $10 之间'} isStreaming={true} />)
    await flushLazyModules()
    expect(tree.container.querySelector('.katex')).toBeNull()
    expect(tree.container.textContent).toContain('$5')
    tree.unmount()
  })
})

describe('MarkdownRenderer mermaid 围栏路由', () => {
  it('tail 中未闭合围栏：占位态展示源码，不触发渲染', async () => {
    const tree = renderDom(<MarkdownRenderer content={'```mermaid\ngraph TD\n  A --> B'} isStreaming={true} />)
    expect(tree.container.querySelector('.mermaid-diagram--pending')).not.toBeNull()
    await flushLazyModules()
    expect(mermaidMock.render).not.toHaveBeenCalled()
    tree.unmount()
  })

  it('终态 mermaid 围栏：触发渲染并注入 SVG', async () => {
    const tree = renderDom(<MarkdownRenderer content={'```mermaid\ngraph LR\n  X --> Y\n```'} />)
    await flushLazyModules()
    await waitFor(() => tree.container.querySelector('[data-mermaid-mock="1"]') !== null)
    tree.unmount()
  })
})

describe('MarkdownRenderer 表格行内代码中的竖线', () => {
  const TABLE = [
    '| 模块 | 要点 |',
    '| --- | --- |',
    '| 安全网关 | 拦截 `rm -rf` / `curl | sh`，弹窗确认 |',
    '| 转义 | `a \\| b` 与 `x | y` |',
    '',
    '正文 `p | q` 不在表格里'
  ].join('\n')

  it.each([false, true])('isStreaming=%s 时代码段内的竖线不切列，原样显示', (isStreaming) => {
    const renderer = renderDom(<MarkdownRenderer content={TABLE} isStreaming={isStreaming} />)
    const rows = Array.from(renderer.container.querySelectorAll('tr'))
    expect(rows).toHaveLength(3)
    for (const row of rows) {
      expect(row.querySelectorAll('th, td')).toHaveLength(2)
    }
    const codes = Array.from(renderer.container.querySelectorAll('code')).map(node => node.textContent)
    expect(codes).toEqual(expect.arrayContaining(['curl | sh', 'a | b', 'x | y', 'p | q']))
    expect(renderer.container.textContent).not.toContain('\uE000')
    renderer.unmount()
  })
})
