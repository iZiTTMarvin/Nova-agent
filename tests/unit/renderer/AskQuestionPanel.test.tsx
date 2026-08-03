// @vitest-environment jsdom

import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { AskQuestionPanel } from '../../../src/renderer/features/ask/AskQuestionPanel'
import { useAgentStore, resetAgentStoreForTests } from '../../../src/renderer/stores/useAgentStore'
import { act, renderDom, type DomRenderResult } from './renderDom'

const mockInvoke = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  resetAgentStoreForTests()
  Object.assign(window, {
    api: {
      invoke: mockInvoke,
      on: vi.fn(),
      removeAllListeners: vi.fn()
    }
  })
})

afterEach(() => {
  vi.useRealTimers()
})

/** 构造一个 askQuestion 请求 */
function makeRequest(questions: { question: string; options: string[]; multiple?: boolean; custom?: boolean; header?: string }[]) {
  return {
    requestId: 'req_1',
    questions: questions.map(q => ({
      question: q.question,
      options: q.options.map(label => ({ label })),
      multiple: q.multiple ?? false,
      custom: q.custom ?? false,
      header: q.header
    }))
  }
}

function renderPanel(): DomRenderResult {
  return renderDom(React.createElement(AskQuestionPanel))
}

function findByText(container: HTMLElement, text: string): HTMLElement {
  const element = Array.from(container.querySelectorAll<HTMLElement>('*')).find(node =>
    node.textContent?.includes(text)
  )
  if (!element) throw new Error(`text not found: ${text}`)
  return element
}

function findAllByType(container: HTMLElement, selector: string): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(selector))
}

function findButton(container: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(node =>
    node.textContent?.includes(text)
  )
  if (!button) throw new Error(`button not found: ${text}`)
  return button
}

describe('AskQuestionPanel 基础渲染', () => {
  it('pendingAskQuestion 为空时不渲染', () => {
    const renderer = renderPanel()
    expect(renderer.container.querySelector('.ask-question-panel')).toBeNull()
    renderer.unmount()
  })

  it('单题时渲染问题和选项', () => {
    useAgentStore.setState({
      pendingAskQuestion: makeRequest([{ question: '你喜欢什么颜色？', options: ['红', '蓝'] }])
    })
    const renderer = renderPanel()
    expect(() => findByText(renderer.container, '你喜欢什么颜色？')).not.toThrow()
    expect(() => findByText(renderer.container, '红')).not.toThrow()
    expect(() => findByText(renderer.container, '蓝')).not.toThrow()
    renderer.unmount()
  })

  it('多题时显示进度', () => {
    useAgentStore.setState({
      pendingAskQuestion: makeRequest([
        { question: '第一题', options: ['A'] },
        { question: '第二题', options: ['B'] }
      ])
    })
    const renderer = renderPanel()
    expect(() => findByText(renderer.container, '1 / 2')).not.toThrow()
    renderer.unmount()
  })
})

describe('AskQuestionPanel 单选题', () => {
  it('选中选项并点击提交后调用 respondAskQuestion', async () => {
    mockInvoke.mockResolvedValue(undefined)
    useAgentStore.setState({
      pendingAskQuestion: makeRequest([{ question: '选择框架', options: ['React', 'Vue'] }])
    })
    const renderer = renderPanel()

    const radio = findAllByType(renderer.container, 'input')[0]
    expect(radio).toBeDefined()
    act(() => radio.click())

    // 直接点击提交，不走 autoSubmit debounce
    await act(async () => {
      findButton(renderer.container, '提交答案').click()
      await Promise.resolve()
    })

    expect(mockInvoke).toHaveBeenCalledWith(
      'respond-ask-question',
      expect.objectContaining({
        requestId: 'req_1',
        answers: [{ selectedLabels: ['React'] }],
        commandId: expect.any(String),
        interactionId: 'req_1'
      })
    )
    renderer.unmount()
  })

  it('单题多选时不自动提交', async () => {
    vi.useFakeTimers()
    mockInvoke.mockResolvedValue(undefined)
    useAgentStore.setState({
      pendingAskQuestion: makeRequest([{ question: '选择水果', options: ['苹果', '香蕉'], multiple: true }])
    })
    const renderer = renderPanel()

    const checkbox = findAllByType(renderer.container, 'input')[0]
    expect(checkbox).toBeDefined()
    act(() => checkbox.click())

    await act(async () => {
      vi.advanceTimersByTime(200)
      await Promise.resolve()
    })

    expect(mockInvoke).not.toHaveBeenCalled()
    renderer.unmount()
  })

  it('单题单选选中后须手动点提交，不会在 120ms 后误提交空答案', async () => {
    vi.useFakeTimers()
    mockInvoke.mockResolvedValue(undefined)
    useAgentStore.setState({
      pendingAskQuestion: makeRequest([
        { question: 'RAG 智能客服系统后续重点做什么？', options: ['A', 'B', '补 PDF / Word 解析 (Apache Tika)', 'D'], header: '接下来' }
      ])
    })
    const renderer = renderPanel()

    const thirdOption = findAllByType(renderer.container, 'input')[2]
    act(() => thirdOption.click())

    await act(async () => {
      vi.advanceTimersByTime(200)
      await Promise.resolve()
    })

    // 回归：旧版 autoSubmit 因闭包陈旧会在此刻提交 selectedLabels: []，模型误判为「跳过」
    expect(mockInvoke).not.toHaveBeenCalled()
    expect(useAgentStore.getState().pendingAskQuestion).not.toBeNull()
    renderer.unmount()
  })
})

describe('AskQuestionPanel 多选题', () => {
  it('切换多个选项后提交全部选中项', async () => {
    mockInvoke.mockResolvedValue(undefined)
    useAgentStore.setState({
      pendingAskQuestion: makeRequest([{ question: '选择依赖', options: ['lodash', 'dayjs', 'axios'], multiple: true }])
    })
    const renderer = renderPanel()

    const lodash = findAllByType(renderer.container, 'input')[0]
    act(() => lodash.click())
    await act(async () => { await Promise.resolve() })

    const axios = findAllByType(renderer.container, 'input')[2]
    expect(axios).toBeDefined()
    act(() => axios.click())
    await act(async () => { await Promise.resolve() })

    await act(async () => {
      findButton(renderer.container, '提交答案').click()
      await Promise.resolve()
    })

    expect(mockInvoke).toHaveBeenCalledWith(
      'respond-ask-question',
      expect.objectContaining({
        requestId: 'req_1',
        answers: [{ selectedLabels: ['lodash', 'axios'] }],
        commandId: expect.any(String),
        interactionId: 'req_1'
      })
    )
    renderer.unmount()
  })
})

describe('AskQuestionPanel custom 输入', () => {
  it('输入自定义文本后提交带 customInput 的答案', async () => {
    mockInvoke.mockResolvedValue(undefined)
    useAgentStore.setState({
      pendingAskQuestion: makeRequest([{ question: '你的建议？', options: ['A', 'B'], custom: true }])
    })
    const renderer = renderPanel()

    act(() => findButton(renderer.container, '输入你的回答').click())
    await act(async () => { await Promise.resolve() })

    const customInput = renderer.container.querySelector<HTMLInputElement>('input[placeholder="输入你的回答…"]')
    expect(customInput).not.toBeNull()
    act(() => {
      if (customInput) {
        const valueSetter = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          'value'
        )?.set
        valueSetter?.call(customInput, '我的自定义回答')
        customInput.dispatchEvent(new Event('input', { bubbles: true }))
        customInput.dispatchEvent(new Event('change', { bubbles: true }))
      }
    })

    await act(async () => {
      findButton(renderer.container, '提交答案').click()
      await Promise.resolve()
    })

    expect(mockInvoke).toHaveBeenCalledWith(
      'respond-ask-question',
      expect.objectContaining({
        requestId: 'req_1',
        answers: [{ selectedLabels: [], customInput: '我的自定义回答' }],
        commandId: expect.any(String),
        interactionId: 'req_1'
      })
    )
    renderer.unmount()
  })
})

describe('AskQuestionPanel dismiss', () => {
  it('点击跳过全部调用 dismissAskQuestion（传空数组）', async () => {
    mockInvoke.mockResolvedValue(undefined)
    useAgentStore.setState({
      pendingAskQuestion: makeRequest([{ question: '问题', options: ['A', 'B'] }])
    })
    const renderer = renderPanel()

    await act(async () => {
      findButton(renderer.container, '跳过全部').click()
      await Promise.resolve()
    })

    expect(mockInvoke).toHaveBeenCalledWith(
      'respond-ask-question',
      expect.objectContaining({
        requestId: 'req_1',
        answers: [],
        commandId: expect.any(String),
        interactionId: 'req_1'
      })
    )
    renderer.unmount()
  })
})

describe('AskQuestionPanel 多题向导', () => {
  it('上一题/下一题切换，最终提交含全部答案', async () => {
    mockInvoke.mockResolvedValue(undefined)
    useAgentStore.setState({
      pendingAskQuestion: makeRequest([
        { question: '第一题', options: ['A1', 'A2'] },
        { question: '第二题', options: ['B1', 'B2'] }
      ])
    })
    const renderer = renderPanel()

    const nextBtn = findButton(renderer.container, '下一题')

    // 第一题选 A1
    const a1 = findAllByType(renderer.container, 'input')[0]
    expect(a1).toBeDefined()
    act(() => a1.click())
    await act(async () => { await Promise.resolve() })

    // 下一题
    act(() => nextBtn.click())
    await act(async () => { await Promise.resolve() })

    // 第二题选 B2
    const b2 = findAllByType(renderer.container, 'input')[1]
    expect(b2).toBeDefined()
    act(() => b2.click())
    await act(async () => { await Promise.resolve() })

    // 返回上一题验证状态保留
    const prevBtn = findButton(renderer.container, '上一题')
    act(() => prevBtn.click())
    await act(async () => { await Promise.resolve() })
    const a1Again = findAllByType(renderer.container, 'input')[0]
    expect(a1Again).toBeDefined()
    expect((a1Again as HTMLInputElement).checked).toBe(true)

    // 再回到第二题提交
    act(() => findButton(renderer.container, '下一题').click())
    await act(async () => { await Promise.resolve() })
    await act(async () => {
      findButton(renderer.container, '提交答案').click()
      await Promise.resolve()
    })

    expect(mockInvoke).toHaveBeenCalledWith(
      'respond-ask-question',
      expect.objectContaining({
        requestId: 'req_1',
        answers: [
          { selectedLabels: ['A1'] },
          { selectedLabels: ['B2'] }
        ],
        commandId: expect.any(String),
        interactionId: 'req_1'
      })
    )
    renderer.unmount()
  })
})

describe('AskQuestionPanel 状态清理', () => {
  it('pendingAskQuestion 被清空后不再渲染', () => {
    useAgentStore.setState({
      pendingAskQuestion: makeRequest([{ question: '问题', options: ['A'] }])
    })
    const renderer = renderPanel()
    expect(renderer.container.querySelector('.ask-question-panel')).not.toBeNull()

    act(() => {
      useAgentStore.setState({ pendingAskQuestion: null })
    })

    expect(renderer.container.querySelector('.ask-question-panel')).toBeNull()
    renderer.unmount()
  })
})
