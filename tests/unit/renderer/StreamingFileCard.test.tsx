/**
 * StreamingFileCard — Step 2 性能优化行为测试
 *
 * 覆盖：
 * 1. running 阶段不调用 highlightLine（纯文本），success 阶段才高亮
 * 2. 接 argumentsRaw（字符串）时，内部用 parsePartialToolArgs 解析
 * 3. 接 argumentsRaw 比接 args 的浅比较更稳定：相同 raw + 相同 status 引用稳定时不重渲染
 * 4. 旧调用方只传 args 时回退到 args（向后兼容）
 */
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StreamingFileCard } from '../../../src/renderer/features/chat/StreamingFileCard'
import { highlightLine } from '../../../src/renderer/features/diff/syntaxHighlight'

vi.mock('framer-motion', () => ({}))
// highlightLine 真实逻辑可测，这里 spy 上去看是否被调用
vi.mock('../../../src/renderer/features/diff/syntaxHighlight', async () => {
  const actual = await vi.importActual<typeof import('../../../src/renderer/features/diff/syntaxHighlight')>(
    '../../../src/renderer/features/diff/syntaxHighlight'
  )
  return {
    ...actual,
    highlightLine: vi.fn(actual.highlightLine)
  }
})

function makeRaw(content: string): string {
  return JSON.stringify({ path: 'src/example.css', content })
}

describe('StreamingFileCard Step 2 优化', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('running 阶段不调用 highlightLine（纯文本展示）', () => {
    const raw = makeRaw('body { color: red; }\n.foo { padding: 1px; }')
    let renderer: TestRenderer.ReactTestRenderer | null = null
    act(() => {
      renderer = TestRenderer.create(
        React.createElement(StreamingFileCard, {
          toolCallId: 'tc_1',
          toolName: 'write',
          status: 'running',
          argumentsRaw: raw
        })
      )
    })

    expect(highlightLine).not.toHaveBeenCalled()

    // 内容应作为纯文本展示，line-text 内没有 diff-token
    const lineTexts = renderer!.root.findAllByProps({ className: 'streaming-card__line-text' })
    expect(lineTexts.length).toBe(2)
    expect(lineTexts[0].children).toEqual(['body { color: red; }'])
    expect(lineTexts[1].children).toEqual(['.foo { padding: 1px; }'])

    act(() => {
      renderer?.unmount()
    })
  })

  it('success 阶段调用 highlightLine 做 token 级高亮', () => {
    const raw = makeRaw('body { color: red; }')
    let renderer: TestRenderer.ReactTestRenderer | null = null
    // 先以 running 挂载触发 isOpen=true，再 update 到 success 验证高亮
    act(() => {
      renderer = TestRenderer.create(
        React.createElement(StreamingFileCard, {
          toolCallId: 'tc_1',
          toolName: 'write',
          status: 'running',
          argumentsRaw: raw
        })
      )
    })

    const callsRunning = (highlightLine as ReturnType<typeof vi.fn>).mock.calls.length

    act(() => {
      renderer!.update(
        React.createElement(StreamingFileCard, {
          toolCallId: 'tc_1',
          toolName: 'write',
          status: 'success',
          argumentsRaw: raw
        })
      )
    })

    // running→success 切换后，highlightLine 应至少被多调用一次（每行一次）
    const callsAfter = (highlightLine as ReturnType<typeof vi.fn>).mock.calls.length
    expect(callsAfter).toBeGreaterThan(callsRunning)

    act(() => {
      renderer?.unmount()
    })
  })

  it('status 从 running 切到 success 时开始高亮（先前的纯文本替换为高亮 token）', () => {
    const raw = makeRaw('a = 1')
    let renderer: TestRenderer.ReactTestRenderer | null = null
    act(() => {
      renderer = TestRenderer.create(
        React.createElement(StreamingFileCard, {
          toolCallId: 'tc_1',
          toolName: 'write',
          status: 'running',
          argumentsRaw: raw
        })
      )
    })

    const callsDuringRunning = (highlightLine as ReturnType<typeof vi.fn>).mock.calls.length

    act(() => {
      renderer!.update(
        React.createElement(StreamingFileCard, {
          toolCallId: 'tc_1',
          toolName: 'write',
          status: 'success',
          argumentsRaw: raw
        })
      )
    })

    const callsAfterSuccess = (highlightLine as ReturnType<typeof vi.fn>).mock.calls.length
    expect(callsAfterSuccess).toBeGreaterThan(callsDuringRunning)

    act(() => {
      renderer?.unmount()
    })
  })

  it('接 argumentsRaw 时正确解析 path 和 content（仅 partial JSON）', () => {
    // 模拟流式中：JSON 未闭合
    const partialRaw = '{"path":"src/foo.css","content":"body { color: red;'
    let renderer: TestRenderer.ReactTestRenderer | null = null
    act(() => {
      renderer = TestRenderer.create(
        React.createElement(StreamingFileCard, {
          toolCallId: 'tc_1',
          toolName: 'write',
          status: 'running',
          argumentsRaw: partialRaw
        })
      )
    })

    const filename = renderer!.root.findByProps({ className: 'streaming-card__filename' })
    expect(filename.children).toEqual(['src/foo.css'])

    const lineText = renderer!.root.findByProps({ className: 'streaming-card__line-text' })
    expect(lineText.children).toEqual(['body { color: red;'])

    act(() => {
      renderer?.unmount()
    })
  })

  it('向后兼容：仅传 args 时仍能正确显示', () => {
    const args = {
      path: 'src/legacy.css',
      content: 'a { color: blue; }'
    }
    let renderer: TestRenderer.ReactTestRenderer | null = null
    act(() => {
      renderer = TestRenderer.create(
        React.createElement(StreamingFileCard, {
          toolCallId: 'tc_1',
          toolName: 'write',
          status: 'running',
          args
        })
      )
    })

    const filename = renderer!.root.findByProps({ className: 'streaming-card__filename' })
    expect(filename.children).toEqual(['src/legacy.css'])

    const lineText = renderer!.root.findByProps({ className: 'streaming-card__line-text' })
    expect(lineText.children).toEqual(['a { color: blue; }'])

    act(() => {
      renderer?.unmount()
    })
  })

  it('相同 argumentsRaw + 相同其他 props 时不重新调用 highlightLine（memo 命中）', () => {
    const raw = makeRaw('a { color: red; }')
    let renderer: TestRenderer.ReactTestRenderer | null = null
    act(() => {
      renderer = TestRenderer.create(
        React.createElement(StreamingFileCard, {
          toolCallId: 'tc_1',
          toolName: 'write',
          status: 'success',
          argumentsRaw: raw
        })
      )
    })

    const callsAfterMount = (highlightLine as ReturnType<typeof vi.fn>).mock.calls.length

    // 同样的 props 再 update 一次（外层 forceUpdate 模拟父级无关重渲染）
    act(() => {
      renderer!.update(
        React.createElement(StreamingFileCard, {
          toolCallId: 'tc_1',
          toolName: 'write',
          status: 'success',
          argumentsRaw: raw
        })
      )
    })

    const callsAfterUpdate = (highlightLine as ReturnType<typeof vi.fn>).mock.calls.length
    // memo 命中 → highlightLine 不应被再次调用
    expect(callsAfterUpdate).toBe(callsAfterMount)

    act(() => {
      renderer?.unmount()
    })
  })

  it('edit 工具的 partial raw（filePath + newText）正确显示', () => {
    // edit 工具的 partial JSON 流式
    const partialRaw = '{"filePath":"src/foo.ts","edits":[{"newText":"// new'
    let renderer: TestRenderer.ReactTestRenderer | null = null
    act(() => {
      renderer = TestRenderer.create(
        React.createElement(StreamingFileCard, {
          toolCallId: 'tc_2',
          toolName: 'edit',
          status: 'running',
          argumentsRaw: partialRaw
        })
      )
    })

    const filename = renderer!.root.findByProps({ className: 'streaming-card__filename' })
    expect(filename.children).toEqual(['src/foo.ts'])

    const lineText = renderer!.root.findByProps({ className: 'streaming-card__line-text' })
    expect(lineText.children).toEqual(['// new'])

    act(() => {
      renderer?.unmount()
    })
  })

  it('接完整闭合的 argumentsRaw：能解析 path/content 并展示', () => {
    // 模拟 finalize 时 store 仍保留 argumentsRaw 但内容已闭合（兼容路径）
    const fullRaw = '{"path":"src/foo.ts","content":"a = 1;"}'

    let renderer: TestRenderer.ReactTestRenderer | null = null
    act(() => {
      renderer = TestRenderer.create(
        React.createElement(StreamingFileCard, {
          toolCallId: 'tc_1',
          toolName: 'write',
          status: 'running',
          argumentsRaw: fullRaw
        })
      )
    })

    // 完整 JSON 解析的 path 正确显示（即使 status='running' 也不影响展示）
    const filename = renderer!.root.findByProps({ className: 'streaming-card__filename' })
    expect(filename.children).toEqual(['src/foo.ts'])

    const lineText = renderer!.root.findByProps({ className: 'streaming-card__line-text' })
    expect(lineText.children).toEqual(['a = 1;'])

    // running 状态下 highlightLine 不被调（哪怕 argumentsRaw 是完整 JSON）
    expect(highlightLine).not.toHaveBeenCalled()

    act(() => {
      renderer?.unmount()
    })
  })

  it('流式期连续同 argumentsRaw 引用（无新增）：不应触发额外 highlightLine', () => {
    // 模拟 useChatStore 在某些情况会写入相同 argumentsRaw 引用（比如同 batch 多次 bump 但内容未变），
    // 此时 React.memo 应命中，highlightLine 不被多调。
    const raw = makeRaw('a { color: red; }')
    let renderer: TestRenderer.ReactTestRenderer | null = null
    act(() => {
      renderer = TestRenderer.create(
        React.createElement(StreamingFileCard, {
          toolCallId: 'tc_1',
          toolName: 'write',
          status: 'running',
          argumentsRaw: raw
        })
      )
    })

    // running 期 highlightLine 不应被调用
    expect(highlightLine).not.toHaveBeenCalled()

    // 同样的 props 再 update（父级 forceUpdate / 无关 state 变化）
    act(() => {
      renderer!.update(
        React.createElement(StreamingFileCard, {
          toolCallId: 'tc_1',
          toolName: 'write',
          status: 'running',
          argumentsRaw: raw
        })
      )
    })

    expect(highlightLine).not.toHaveBeenCalled()

    act(() => {
      renderer?.unmount()
    })
  })
})
