// @vitest-environment jsdom

import React, { Profiler } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatPanel } from '../../../src/renderer/features/chat/ChatPanel'
import { useAppStore, type ExtendedMessage } from '../../../src/renderer/stores/useAppStore'
import type { ModelConfig } from '../../../src/shared/config'
import { act, renderDom } from './renderDom'

vi.mock('framer-motion', () => import('./_framerMotionMock'))
import { createNovaSkillMock } from './_novaSkillMock'

const mockInvoke = vi.fn()
const mockOn = vi.fn()
const mockRemoveAllListeners = vi.fn()

Object.assign(window, {
  api: {
    invoke: mockInvoke,
    on: mockOn,
    removeAllListeners: mockRemoveAllListeners
  },
  nova: { skill: createNovaSkillMock() },
  confirm: vi.fn(() => false)
})

const MODEL_CONFIG: ModelConfig = {
  baseUrl: 'https://example.com/v1',
  apiKey: 'test-key',
  modelId: 'test-model'
}

function buildMessageIndex(messages: ExtendedMessage[]): Record<string, number> {
  return Object.fromEntries(messages.map((message, index) => [message.id, index]))
}

function createMessage(id: string, role: ExtendedMessage['role'], content: string): ExtendedMessage {
  return {
    id,
    sessionId: 'sess_phase3',
    role,
    content,
    timestamp: Number(id.replace(/\D/g, '')) || Date.now(),
    thinking: '',
    blocks: content ? [{ type: 'text', content }] : [],
    toolCalls: []
  }
}

function seedLongConversation(): string {
  const history = Array.from({ length: 49 }, (_, index) =>
    createMessage(`msg_history_${index}`, index % 2 === 0 ? 'user' : 'assistant', `历史消息 ${index}`)
  )
  const streamingMessage = createMessage('msg_stream', 'assistant', '')
  const messages = [...history, streamingMessage]

  useAppStore.setState({
    currentProject: 'D:/visual_ProgrammingSoftware/A_Projects/nova-agent',
    currentMode: 'default',
    sessions: [],
    currentSessionId: 'sess_phase3',
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
    liveTurn: {}
  })

  return streamingMessage.id
}

function getStats(values: number[]) {
  const max = Math.max(...values)
  const avg = values.reduce((sum, value) => sum + value, 0) / values.length
  return { max, avg }
}

describe('长对话流式渲染性能回归', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // T06：MessageItem mount 时会调 get-message-diffs，需要提供默认 mock 返回
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'get-message-diffs') {
        return Promise.resolve({ diffs: [], reviews: {} })
      }
      return Promise.resolve(undefined)
    })
    useAppStore.setState({
      currentProject: null,
      currentMode: 'default',
      sessions: [],
      currentSessionId: null,
      messages: [],
      messageIndexById: {},
      isGenerating: false,
      currentGeneratingMessageId: null,
      modelConfig: null,
      isConfigModalOpen: false,
      pendingPermissionRequest: null,
      isSubmittingPermission: false,
      permissionError: null,
      messageDiffs: {},
      loadingDiffs: new Set(),
      loadingDiffPlaceholders: {}
    })
  })

  it('50 条历史消息下单次流式 thinking delta（applyStreamDeltas）不应出现 >50ms 长任务', () => {
    const messageId = seedLongConversation()
    const durations: number[] = []

    for (let i = 0; i < 120; i++) {
      const start = performance.now()
      useAppStore.getState().applyStreamDeltas([
        { kind: 'thinking', messageId, delta: '推理中 ' }
      ])
      durations.push(performance.now() - start)
    }

    const stats = getStats(durations)
    console.info(
      `[phase3] thinking delta: samples=${durations.length}, max=${stats.max.toFixed(3)}ms, avg=${stats.avg.toFixed(3)}ms`
    )

    expect(stats.max).toBeLessThan(50)
  })

  it('纯文本流式（applyStreamDeltas）期间 messages 引用稳定，ChatPanel 不再每帧重提交', () => {
    const messageId = seedLongConversation()
    const commitDurations: number[] = []

    const renderer = renderDom(
      React.createElement(
        Profiler,
        {
          id: 'ChatPanel',
          onRender: (_id, phase, actualDuration) => {
            if (phase === 'update') {
              commitDurations.push(actualDuration)
            }
          }
        },
        React.createElement(ChatPanel)
      )
    )

    // 单次同步 applyStreamDeltas(text) 不得改动 messages 引用——这是 ChatPanel
    // 不再每帧重提交的根本（同步调用，排除水合等异步副作用干扰）。
    const messagesRefBefore = useAppStore.getState().messages
    useAppStore.getState().applyStreamDeltas([{ kind: 'text', messageId, delta: 'x' }])
    expect(useAppStore.getState().messages).toBe(messagesRefBefore)
    expect(useAppStore.getState().liveTurn[messageId]).toMatchObject({ type: 'text', content: 'x' })

    for (let i = 0; i < 120; i++) {
      act(() => {
        useAppStore.getState().applyStreamDeltas([
          { kind: 'text', messageId, delta: 'x' }
        ])
      })
    }

    // 活跃 MessageItem 仍按 liveTurn 独立重渲染，其每次 commit 必须远低于帧预算
    const stats = getStats(commitDurations)
    console.info(
      `[phase3] chatpanel profiler: samples=${commitDurations.length}, max=${stats.max.toFixed(3)}ms, avg=${stats.avg.toFixed(3)}ms`
    )
    if (commitDurations.length > 0) {
      expect(stats.max).toBeLessThan(50)
    }

    renderer.unmount()
  })
})
