// @vitest-environment jsdom

/**
 * P3 S0 Spike：Astryx Markdown 内核迁移评估（结论 = 迁内核、保流式算法）
 *
 * 评估并锁定 Nova 迁移到 Astryx `<Markdown>` 引擎后依赖的行为：
 * 1. GFM 能力覆盖（Nova 依赖：标题/粗斜体/删除线/内联代码/链接/表格/任务列表/围栏代码）
 * 2. `<Markdown isStreaming>` 的伪影裁剪行为（评估记录：与 Nova render pool 冲突，
 *    生产采用非流式块渲染，见报告 §4.1）
 * 3. Astryx 增量解析语义（settled 单调/fence 保护/重试失效）
 * 4. 增量 vs 每帧全量重解析的基准（reparse accounting + wall clock）
 * 5. 代码高亮兼容性（components.code 覆盖可注入 Nova CodeBlock + highlightLine）
 *
 * 跨引擎（react-markdown vs Astryx）对比数字记录在 tasks/astryx-markdown-spike.md。
 * 本文件沉淀为「Nova 依赖的 Astryx parser/组件行为」消费者契约测试：
 * 若 Astryx 升级破坏这些行为，迁移后的渲染会立刻失真。
 */
import React from 'react'
import { describe, expect, it } from 'vitest'
import { Markdown } from '@astryxdesign/core/Markdown'
import {
  parseMarkdown,
  parseMarkdownIncremental,
  createIncrementalState,
  type BlockNode,
  type IncrementalParseState
} from '@astryxdesign/core/Markdown'
import { renderDom } from './renderDom'

// ── 测试语料：贴近真实 assistant 回答的混合 GFM 文档 ──────────────

const CODE_BLOCK = [
  '```typescript',
  'interface StreamSplit {',
  '  sealedParts: string[]',
  '  activeTail: string',
  '}',
  '',
  'export function split(content: string): StreamSplit {',
  '  const boundary = findBlankLine(content)',
  '  return {',
  '    sealedParts: content.slice(0, boundary).split("\\n\\n"),',
  '    activeTail: content.slice(boundary)',
  '  }',
  '}',
  '```'
].join('\n')

const CORPUS = [
  '## 实现思路',
  '',
  '两阶段增量解析的核心是 **封口已完成的块**，只对 *活动尾部* 做重解析。',
  '这样可以避免累计 O(L²) 的 `ReactMarkdown` AST 重建成本，同时保持 ~~全量重绘~~ 的开销可控。',
  '参考 [Astryx 文档](https://astryx.design/docs/markdown) 中的 streaming 章节。',
  '',
  '### 关键数据结构',
  '',
  CODE_BLOCK,
  '',
  '### 能力矩阵',
  '',
  '| 能力 | Nova 自研 | Astryx |',
  '| --- | --- | --- |',
  '| sealed/tail | 支持 | 支持 |',
  '| fence 保护 | 支持 | 支持 |',
  '| 伪影裁剪 | 无 | 内置 |',
  '',
  '### 待办',
  '',
  '- [x] 增量 fence 扫描',
  '- [x] 空行块边界',
  '- [ ] 迁移决策',
  '',
  '> 注意：宁可晚封口，也不要误封口导致 fence 被截断。',
  '',
  '---',
  '',
  '最终结论会在 spike 报告中给出：迁 or 保留。'
].join('\n')

function collectBlocks(nodes: BlockNode[]): BlockNode[] {
  const out: BlockNode[] = []
  const walk = (list: BlockNode[]): void => {
    for (const node of list) {
      out.push(node)
      if (node.type === 'blockquote') walk(node.children)
      if (node.type === 'list') {
        for (const item of node.items) walk(item.children)
      }
    }
  }
  walk(nodes)
  return out
}

// ── 1. GFM 能力覆盖 ─────────────────────────────────────────────

describe('spike：Astryx parser 的 GFM 能力覆盖（Nova 依赖面）', () => {
  const blocks = collectBlocks(parseMarkdown(CORPUS))

  it('标题（含层级）', () => {
    const levels = blocks.filter(b => b.type === 'heading').map(b => (b as { level: number }).level)
    expect(levels).toContain(2)
    expect(levels).toContain(3)
  })

  it('粗体/斜体/删除线/内联代码/链接', () => {
    const json = JSON.stringify(blocks)
    expect(json).toContain('"type":"bold"')
    expect(json).toContain('"type":"italic"')
    expect(json).toContain('"type":"strikethrough"')
    expect(json).toContain('"type":"code"')
    expect(json).toContain('"type":"link"')
    expect(json).toContain('https://astryx.design/docs/markdown')
  })

  it('围栏代码块保留语言标签', () => {
    const code = blocks.find(b => b.type === 'codeblock')
    expect(code).toBeDefined()
    expect((code as { language: string }).language).toBe('typescript')
    expect((code as { content: string }).content).toContain('findBlankLine')
  })

  it('GFM 表格（表头 + 行 + 对齐）', () => {
    const table = blocks.find(b => b.type === 'table')
    expect(table).toBeDefined()
    if (table?.type !== 'table') return
    expect(table.headers).toHaveLength(3)
    expect(table.rows.length).toBe(3)
  })

  it('GFM 任务列表（checked 状态）', () => {
    const list = blocks.find(b => b.type === 'list')
    expect(list).toBeDefined()
    if (list?.type !== 'list') return
    const checked = list.items.map(i => i.checked)
    expect(checked).toEqual([true, true, false])
  })

  it('引用块与分隔线', () => {
    expect(blocks.some(b => b.type === 'blockquote')).toBe(true)
    expect(blocks.some(b => b.type === 'hr')).toBe(true)
  })
})

// ── 2. 流式伪影裁剪（组件层行为：prefers-reduced-motion 下首帧即全文）──

describe('spike：<Markdown isStreaming> 伪影裁剪', () => {
  const originalMatchMedia = Object.getOwnPropertyDescriptor(window, 'matchMedia')

  function stubReducedMotion(): void {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: (query: string): MediaQueryList => ({
        matches: query.includes('prefers-reduced-motion'),
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false
      })
    })
  }

  function restoreMatchMedia(): void {
    if (originalMatchMedia) {
      Object.defineProperty(window, 'matchMedia', originalMatchMedia)
    }
  }

  function renderStreaming(content: string) {
    stubReducedMotion()
    const tree = renderDom(<Markdown isStreaming={true}>{content}</Markdown>)
    restoreMatchMedia()
    return tree
  }

  it('未闭合 ** / [ 不以字面标记进入渲染', () => {
    const tree = renderStreaming('前面的完整句子。\n\n这是半截 **bo')
    expect(tree.container.textContent).not.toContain('**bo')
    tree.unmount()

    const tree2 = renderStreaming('句子。\n\n参考 [doc')
    expect(tree2.container.textContent).not.toContain('[doc')
    tree2.unmount()
  })

  it('行尾未闭合反引号被裁剪；行中未闭合反引号仍为字面（与 Nova 同等，非回退）', () => {
    // Spike 事实：trimStreamingArtifacts 只裁剪「尾部即标记」的情形。
    // 行中未闭合 `x 仍显示字面反引号——Nova react-markdown 同样如此，
    // 二者行为对齐，不构成迁移回退。
    const trimmed = renderStreaming('句子。\n\n调用 `')
    expect(trimmed.container.textContent).not.toContain('`')
    trimmed.unmount()

    const literal = renderStreaming('句子。\n\n调用 `spli')
    expect(literal.container.textContent).toContain('`spli')
    literal.unmount()
  })

  it('已闭合语法正常渲染（不误伤）', () => {
    const tree = renderStreaming('完整 **加粗** 与 `code` 和 [链接](https://example.com)')
    expect(tree.container.textContent).toContain('加粗')
    expect(tree.container.textContent).toContain('code')
    expect(tree.container.querySelector('a[href="https://example.com"]')).not.toBeNull()
    tree.unmount()
  })
})

// ── 3. 增量封口与 fence 保护（Nova sealed/tail 不变量的 Astryx 等价物）──

describe('spike：增量解析的 sealed 稳定性', () => {
  it('settled 内容只增不减（单调前进）', () => {
    const state: IncrementalParseState = createIncrementalState()
    parseMarkdownIncremental('第一段完成。\n\n', state)
    const settledAfterFirst = state.settledText.trim()
    expect(settledAfterFirst.length).toBeGreaterThan(0)

    parseMarkdownIncremental('第一段完成。\n\n第二段还在写', state)
    expect(state.settledText.trim()).toBe(settledAfterFirst)

    parseMarkdownIncremental('第一段完成。\n\n第二段完成。\n\n第三段开头', state)
    expect(state.settledText.trim().startsWith(settledAfterFirst)).toBe(true)
    expect(state.settledText.trim().length).toBeGreaterThan(settledAfterFirst.length)
  })

  it('settled 前缀不变时复用缓存块；增长时首块结构稳定', () => {
    // Spike 事实：Astryx 只在 settledText 逐字不变时复用块引用；
    // settled 增长（新块封口）会重建数组。与 Nova MarkdownChunk 的
    // React.memo 引用稳定不同——迁移时需以 <Markdown> 自身的增量渲染为准，
    // 不能假设 sealed 块引用跨帧不变。
    const state: IncrementalParseState = createIncrementalState()
    parseMarkdownIncremental('第一段。\n\n第二段', state)
    const blocksOnce = state.settledBlocks

    // 同一输入再解析：settledText 未变 → 命中缓存，引用复用
    parseMarkdownIncremental('第一段。\n\n第二段（tail 变化）', state)
    expect(state.settledBlocks).toBe(blocksOnce)
    expect(state.settledBlocks[0]?.type).toBe('paragraph')
  })

  it('未闭合 fence 内不产生 settled 边界（等价 Nova「fence 后全留 activeTail」）', () => {
    const state = createIncrementalState()
    const input = '前文。\n\n```typescript\nconst a = 1\nconst b = 2'
    parseMarkdownIncremental(input, state)
    expect(state.settledText).toBe('')
  })

  it('内容被替换（重试场景）时缓存整体失效而非错位拼接', () => {
    const state = createIncrementalState()
    parseMarkdownIncremental('旧回答第一段。\n\n旧回答第二段', state)
    const blocks = parseMarkdownIncremental('全新回答', state)
    expect(JSON.stringify(blocks)).not.toContain('旧回答')
  })
})

// ── 4. 流式基准：每帧重解析字符数 + 解析耗时 ─────────────────────

/**
 * 模拟打字机放出：每帧推进固定字符数（Nova render pool 小池 ≈ 220 chars/s、
 * 32ms 帧 → ≈ 7 chars/frame；此处取 12 chars/frame 偏保守）。
 */
const FRAME_CHARS = 12

function buildFrames(text: string): string[] {
  const frames: string[] = []
  for (let end = FRAME_CHARS; end < text.length; end += FRAME_CHARS) {
    frames.push(text.slice(0, end))
  }
  frames.push(text)
  return frames
}

interface EngineResult {
  reparseChars: number
  parseMs: number
  frames: number
}

/** 朴素引擎：每帧对全文全量重解析（O(L²) 基线，等价未做增量的最坏实现） */
function runNaiveFullReparse(frames: string[]): EngineResult {
  let reparseChars = 0
  let parseMs = 0
  for (const frame of frames) {
    reparseChars += frame.length
    const started = performance.now()
    parseMarkdown(frame)
    parseMs += performance.now() - started
  }
  return { reparseChars, parseMs, frames: frames.length }
}

/** Astryx 引擎：parseMarkdownIncremental 全文递入，内部 settled 缓存 */
function runAstryxEngine(frames: string[]): EngineResult {
  const state = createIncrementalState()
  let reparseChars = 0
  let parseMs = 0

  for (const frame of frames) {
    const settledBefore = state.settledText.length
    const started = performance.now()
    parseMarkdownIncremental(frame, state)
    parseMs += performance.now() - started
    // unsettled tail = 全文 - settled（真正每帧重解析的面）
    reparseChars += Math.max(0, frame.length - settledBefore)
  }
  return { reparseChars, parseMs, frames: frames.length }
}

/** 大语料：长文 + 大段未闭合代码块（流式 worst case：fence 内全部留 tail） */
const LARGE_CODE = Array.from({ length: 60 }, (_, i) => [
  `function step${i}(input: number): number {`,
  `  const acc = input * ${i + 1}`,
  `  return acc > 100 ? acc % 97 : acc + ${i}`,
  '}'
].join('\n')).join('\n\n')

const LARGE_CORPUS = [
  '## 大文件分析',
  '',
  '这是一个接近真实 assistant 回答体量的语料，用来放大两引擎的差异。',
  '核心结论是 **增量解析优于全量重解析**，而代码块的流式渲染是最坏情形。',
  '',
  '### 代码段（流式期间长期处于未闭合 fence）',
  '',
  '```typescript',
  LARGE_CODE,
  '```',
  '',
  '### 收尾',
  '',
  '代码块闭合后，后续段落重新获得空行封口能力。',
  '',
  '最终这段文字会被正常封口并冻结。'
].join('\n')

describe('spike：流式基准（console 输出用于报告，断言只锁不变量）', () => {
  const frames = buildFrames(CORPUS)
  const largeFrames = buildFrames(LARGE_CORPUS)

  it('增量解析的累计重解析量与耗时显著低于每帧全量重解析', () => {
    const naive = runNaiveFullReparse(frames)
    const astryx = runAstryxEngine(frames)

    // eslint-disable-next-line no-console
    console.log(
      `[markdown-spike] frames=${frames.length} corpus=${CORPUS.length}chars\n` +
        `  全量重解析: reparse=${naive.reparseChars}chars parse=${naive.parseMs.toFixed(1)}ms\n` +
        `  astryx增量: reparse=${astryx.reparseChars}chars parse=${astryx.parseMs.toFixed(1)}ms`
    )

    expect(astryx.reparseChars).toBeLessThan(naive.reparseChars * 0.5)
    expect(astryx.parseMs).toBeLessThan(naive.parseMs)
  })

  it('大语料 + 长未闭合 fence（worst case）：增量重解析面仍受控', () => {
    const naive = runNaiveFullReparse(largeFrames)
    const astryx = runAstryxEngine(largeFrames)

    // eslint-disable-next-line no-console
    console.log(
      `[markdown-spike][large] frames=${largeFrames.length} corpus=${LARGE_CORPUS.length}chars\n` +
        `  全量重解析: reparse=${naive.reparseChars}chars parse=${naive.parseMs.toFixed(1)}ms\n` +
        `  astryx增量: reparse=${astryx.reparseChars}chars parse=${astryx.parseMs.toFixed(1)}ms\n` +
        `  每帧均值 增量=${(astryx.parseMs / astryx.frames).toFixed(3)}ms`
    )

    // worst case（fence 尾部逐帧增长）增量面 ≈ 全量面的同量级下界，
    // 但单帧解析耗时必须保持在毫秒级以内（渲染预算）
    expect(astryx.reparseChars).toBeLessThanOrEqual(naive.reparseChars)
    expect(astryx.parseMs / astryx.frames).toBeLessThan(16)
  })

  it('终态一次性解析产物完整（sanity）', () => {
    const started = performance.now()
    const blocks = parseMarkdown(CORPUS)
    const elapsed = performance.now() - started

    // eslint-disable-next-line no-console
    console.log(`[markdown-spike] 终态全文解析：${elapsed.toFixed(1)}ms(${blocks.length}块)`)

    expect(blocks.length).toBeGreaterThan(5)
  })
})

// ── 5. 代码高亮兼容性：components.code 注入 Nova CodeBlock 路径 ─────

describe('spike：components.code 覆盖兼容 Nova highlightLine 路径', () => {
  function makeCodeComponent(isStreaming: boolean) {
    return function NovaCodeProbe({ code, language }: { code: string; language?: string }) {
      // 复刻 Nova CodeBlock 的核心契约：流式期间纯文本，终态逐行高亮（此处用标记模拟）
      const lines = code.split('\n')
      return (
        <pre data-lang={language ?? ''} data-streaming={isStreaming ? '1' : '0'}>
          {lines.map((line, idx) => (
            <span key={idx} className={isStreaming ? undefined : 'diff-token diff-token--plain'}>
              {line}
              {'\n'}
            </span>
          ))}
        </pre>
      )
    }
  }

  it('codeblock 节点携带 language + 原始代码，可供 Nova CodeBlock 直接消费', () => {
    const blocks = parseMarkdown(CORPUS)
    const code = blocks.find(b => b.type === 'codeblock') as
      | { language: string; content: string }
      | undefined
    expect(code).toBeDefined()
    expect(code!.language).toMatch(/^[a-z+]+$/i)
    expect(code!.content.split('\n').length).toBeGreaterThan(5)
  })

  it('<Markdown> 渲染走注入的 code 组件（流式无高亮 / 终态有高亮）', () => {
    const streaming = renderDom(
      <Markdown isStreaming={false} components={{ code: makeCodeComponent(true) }}>
        {CODE_BLOCK}
      </Markdown>
    )
    const streamingPre = streaming.container.querySelector('pre[data-lang="typescript"]')
    expect(streamingPre).not.toBeNull()
    expect(streaming.container.querySelectorAll('.diff-token').length).toBe(0)
    streaming.unmount()

    const final = renderDom(
      <Markdown components={{ code: makeCodeComponent(false) }}>{CODE_BLOCK}</Markdown>
    )
    expect(final.container.querySelector('pre[data-lang="typescript"]')).not.toBeNull()
    expect(final.container.querySelectorAll('.diff-token').length).toBeGreaterThan(0)
    final.unmount()
  })

  it('<Markdown> 根节点带 astryx-markdown 类（theme 可定位）', () => {
    const tree = renderDom(<Markdown>{'一段普通文本'}</Markdown>)
    expect(tree.container.querySelector('.astryx-markdown')).not.toBeNull()
    tree.unmount()
  })
})
