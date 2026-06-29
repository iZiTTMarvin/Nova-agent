import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatPanel } from '../../../src/renderer/features/chat/ChatPanel'
import { useChatStore, resetChatStoreForTests } from '../../../src/renderer/stores/useChatStore'
import { resetSettingsStoreForTests } from '../../../src/renderer/stores/useSettingsStore'
import { useAgentStore, resetAgentStoreForTests } from '../../../src/renderer/stores/useAgentStore'
import type { ExtendedMessage } from '../../../src/renderer/stores/types'

/**
 * ChatPanel 接线测试（修 GPT P2 指出的测试缺口）。
 *
 * 本次 bug 的本质：MessageItem 侧 isPausedForInput 全部就绪，但 ChatPanel 渲染时漏传 →
 * askQuestion 等待期间流式动画常驻循环不停 → 卡死。sendOrchestration.test.ts 只验证
 * preSendGate 逻辑，无法捕捉"接线是否真的传了 isPausedForInput"。本文件通过 mock
 * MessageItem 捕获其实际收到的 props，断言 pendingAskQuestion 真值性正确流向 isPausedForInput。
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
vi.mock('../../../src/renderer/features/skills/SkillAC', () => ({
  SkillAC: React.forwardRef(() => null)
}))
vi.mock('../../../src/renderer/components/Icons', () => ({
  SendIcon: () => null,
  StopIcon: () => null,
  NovaLogo: () => null,
  ImageIcon: () => null
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
    global.window = {
      ...global.window,
      api: { invoke: mockInvoke, on: vi.fn(() => () => {}), removeAllListeners: vi.fn() },
      nova: {
        skill: {
          onChange: vi.fn(() => () => {}),
          list: vi.fn(() => [])
        }
      }
    } as unknown as Window & typeof globalThis

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

    let renderer: TestRenderer.ReactTestRenderer | null = null
    act(() => {
      renderer = TestRenderer.create(React.createElement(ChatPanel))
    })
    act(() => {
      renderer?.unmount()
    })

    const captured = messageItemPropsByRender.find(p => p.msgId === 'msg_1')
    expect(captured).toBeDefined()
    expect(captured!.isPausedForInput).toBe(false)
  })

  it('有 pending askQuestion 时（面板开着等回答），MessageItem 收到 isPausedForInput=true', () => {
    act(() => {
      useChatStore.setState({
        currentSessionId: 'sess_1',
        messages: [makeAssistantMessage('msg_1')]
      })
    })

    let renderer: TestRenderer.ReactTestRenderer | null = null
    act(() => {
      renderer = TestRenderer.create(React.createElement(ChatPanel))
    })

    // 切到 askQuestion 面板打开，触发 ChatPanel 重渲染
    act(() => {
      useAgentStore.setState({
        pendingAskQuestion: {
          requestId: 'req_1',
          questions: [
            { id: 'q1', question: '选哪个？', type: 'single-select', options: [{ id: 'a', label: 'A' }] }
          ]
        }
      })
    })
    act(() => {
      renderer?.unmount()
    })

    // 取面板打开后最近一次该消息的渲染
    const captured = messageItemPropsByRender.filter(p => p.msgId === 'msg_1').pop()
    expect(captured).toBeDefined()
    expect(captured!.isPausedForInput).toBe(true)
  })
})
