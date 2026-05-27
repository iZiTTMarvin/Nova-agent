import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatPanel } from '../../../src/renderer/features/chat/ChatPanel'
import { StreamingFileCard } from '../../../src/renderer/features/chat/StreamingFileCard'
import { ThinkingBlock } from '../../../src/renderer/features/chat/ThinkingBlock'
import { useAppStore, type ExtendedMessage } from '../../../src/renderer/stores/useAppStore'
import type { ModelConfig } from '../../../src/shared/config'

const mockInvoke = vi.fn()
const mockOn = vi.fn()
const mockRemoveAllListeners = vi.fn()

const MODEL_CONFIG: ModelConfig = {
  baseUrl: 'https://example.com/v1',
  apiKey: 'test-key',
  modelId: 'test-model'
}

function buildMessageIndex(messages: ExtendedMessage[]): Record<string, number> {
  return Object.fromEntries(messages.map((message, index) => [message.id, index]))
}

function resetStore(messages: ExtendedMessage[] = []) {
  useAppStore.setState({
    currentProject: 'D:/visual_ProgrammingSoftware/A_Projects/nova-agent',
    currentMode: 'default',
    sessions: [],
    currentSessionId: 'sess_chat_experience',
    messages,
    messageIndexById: buildMessageIndex(messages),
    isGenerating: false,
    currentGeneratingMessageId: null,
    modelConfig: MODEL_CONFIG,
    isConfigModalOpen: false,
    pendingPermissionRequest: null,
    isSubmittingPermission: false,
    permissionError: null,
    pendingVerificationRequest: null,
    messageDiffs: {},
    loadingDiffs: new Set(),
    loadingDiffPlaceholders: {},
    streamingToolArgs: {}
  })
}

describe('聊天体验回归', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    global.window = {
      ...global.window,
      api: {
        invoke: mockInvoke,
        on: mockOn,
        removeAllListeners: mockRemoveAllListeners
      },
      confirm: vi.fn(() => false)
    } as unknown as Window & typeof globalThis
    resetStore()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('assistant 消息开始但尚无内容时展示等待态，不渲染空白气泡', () => {
    const messages: ExtendedMessage[] = [
      {
        id: 'msg_user',
        sessionId: 'sess_chat_experience',
        role: 'user',
        content: '你好',
        timestamp: 1
      },
      {
        id: 'msg_assistant',
        sessionId: 'sess_chat_experience',
        role: 'assistant',
        content: '',
        thinking: '',
        toolCalls: [],
        blocks: [],
        timestamp: 2
      }
    ]
    resetStore(messages)
    useAppStore.setState({
      isGenerating: true,
      currentGeneratingMessageId: 'msg_assistant'
    })

    let renderer: TestRenderer.ReactTestRenderer | null = null
    act(() => {
      renderer = TestRenderer.create(React.createElement(ChatPanel))
    })

    const pending = renderer!.root.findByProps({ className: 'assistant-pending' })
    expect(pending.findByProps({ className: 'assistant-pending__label' }).children).toEqual(['正在思考'])

    act(() => {
      renderer?.unmount()
    })
  })

  it('思考块完成后保持展开状态，避免页面高度突然塌陷', () => {
    let renderer: TestRenderer.ReactTestRenderer | null = null
    act(() => {
      renderer = TestRenderer.create(
        React.createElement(ThinkingBlock, { thinking: '先分析调用链', active: true })
      )
    })

    expect(renderer!.root.findByType('details').props.open).toBe(true)

    act(() => {
      renderer!.update(
        React.createElement(ThinkingBlock, { thinking: '先分析调用链', active: false })
      )
    })

    expect(renderer!.root.findByType('details').props.open).toBe(true)

    act(() => {
      renderer?.unmount()
    })
  })

  it('流式文件卡片完成后保持展开状态，避免大段代码预览突然收起', () => {
    const args = {
      path: 'src/example.ts',
      content: 'export const value = 1\nexport const next = 2'
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

    expect(renderer!.root.findAllByProps({ className: 'streaming-card__body' })).toHaveLength(1)

    act(() => {
      renderer!.update(
        React.createElement(StreamingFileCard, {
          toolCallId: 'tc_1',
          toolName: 'write',
          status: 'success',
          args
        })
      )
    })

    expect(renderer!.root.findAllByProps({ className: 'streaming-card__body' })).toHaveLength(1)

    act(() => {
      renderer?.unmount()
    })
  })
})
