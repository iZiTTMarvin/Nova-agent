// @vitest-environment jsdom

import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatPanel } from '../../../src/renderer/features/chat/ChatPanel'
import { StreamingFileCard } from '../../../src/renderer/features/chat/StreamingFileCard'
import { ThinkingBlock } from '../../../src/renderer/features/chat/ThinkingBlock'
import { useAppStore, type ExtendedMessage } from '../../../src/renderer/stores/useAppStore'
import type { ModelConfig } from '../../../src/shared/config'
import { sanitizeToolInput } from '../../../src/shared/tool-input-sanitizer'
import { act, renderDom } from './renderDom'

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
    messageDiffs: {},
    loadingDiffs: new Set(),
    loadingDiffPlaceholders: {},
    streamingToolArgs: {}
  })
}

describe('聊天体验回归', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // MessageItem mount 时会调 get-message-diffs，需要提供默认 mock
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'get-message-diffs') {
        return Promise.resolve({ diffs: [], reviews: {} })
      }
      return Promise.resolve(undefined)
    })
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible'
    })
    Object.assign(window, {
      api: {
        invoke: mockInvoke,
        on: mockOn,
        removeAllListeners: mockRemoveAllListeners
      },
      nova: { skill: createNovaSkillMock() },
      confirm: vi.fn(() => false)
    })
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

    const renderer = renderDom(React.createElement(ChatPanel))
    const pending = renderer.container.querySelector('.assistant-pending')
    expect(pending?.querySelector('.assistant-pending__label')?.textContent).toBe('正在思考')

    renderer.unmount()
  })

  it('思考块结束后自动收起为 Thought 行（Cursor 风）', () => {
    const renderer = renderDom(React.createElement(ThinkingBlock, { thinking: '先分析调用链', active: true }))

    expect(renderer.container.querySelector('.thinking-block__summary')?.getAttribute('aria-expanded')).toBe('true')

    renderer.render(React.createElement(ThinkingBlock, { thinking: '先分析调用链', active: false }))

    // 结束后默认折叠，只留 Thought for Xs 一行
    expect(renderer.container.querySelector('.thinking-block__summary')?.getAttribute('aria-expanded')).toBe('false')
    const title = renderer.container.querySelector('.thinking-block__title')
    expect(title?.textContent ?? '').toMatch(/^Thought/)

    renderer.unmount()
  })

  it('思考块将连续 Markdown 摘要渲染为独立标题，不暴露星号', () => {
    const renderer = renderDom(React.createElement(ThinkingBlock, {
      thinking: '**Planning initial repository inspection****Drafting detailed implementation plan**',
      active: true
    }))

    const headings = renderer.container.querySelectorAll('strong')
    expect(headings).toHaveLength(2)
    expect(Array.from(headings).map(node => node.textContent ?? '')).toEqual([
      'Planning initial repository inspection',
      'Drafting detailed implementation plan'
    ])
    expect(renderer.container.innerHTML).not.toContain('****')

    renderer.unmount()
  })

  it('流式文件卡片完成后自动折叠，减少大段代码占用的视口', () => {
    const args = {
      path: 'src/example.ts',
      content: 'export const value = 1\nexport const next = 2'
    }
    const renderer = renderDom(React.createElement(StreamingFileCard, {
      toolCallId: 'tc_1',
      toolName: 'write',
      status: 'running',
      args
    }))

    // running 时自动展开
    expect(renderer.container.querySelectorAll('.streaming-card__body')).toHaveLength(1)

    renderer.render(React.createElement(StreamingFileCard, {
      toolCallId: 'tc_1',
      toolName: 'write',
      status: 'success',
      args
    }))

    // 完成后自动折叠，不再保持展开
    expect(renderer.container.querySelectorAll('.streaming-card__body')).toHaveLength(0)

    renderer.unmount()
  })

  it('加载带摘要化 write 的历史会话时不应白屏（TurnProcessTree 默认折叠过程时间线）', () => {
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

    const renderer = renderDom(React.createElement(ChatPanel))

    // completed 默认折叠：折叠头可见，过程时间线不 mount
    const header = renderer.container.querySelector<HTMLElement>('[data-testid="turn-process-header"]')
    expect(header).not.toBeNull()
    expect(header?.querySelector('.turn-process-tree__header-title')?.textContent ?? '').toMatch(/^已工作/)
    expect(renderer.container.querySelectorAll('.tool-trace-row')).toHaveLength(0)
    expect(renderer.container.querySelectorAll('.streaming-card__filename')).toHaveLength(0)

    // 展开折叠头 → 挂载过程时间线等宽行
    act(() => header?.click())
    expect(renderer.container.querySelector('.tool-trace-row__action')?.textContent).toBe('Wrote')
    expect(renderer.container.querySelector('.tool-trace-row__target')?.textContent ?? '').toContain('index.html')
    expect(renderer.container.querySelectorAll('.tool-trace-row__detail')).toHaveLength(0)

    renderer.unmount()
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

    const renderer = renderDom(React.createElement(ChatPanel))

    expect(renderer.container.querySelectorAll('.usage-stats')).toHaveLength(0)
    expect(renderer.container.querySelectorAll('.context-indicator-wrap')).toHaveLength(1)

    renderer.unmount()
  })
})
