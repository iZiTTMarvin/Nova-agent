import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatPanel } from '../../../src/renderer/features/chat/ChatPanel'
import { StreamingFileCard } from '../../../src/renderer/features/chat/StreamingFileCard'
import { ThinkingBlock } from '../../../src/renderer/features/chat/ThinkingBlock'
import { useAppStore, type ExtendedMessage } from '../../../src/renderer/stores/useAppStore'
import type { ModelConfig } from '../../../src/shared/config'
import { sanitizeToolInput } from '../../../src/shared/tool-input-sanitizer'

vi.mock('framer-motion', () => import('./_framerMotionMock'))
import { createNovaSkillMock } from './_novaSkillMock'

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
    // T06：MessageItem mount 时会调 get-message-diffs，需要提供默认 mock
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'get-message-diffs') {
        return Promise.resolve({ diffs: [], reviews: {} })
      }
      return Promise.resolve(undefined)
    })
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    vi.stubGlobal('document', {
      visibilityState: 'visible',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    })
    global.window = {
      ...global.window,
      api: {
        invoke: mockInvoke,
        on: mockOn,
        removeAllListeners: mockRemoveAllListeners
      },
      nova: { skill: createNovaSkillMock() },
      confirm: vi.fn(() => false),
      matchMedia: vi.fn().mockImplementation(() => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn()
      }))
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

  it('思考块结束后自动收起为 Thought 行（Cursor 风）', () => {
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

    // 结束后默认折叠，只留 Thought for Xs 一行
    expect(renderer!.root.findByType('details').props.open).toBe(false)
    const title = renderer!.root.findByProps({ className: 'thinking-block__title' })
    expect(String(title.children.join(''))).toMatch(/^Thought/)

    act(() => {
      renderer?.unmount()
    })
  })

  it('思考块将连续 Markdown 摘要渲染为独立标题，不暴露星号', () => {
    let renderer: TestRenderer.ReactTestRenderer | null = null
    act(() => {
      renderer = TestRenderer.create(
        React.createElement(ThinkingBlock, {
          thinking:
            '**Planning initial repository inspection****Drafting detailed implementation plan**',
          active: true
        })
      )
    })

    const headings = renderer!.root.findAllByType('strong')
    expect(headings).toHaveLength(2)
    expect(headings.map(node => node.children.join(''))).toEqual([
      'Planning initial repository inspection',
      'Drafting detailed implementation plan'
    ])
    expect(JSON.stringify(renderer!.toJSON())).not.toContain('****')

    act(() => {
      renderer?.unmount()
    })
  })

  it('T03：流式文件卡片完成后自动折叠，减少大段代码占用的视口', () => {
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

    // running 时自动展开
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

    // T03：完成后自动折叠，不再保持展开
    expect(renderer!.root.findAllByProps({ className: 'streaming-card__body' })).toHaveLength(0)

    act(() => {
      renderer?.unmount()
    })
  })

  it('加载带摘要化 write 的历史会话时不应白屏（TurnProcessTree 默认折叠 L3）', () => {
    const sanitizedWriteArgs = sanitizeToolInput('write', {
      path: 'index.html',
      content: '<!doctype html>\n' + '<section>hello</section>\n'.repeat(600)
    })

    const messages: ExtendedMessage[] = [
      {
        id: 'msg_assistant_summary',
        sessionId: 'sess_chat_experience',
        role: 'assistant',
        content: '已生成个人主页',
        blocks: [
          {
            type: 'tool',
            toolCallId: 'tc_write_summary',
            toolName: 'write',
            arguments: sanitizedWriteArgs,
            status: 'success'
          }
        ],
        timestamp: 3
      }
    ]

    resetStore(messages)

    let renderer: TestRenderer.ReactTestRenderer | null = null
    act(() => {
      renderer = TestRenderer.create(React.createElement(ChatPanel))
    })

    // completed 默认 L1 折叠：过程树头可见，L3 不 mount
    const l1 = renderer!.root.findByProps({ 'data-testid': 'turn-process-l1' })
    expect(String(l1.findByProps({ className: 'turn-process-tree__l1-title' }).children.join(''))).toMatch(/^Worked/)
    expect(renderer!.root.findAllByProps({ className: 'tool-trace-row' })).toHaveLength(0)
    expect(renderer!.root.findAllByProps({ className: 'streaming-card__filename' })).toHaveLength(0)

    // 展开 L1 → L2 后仍无 L3
    act(() => {
      l1.props.onClick()
    })
    expect(renderer!.root.findAllByProps({ className: 'tool-trace-row' })).toHaveLength(0)

    // 展开 L2 → 挂载 L3 等宽行
    const l2 = renderer!.root.findByProps({ 'data-testid': 'turn-process-l2' })
    act(() => {
      l2.props.onClick()
    })
    const action = renderer!.root.findByProps({ className: 'tool-trace-row__action' })
    expect(action.children).toEqual(['Wrote'])
    const target = renderer!.root.findByProps({ className: 'tool-trace-row__target' })
    expect(String(target.children.join(''))).toContain('index.html')
    expect(renderer!.root.findAllByProps({ className: 'tool-trace-row__detail' })).toHaveLength(0)

    act(() => {
      renderer?.unmount()
    })
  })

  it('底部工具栏不再常驻显示独立 UsageStats，避免与上下文指示器混淆', () => {
    useAppStore.setState({
      sessionUsage: {
        totalPromptTokens: 1000,
        totalCompletionTokens: 120,
        totalCachedTokens: 390,
        totalCacheWriteTokens: 80,
        hitRate: 0.39
      },
      contextBreakdown: {
        sessionId: 'sess_chat_experience',
        messageId: '',
        breakdown: {
          systemPrompt: 300,
          skills: 200,
          tools: 100,
          messages: 500,
          other: 0
        },
        totalEstimated: 1100,
        promptTokensActual: 1000,
        capturedAt: 1,
        contextLimit: 200_000
      }
    })

    let renderer: TestRenderer.ReactTestRenderer | null = null
    act(() => {
      renderer = TestRenderer.create(React.createElement(ChatPanel))
    })

    expect(renderer!.root.findAllByProps({ className: 'usage-stats' })).toHaveLength(0)
    expect(renderer!.root.findAllByProps({ className: 'context-indicator-wrap' })).toHaveLength(1)

    act(() => {
      renderer?.unmount()
    })
  })
})
