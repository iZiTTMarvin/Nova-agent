import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import TestRenderer, { act } from 'react-test-renderer'
import { AskQuestionPanel } from '../../../src/renderer/features/ask/AskQuestionPanel'
import { useAgentStore, resetAgentStoreForTests } from '../../../src/renderer/stores/useAgentStore'

const mockInvoke = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  resetAgentStoreForTests()
  global.window = {
    ...global.window,
    api: {
      invoke: mockInvoke,
      on: vi.fn(),
      removeAllListeners: vi.fn()
    }
  } as unknown as Window & typeof globalThis
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

function renderPanel() {
  let renderer: TestRenderer.ReactTestRenderer | null = null
  act(() => {
    renderer = TestRenderer.create(React.createElement(AskQuestionPanel))
  })
  return renderer!
}

function findByText(root: TestRenderer.ReactTestInstance, text: string) {
  return root.find(node => node.children.some(child => typeof child === 'string' && child.includes(text)))
}

function findAllByType(root: TestRenderer.ReactTestInstance, type: string) {
  return root.findAll(node => node.type === type)
}

describe('AskQuestionPanel 基础渲染', () => {
  it('pendingAskQuestion 为空时不渲染', () => {
    const renderer = renderPanel()
    expect(renderer.toJSON()).toBeNull()
  })

  it('单题时渲染问题和选项', () => {
    useAgentStore.setState({
      pendingAskQuestion: makeRequest([{ question: '你喜欢什么颜色？', options: ['红', '蓝'] }])
    })
    const renderer = renderPanel()
    const root = renderer.root
    expect(() => findByText(root, '你喜欢什么颜色？')).not.toThrow()
    expect(() => findByText(root, '红')).not.toThrow()
    expect(() => findByText(root, '蓝')).not.toThrow()
  })

  it('多题时显示进度', () => {
    useAgentStore.setState({
      pendingAskQuestion: makeRequest([
        { question: '第一题', options: ['A'] },
        { question: '第二题', options: ['B'] }
      ])
    })
    const renderer = renderPanel()
    expect(() => findByText(renderer.root, '1 / 2')).not.toThrow()
  })
})

describe('AskQuestionPanel 单选题', () => {
  it('选中选项并点击提交后调用 respondAskQuestion', async () => {
    mockInvoke.mockResolvedValue(undefined)
    useAgentStore.setState({
      pendingAskQuestion: makeRequest([{ question: '选择框架', options: ['React', 'Vue'] }])
    })
    const renderer = renderPanel()
    const root = renderer.root

    const radio = findAllByType(root, 'input')[0]
    expect(radio).toBeDefined()
    act(() => radio.props.onChange())

    // 直接点击提交，不走 autoSubmit debounce
    const submitBtn = root.find(node =>
      node.type === 'button' && node.children.some(c => typeof c === 'string' && c.includes('提交答案'))
    )
    await act(async () => {
      submitBtn.props.onClick()
      await Promise.resolve()
    })

    expect(mockInvoke).toHaveBeenCalledWith('respond-ask-question', {
      requestId: 'req_1',
      answers: [{ selectedLabels: ['React'] }]
    })
  })

  it('单题多选时不自动提交', async () => {
    vi.useFakeTimers()
    mockInvoke.mockResolvedValue(undefined)
    useAgentStore.setState({
      pendingAskQuestion: makeRequest([{ question: '选择水果', options: ['苹果', '香蕉'], multiple: true }])
    })
    const renderer = renderPanel()
    const root = renderer.root

    const checkbox = findAllByType(root, 'input')[0]
    expect(checkbox).toBeDefined()
    act(() => checkbox.props.onChange())

    await act(async () => {
      vi.advanceTimersByTime(200)
      await Promise.resolve()
    })

    expect(mockInvoke).not.toHaveBeenCalled()
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
    const root = renderer.root

    const thirdOption = findAllByType(root, 'input')[2]
    act(() => thirdOption.props.onChange())

    await act(async () => {
      vi.advanceTimersByTime(200)
      await Promise.resolve()
    })

    // 回归：旧版 autoSubmit 因闭包陈旧会在此刻提交 selectedLabels: []，模型误判为「跳过」
    expect(mockInvoke).not.toHaveBeenCalled()
    expect(useAgentStore.getState().pendingAskQuestion).not.toBeNull()
  })
})

describe('AskQuestionPanel 多选题', () => {
  it('切换多个选项后提交全部选中项', async () => {
    mockInvoke.mockResolvedValue(undefined)
    useAgentStore.setState({
      pendingAskQuestion: makeRequest([{ question: '选择依赖', options: ['lodash', 'dayjs', 'axios'], multiple: true }])
    })
    const renderer = renderPanel()
    const root = renderer.root

    const lodash = findAllByType(root, 'input')[0]
    act(() => lodash.props.onChange())
    await act(async () => { await Promise.resolve() })

    const axios = findAllByType(root, 'input')[2]
    expect(axios).toBeDefined()
    act(() => axios.props.onChange())
    await act(async () => { await Promise.resolve() })

    const submitBtn = root.find(node =>
      node.type === 'button' && node.children.some(c => typeof c === 'string' && c.includes('提交答案'))
    )
    await act(async () => {
      submitBtn.props.onClick()
      await Promise.resolve()
    })

    expect(mockInvoke).toHaveBeenCalledWith('respond-ask-question', {
      requestId: 'req_1',
      answers: [{ selectedLabels: ['lodash', 'axios'] }]
    })
  })
})

describe('AskQuestionPanel custom 输入', () => {
  it('输入自定义文本后提交带 customInput 的答案', async () => {
    mockInvoke.mockResolvedValue(undefined)
    useAgentStore.setState({
      pendingAskQuestion: makeRequest([{ question: '你的建议？', options: ['A', 'B'], custom: true }])
    })
    const renderer = renderPanel()
    const root = renderer.root

    const customTrigger = root.find(node => node.type === 'button' && node.children.some(c => typeof c === 'string' && c.includes('输入你的回答')))
    act(() => customTrigger.props.onClick())
    await act(async () => { await Promise.resolve() })

    const customInput = root.find(node => node.type === 'input' && node.props.placeholder === '输入你的回答…')
    act(() => customInput.props.onChange({ target: { value: '我的自定义回答' } }))

    const submitBtn = root.find(node =>
      node.type === 'button' && node.children.some(c => typeof c === 'string' && c.includes('提交答案'))
    )
    await act(async () => {
      submitBtn.props.onClick()
      await Promise.resolve()
    })

    expect(mockInvoke).toHaveBeenCalledWith('respond-ask-question', {
      requestId: 'req_1',
      answers: [{ selectedLabels: [], customInput: '我的自定义回答' }]
    })
  })
})

describe('AskQuestionPanel dismiss', () => {
  it('点击跳过全部调用 dismissAskQuestion（传空数组）', async () => {
    mockInvoke.mockResolvedValue(undefined)
    useAgentStore.setState({
      pendingAskQuestion: makeRequest([{ question: '问题', options: ['A', 'B'] }])
    })
    const renderer = renderPanel()
    const root = renderer.root

    const dismissBtn = root.find(node =>
      node.type === 'button' && node.children.some(c => typeof c === 'string' && c.includes('跳过全部'))
    )
    await act(async () => {
      dismissBtn.props.onClick()
      await Promise.resolve()
    })

    expect(mockInvoke).toHaveBeenCalledWith('respond-ask-question', {
      requestId: 'req_1',
      answers: []
    })
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
    const root = renderer.root

    const allButtons = root.findAll(node => node.type === 'button' && node.children.some(c => typeof c === 'string')
    )
    const nextBtn = allButtons.find(b => b.children.some(c => typeof c === 'string' && c.includes('下一题')))
    let prevBtn = allButtons.find(b => b.children.some(c => typeof c === 'string' && c.includes('上一题')))

    // 第一题选 A1
    const a1 = findAllByType(root, 'input')[0]
    expect(a1).toBeDefined()
    act(() => a1.props.onChange())
    await act(async () => { await Promise.resolve() })

    // 下一题
    expect(nextBtn).toBeDefined()
    act(() => nextBtn!.props.onClick())
    await act(async () => { await Promise.resolve() })

    // 第二题选 B2
    const b2 = findAllByType(root, 'input')[1]
    expect(b2).toBeDefined()
    act(() => b2.props.onChange())
    await act(async () => { await Promise.resolve() })

    // 返回上一题验证状态保留
    const buttonsAfterNext = root.findAll(node => node.type === 'button' && node.children.some(c => typeof c === 'string'))
    prevBtn = buttonsAfterNext.find(b => b.children.some(c => typeof c === 'string' && c.includes('上一题')))
    expect(prevBtn).toBeDefined()
    act(() => prevBtn!.props.onClick())
    await act(async () => { await Promise.resolve() })
    const a1Again = findAllByType(root, 'input')[0]
    expect(a1Again).toBeDefined()
    expect(a1Again.props.checked).toBe(true)

    // 再回到第二题提交
    act(() => nextBtn!.props.onClick())
    await act(async () => { await Promise.resolve() })
    const submitBtn = root.find(node =>
      node.type === 'button' && node.children.some(c => typeof c === 'string' && c.includes('提交答案'))
    )
    await act(async () => {
      submitBtn.props.onClick()
      await Promise.resolve()
    })

    expect(mockInvoke).toHaveBeenCalledWith('respond-ask-question', {
      requestId: 'req_1',
      answers: [
        { selectedLabels: ['A1'] },
        { selectedLabels: ['B2'] }
      ]
    })
  })
})

describe('AskQuestionPanel 状态清理', () => {
  it('pendingAskQuestion 被清空后不再渲染', () => {
    useAgentStore.setState({
      pendingAskQuestion: makeRequest([{ question: '问题', options: ['A'] }])
    })
    const renderer = renderPanel()
    expect(renderer.toJSON()).not.toBeNull()

    act(() => {
      useAgentStore.setState({ pendingAskQuestion: null })
    })

    expect(renderer.toJSON()).toBeNull()
  })
})
