// @vitest-environment jsdom

import React from 'react'
import { act, renderDom } from './renderDom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatPanel } from '../../../src/renderer/features/chat/ChatPanel'
import { useChatStore, resetChatStoreForTests } from '../../../src/renderer/stores/useChatStore'
import {
  resetSettingsStoreForTests,
  useSettingsStore
} from '../../../src/renderer/stores/useSettingsStore'
import { useAgentStore, resetAgentStoreForTests } from '../../../src/renderer/stores/useAgentStore'
import { useRunStore } from '../../../src/renderer/stores/useRunStore'
import { useWorkspaceStore } from '../../../src/renderer/stores/useWorkspaceStore'
import type { ExtendedMessage } from '../../../src/renderer/stores/types'

/**
 * ChatPanel 接线测试。
 *
 * MessageItem 侧 isPausedForInput 全部就绪，但 ChatPanel 渲染时漏传 →
 * 等待用户决策期间流式动画常驻循环不停 → 卡死。sendOrchestration.test.ts 只验证
 * preSendGate 逻辑，无法捕捉"接线是否真的传了 isPausedForInput"。本文件通过 mock
 * MessageItem 捕获其实际收到的 props，断言 pendingAskQuestion / pendingPermissionRequest
 * 真值性正确流向 isPausedForInput。
 *
 * 这是 MessageItem.test.ts（只测 areEqual）与 sendOrchestration.test.ts（只测 dismiss）之间的
 * 关键衔接测试，三者互补。
 */

// ── mock 掉 ChatPanel 的重量级子组件与图标，避免真实渲染 + 减少耦合 ──
const messageItemPropsByRender: { isPausedForInput?: boolean; msgId?: string }[] = []
vi.mock('../../../src/renderer/features/chat/MessageItem', () => ({
  MessageItem: (props: any) => {
    messageItemPropsByRender.push({ isPausedForInput: props.isPausedForInput, msgId: props.msg?.id })
    return null
  }
}))

vi.mock('../../../src/renderer/features/mode-switch/ModeSwitch', () => ({ ModeSwitch: () => null }))
vi.mock('../../../src/renderer/features/chat/ModelSelector', () => ({ ModelSelector: () => null }))
vi.mock('../../../src/renderer/features/chat/ContextIndicator', () => ({ ContextIndicator: () => null }))
vi.mock('../../../src/renderer/components/ImagePreviewBar', () => ({ ImagePreviewBar: () => null }))
vi.mock('../../../src/renderer/features/todo/TodoPanel', () => ({ TodoPanel: () => null }))
vi.mock('../../../src/renderer/features/ask/AskQuestionPanel', () => ({ AskQuestionPanel: () => null }))
vi.mock('../../../src/renderer/features/chat/RecoveryBanner', () => ({ RecoveryBanner: () => null }))
vi.mock('../../../src/renderer/components/ImagePreviewDialog', () => ({ ImagePreviewDialog: () => null }))
vi.mock('../../../src/renderer/components/Icons', () => ({
  SendIcon: () => null,
  StopIcon: () => null,
  NovaLogo: () => null,
  ImageIcon: () => null,
  ChevronIcon: () => null,
  ShieldIcon: () => null,
  CheckSmallIcon: () => null
}))
vi.mock('framer-motion', () => import('./_framerMotionMock'))

const mockInvoke = vi.fn()

function makeAssistantMessage(id: string): ExtendedMessage {
  return {
    id,
    sessionId: 'sess_1',
    role: 'assistant',
    content: 'hi',
    timestamp: 0,
    _revision: 0
  }
}

describe('ChatPanel → MessageItem isPausedForInput 接线', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    messageItemPropsByRender.length = 0

    resetChatStoreForTests()
    resetSettingsStoreForTests()
    resetAgentStoreForTests()

    mockInvoke.mockResolvedValue(undefined)
    Object.assign(window, {
      api: { invoke: mockInvoke, on: vi.fn(() => () => {}), removeAllListeners: vi.fn() },
      nova: {
        skill: {
          onChange: vi.fn(() => () => {}),
          list: vi.fn(() => []),
          reload: vi.fn()
        }
      }
    })

    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('无 pending askQuestion 时，MessageItem 收到 isPausedForInput=false', () => {
    act(() => {
      useChatStore.setState({
        currentSessionId: 'sess_1',
        messages: [makeAssistantMessage('msg_1')]
      })
      useAgentStore.setState({ pendingAskQuestion: null })
    })

    const renderer = renderDom(React.createElement(ChatPanel))
    renderer.unmount()

    const captured = messageItemPropsByRender.find(p => p.msgId === 'msg_1')
    expect(captured).toBeDefined()
    expect(captured!.isPausedForInput).toBe(false)
  })

  it('有 pending askQuestion 时（面板开着等回答），只有当前生成消息收到 isPausedForInput=true', () => {
    act(() => {
      useChatStore.setState({
        currentSessionId: 'sess_1',
        isGenerating: true,
        currentGeneratingMessageId: 'msg_2',
        messages: [makeAssistantMessage('msg_1'), makeAssistantMessage('msg_2')]
      })
    })

    const renderer = renderDom(React.createElement(ChatPanel))

    // 切到 askQuestion 面板打开，触发 ChatPanel 重渲染
    act(() => {
      useAgentStore.setState({
        pendingAskQuestion: {
          requestId: 'req_1',
          questions: [
            { question: '选哪个？', options: [{ label: 'A' }] }
          ]
        }
      })
    })
    renderer.unmount()

    // 取面板打开后最近一次渲染：历史消息不暂停，当前生成消息才暂停。
    const historical = messageItemPropsByRender.filter(p => p.msgId === 'msg_1').pop()
    const current = messageItemPropsByRender.filter(p => p.msgId === 'msg_2').pop()
    expect(historical).toBeDefined()
    expect(historical!.isPausedForInput).toBe(false)
    expect(current).toBeDefined()
    expect(current!.isPausedForInput).toBe(true)
  })

  it('有 pending bash 权限请求时，只有权限所属消息收到 isPausedForInput=true', () => {
    act(() => {
      useChatStore.setState({
        currentSessionId: 'sess_1',
        isGenerating: true,
        currentGeneratingMessageId: 'msg_2',
        messages: [makeAssistantMessage('msg_1'), makeAssistantMessage('msg_2')]
      })
    })

    const renderer = renderDom(React.createElement(ChatPanel))

    act(() => {
      useAgentStore.setState({
        pendingPermissionRequest: {
          messageId: 'msg_2',
          requestId: 'perm_1',
          toolName: 'bash',
          args: { command: 'npm test' },
          riskLevel: 'medium',
          reason: '命令执行需要确认',
          toolCallIds: ['tool_1']
        }
      })
    })
    renderer.unmount()

    const historical = messageItemPropsByRender.filter(p => p.msgId === 'msg_1').pop()
    const current = messageItemPropsByRender.filter(p => p.msgId === 'msg_2').pop()
    expect(historical).toBeDefined()
    expect(historical!.isPausedForInput).toBe(false)
    expect(current).toBeDefined()
    expect(current!.isPausedForInput).toBe(true)
  })
})

/**
 * 自动滚动轮询接线回归测试。
 *
 * 回归对象：askQuestion 答完（pendingAskQuestion 由 true→false）后，500ms 流式滚动
 * 轮询必须重新启动。历史 bug 是「创建 poller 的 effect 依赖含 pendingAskQuestion，但
 * 启动 poller 的 effect 只依赖 isGenerating」——答完时 poller 被重建成停止态却不再 start，
 * 轮询永久失效（bash 撑高列表不再跟随底部）。
 *
 * jsdom 不提供可布局的滚动尺寸；这里给真实滚动容器注入可控尺寸与 scrollTo，
 * 再用假定时器驱动 setInterval。
 */
describe('ChatPanel → 自动滚动轮询在 askQuestion 答完后重启', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    messageItemPropsByRender.length = 0
    resetChatStoreForTests()
    resetSettingsStoreForTests()
    resetAgentStoreForTests()
    mockInvoke.mockResolvedValue(undefined)
    Object.assign(window, {
      api: { invoke: mockInvoke, on: vi.fn(() => () => {}), removeAllListeners: vi.fn() },
      nova: { skill: { onChange: vi.fn(() => () => {}), list: vi.fn(() => []), reload: vi.fn() } }
    })
    // rAF 桩成不回调，隔离出 setInterval 轮询路径
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('pendingAskQuestion true→false 后，500ms 轮询仍会滚到底部', () => {
    const scrollTo = vi.fn()
    // 所有宿主节点共用同一个假节点：提供 scrollTo + 距底部 > 阈值，保证轮询有滚动动机
    const nodeMock = { scrollTo, scrollHeight: 2000, scrollTop: 0, clientHeight: 400 }

    act(() => {
      useChatStore.setState({
        currentSessionId: 'sess_1',
        isGenerating: true,
        currentGeneratingMessageId: 'msg_2',
        messages: [makeAssistantMessage('msg_2')]
      })
      useAgentStore.setState({ pendingAskQuestion: null })
    })

    const renderer = renderDom(React.createElement(ChatPanel))
    const scrollContainer = renderer.container.querySelector<HTMLElement>('.chat-messages')
    expect(scrollContainer).not.toBeNull()
    if (scrollContainer) {
      Object.defineProperties(scrollContainer, {
        scrollHeight: { configurable: true, value: nodeMock.scrollHeight },
        clientHeight: { configurable: true, value: nodeMock.clientHeight },
        scrollTop: {
          configurable: true,
          get: () => nodeMock.scrollTop,
          set: (value: number) => { nodeMock.scrollTop = value }
        }
      })
      Object.defineProperty(scrollContainer, 'scrollTo', {
        configurable: true,
        value: scrollTo
      })
    }

    // 1) 弹出 askQuestion（暂停轮询）
    act(() => {
      useAgentStore.setState({
        pendingAskQuestion: {
          requestId: 'req_1',
          questions: [{ question: '继续？', options: [{ label: 'A' }] }]
        }
      })
    })

    // 2) 答完 askQuestion（恢复）——此处是回归点：轮询应被重新启动
    act(() => {
      useAgentStore.setState({ pendingAskQuestion: null })
    })

    // 清掉挂载/恢复瞬间的滚动，只观察后续轮询
    scrollTo.mockClear()

    // 3) 推进一个轮询周期
    act(() => {
      vi.advanceTimersByTime(600)
    })

    expect(scrollTo).toHaveBeenCalled()

    renderer.unmount()
  })
})

describe('ChatPanel → 流尾状态指示器接线', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetChatStoreForTests()
    resetSettingsStoreForTests()
    resetAgentStoreForTests()
    mockInvoke.mockResolvedValue(undefined)
    Object.assign(window, {
      api: { invoke: mockInvoke, on: vi.fn(() => () => {}), removeAllListeners: vi.fn() },
      nova: { skill: { onChange: vi.fn(() => () => {}), list: vi.fn(() => []), reload: vi.fn() } }
    })
  })

  it('isGenerating=true 且无暂停时，在消息流尾部渲染状态指示器', () => {
    act(() => {
      useChatStore.setState({
        currentSessionId: 'sess_1',
        isGenerating: true,
        currentGeneratingMessageId: 'msg_1',
        messages: [makeAssistantMessage('msg_1')]
      })
    })

    const renderer = renderDom(React.createElement(ChatPanel))
    const tailStatus = renderer.container.querySelector('.chat-messages__tail-status')
    expect(tailStatus).not.toBeNull()
    expect(tailStatus?.querySelector('.assistant-pending')).not.toBeNull()

    renderer.unmount()
  })

  it('isPausedForUserInput=true 时，流尾状态指示器不渲染', () => {
    act(() => {
      useChatStore.setState({
        currentSessionId: 'sess_1',
        isGenerating: true,
        currentGeneratingMessageId: 'msg_1',
        messages: [makeAssistantMessage('msg_1')]
      })
      useAgentStore.setState({
        pendingAskQuestion: {
          requestId: 'req_1',
          questions: [{ question: '请选择', options: [{ label: 'A' }] }]
        }
      })
    })

    const renderer = renderDom(React.createElement(ChatPanel))
    const tailStatus = renderer.container.querySelector('.chat-messages__tail-status')
    expect(tailStatus).toBeNull()

    renderer.unmount()
  })

  it('isGenerating=false 时，流尾状态指示器不渲染', () => {
    act(() => {
      useChatStore.setState({
        currentSessionId: 'sess_1',
        isGenerating: false,
        currentGeneratingMessageId: null,
        messages: [makeAssistantMessage('msg_1')]
      })
    })

    const renderer = renderDom(React.createElement(ChatPanel))
    const tailStatus = renderer.container.querySelector('.chat-messages__tail-status')
    expect(tailStatus).toBeNull()

    renderer.unmount()
  })
})

/**
 * 取消/中断状态归属会话的视图回归。
 *
 * 回归对象：useRunStore 的 cancelling / interruptedRunId 是全局字段，A 会话停止后
 * 切到 B，A 的终态 snapshot 不再确认取消 → B 的停止按钮被 A 的取消态禁用、
 * 8 秒后误显示「强制终止」；A 的 interrupted 横幅也出现在任意会话。
 */
describe('ChatPanel → 取消/中断状态归属会话', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    messageItemPropsByRender.length = 0
    resetChatStoreForTests()
    resetSettingsStoreForTests()
    resetAgentStoreForTests()
    useRunStore.getState().resetForTests()
    mockInvoke.mockResolvedValue(undefined)
    Object.assign(window, {
      api: { invoke: mockInvoke, on: vi.fn(() => () => {}), removeAllListeners: vi.fn() },
      nova: { skill: { onChange: vi.fn(() => () => {}), list: vi.fn(() => []), reload: vi.fn() } }
    })
  })

  function primarySession(id: string) {
    return {
      id,
      kind: 'primary' as const,
      workspaceRoot: '/ws',
      mode: 'default' as const,
      permissionMode: 'request_approval' as const,
      createdAt: 1,
      updatedAt: 1,
      messageCount: 0,
      title: id,
      pinned: false
    }
  }

  it('A 会话的取消态不呈现到 B：停止按钮与「强制终止」横幅都不出现', () => {
    act(() => {
      useChatStore.setState({
        currentSessionId: 'sessB',
        isGenerating: false,
        sessions: [primarySession('sessB')]
      })
      useRunStore.setState({
        cancelling: true,
        cancellingSessionId: 'sessA',
        cancelGraceExceeded: true,
        forceTerminateRunId: 'runA'
      })
    })

    const renderer = renderDom(React.createElement(ChatPanel))
    expect(renderer.container.querySelector('[aria-label="正在停止"]')).toBeNull()
    expect(renderer.container.textContent ?? '').not.toContain('部分任务未退出')
    // B 的发送按钮保持正常
    expect(renderer.container.querySelector('[aria-label="发送"]')).not.toBeNull()
    renderer.unmount()
  })

  it('取消归属当前会话时停止按钮呈现，grace 前禁用', () => {
    act(() => {
      useChatStore.setState({
        currentSessionId: 'sessA',
        isGenerating: true,
        sessions: [primarySession('sessA')]
      })
      useRunStore.setState({
        cancelling: true,
        cancellingSessionId: 'sessA',
        cancelGraceExceeded: false
      })
    })

    const renderer = renderDom(React.createElement(ChatPanel))
    const stop = renderer.container.querySelector<HTMLButtonElement>('[aria-label="正在停止"]')
    expect(stop).not.toBeNull()
    expect(stop?.disabled).toBe(true)
    renderer.unmount()
  })

  it('中断横幅只在归属会话渲染，不跨会话出现', () => {
    act(() => {
      useChatStore.setState({
        currentSessionId: 'sessB',
        sessions: [primarySession('sessB')]
      })
      useRunStore.setState({
        interruptedRunId: 'runA',
        interruptedSessionId: 'sessA',
        interruptedSteps: []
      })
    })

    const renderer = renderDom(React.createElement(ChatPanel))
    expect(renderer.container.textContent ?? '').not.toContain('上次任务异常中断')

    // 切回属主会话 A：横幅恢复
    act(() => {
      useChatStore.setState({
        currentSessionId: 'sessA',
        sessions: [primarySession('sessA')]
      })
    })
    expect(renderer.container.textContent ?? '').toContain('上次任务异常中断')
    expect(renderer.container.textContent ?? '').toContain('继续分析')
    renderer.unmount()
  })

  it('切换会话时权限盾牌跟随会话属性，不沿用上一会话状态', () => {
    const sessionA = primarySession('sessA')
    const sessionB = { ...primarySession('sessB'), permissionMode: 'auto' as const }
    act(() => {
      useChatStore.setState({
        currentSessionId: 'sessA',
        sessions: [sessionA, sessionB]
      })
    })

    const renderer = renderDom(React.createElement(ChatPanel))
    expect(renderer.container.querySelector('[aria-haspopup="menu"]')?.textContent)
      .toContain('请求批准')

    act(() => {
      useChatStore.setState({ currentSessionId: 'sessB' })
    })
    expect(renderer.container.querySelector('[aria-haspopup="menu"]')?.textContent)
      .toContain('自动')
    renderer.unmount()
  })

  it('存在 pending 权限请求时禁用盾牌，Compose 保留既有单一自动入口', async () => {
    const session = primarySession('sessA')
    act(() => {
      useChatStore.setState({ currentSessionId: session.id, sessions: [session] })
      useAgentStore.setState({
        pendingPermissionRequest: {
          messageId: 'msg_1',
          requestId: 'perm_1',
          toolName: 'bash',
          args: { command: 'npm test' },
          riskLevel: 'low',
          reason: '需要确认',
          toolCallIds: ['tool_1']
        }
      })
    })

    const renderer = renderDom(React.createElement(ChatPanel))
    await act(async () => { await Promise.resolve() })
    expect(renderer.container.querySelector('[aria-haspopup="menu"][aria-disabled="true"]'))
      .not.toBeNull()

    await act(async () => {
      useAgentStore.setState({ pendingPermissionRequest: null })
      useSettingsStore.setState({ currentMode: 'compose' })
      useChatStore.setState({
        sessions: [{ ...session, mode: 'compose' }]
      })
      await Promise.resolve()
    })
    expect(renderer.container.querySelector('[aria-label="请求批准"], [aria-label="自动"]')).toBeNull()
    expect(renderer.container.textContent).toContain('全自动')
    renderer.unmount()
  })
})

/**
 * 发送被守卫拒绝时草稿保留。
 *
 * 回归对象：handleSend 曾无条件 setInputVal('')——sendMessage 返回 false（分叉准备窗口、
 * 缺工作区等）时用户输入凭空消失。Astryx ChatComposerInput 的 onSubmit 会无条件清空
 * 编辑器，因此发送必须挂在产品层 onKeyDown/按钮路径，拒绝后不得触碰 inputVal。
 */
describe('ChatPanel → sendMessage 拒绝时草稿与附件保留', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    messageItemPropsByRender.length = 0
    resetChatStoreForTests()
    resetSettingsStoreForTests()
    resetAgentStoreForTests()
    useRunStore.getState().resetForTests()
    mockInvoke.mockResolvedValue(undefined)
    Object.assign(window, {
      api: { invoke: mockInvoke, on: vi.fn(() => () => {}), removeAllListeners: vi.fn() },
      nova: { skill: { onChange: vi.fn(() => () => {}), list: vi.fn(() => []), reload: vi.fn() } }
    })
    // jsdom 未实现 scrollTo；发送成功追加消息会触发自动滚动 effect
    Object.defineProperty(window.HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      writable: true,
      value: vi.fn()
    })
    act(() => {
      useSettingsStore.setState({
        // 最小可用模型配置：让 handleSend 越过「未配置模型」的 alert 拦截
        modelConfig: { provider: 'openai', modelId: 'gpt-test', apiKey: 'test-key' } as never,
        currentProject: '/ws'
      })
      useWorkspaceStore.setState({ currentProjectPath: '/ws' })
      useChatStore.setState({
        currentSessionId: 'sess_1',
        isGenerating: false,
        sendInFlight: false
      })
    })
  })

  it('分叉准备窗口内发送被拒：草稿不被清空，未发 IPC', async () => {
    const renderer = renderDom(React.createElement(ChatPanel))
    const editable = renderer.container.querySelector(
      '[contenteditable="true"]'
    ) as HTMLElement | null
    expect(editable).not.toBeNull()

    act(() => {
      editable!.textContent = '被守卫拦下的草稿'
      editable!.dispatchEvent(new Event('input', { bubbles: true }))
    })
    // 分叉准备窗口锁住普通发送（sendMessage 返回 false）
    act(() => {
      useChatStore.setState({ branchForkInProgress: true })
    })

    const sendBtn = renderer.container.querySelector<HTMLElement>('[aria-label="发送"]')
    expect(sendBtn).not.toBeNull()
    await act(async () => {
      sendBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(editable!.textContent).toContain('被守卫拦下的草稿')
    const sendCalls = mockInvoke.mock.calls.filter(([channel]) => channel === 'send-message')
    expect(sendCalls).toHaveLength(0)
    renderer.unmount()
  })

  it('拒绝后解除分叉锁再次发送：同一草稿正常发出并清空', async () => {
    const renderer = renderDom(React.createElement(ChatPanel))
    const editable = renderer.container.querySelector(
      '[contenteditable="true"]'
    ) as HTMLElement | null

    act(() => {
      editable!.textContent = '保留后成功发送的草稿'
      editable!.dispatchEvent(new Event('input', { bubbles: true }))
      useChatStore.setState({ branchForkInProgress: true })
    })

    const sendBtn = renderer.container.querySelector<HTMLElement>('[aria-label="发送"]')
    await act(async () => {
      sendBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      await Promise.resolve()
    })
    // 第一次被拒后草稿仍在
    expect(editable!.textContent).toContain('保留后成功发送的草稿')

    // 分叉窗口结束：同一份草稿再点发送应真正发出并清空编辑器
    act(() => {
      useChatStore.setState({ branchForkInProgress: false })
    })
    await act(async () => {
      sendBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(mockInvoke).toHaveBeenCalledWith(
      'send-message',
      expect.objectContaining({ content: '保留后成功发送的草稿' })
    )
    expect(editable!.textContent ?? '').not.toContain('保留后成功发送的草稿')
    renderer.unmount()
  })
})
