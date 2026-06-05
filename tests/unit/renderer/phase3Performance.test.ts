import React, { Profiler } from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatPanel } from '../../../src/renderer/features/chat/ChatPanel'
import { useAppStore, type ExtendedMessage } from '../../../src/renderer/stores/useAppStore'
import type { ModelConfig } from '../../../src/shared/config'

vi.mock('framer-motion', () => import('./_framerMotionMock'))

const mockInvoke = vi.fn()
const mockOn = vi.fn()
const mockRemoveAllListeners = vi.fn()

global.window = {
  ...global.window,
  api: {
    invoke: mockInvoke,
    on: mockOn,
    removeAllListeners: mockRemoveAllListeners
  },
  confirm: vi.fn(() => false)
} as unknown as Window & typeof globalThis

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
    pendingVerificationRequest: null,
    messageDiffs: {},
    loadingDiffs: new Set(),
    loadingDiffPlaceholders: {}
  })

  return streamingMessage.id
}

function getStats(values: number[]) {
  const max = Math.max(...values)
  const avg = values.reduce((sum, value) => sum + value, 0) / values.length
  return { max, avg }
}

describe('Phase 3 渲染性能回归', () => {
  beforeEach(() => {
    vi.clearAllMocks()
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
      pendingVerificationRequest: null,
      messageDiffs: {},
      loadingDiffs: new Set(),
      loadingDiffPlaceholders: {}
    })
  })

  it('T5-3: 50 条历史消息下单次 thinking delta 更新不应出现 >50ms 长任务', () => {
    const messageId = seedLongConversation()
    const durations: number[] = []

    for (let i = 0; i < 120; i++) {
      const start = performance.now()
      useAppStore.getState().handleThinkingDelta(messageId, '推理中 ')
      durations.push(performance.now() - start)
    }

    const stats = getStats(durations)
    console.info(
      `[phase3] thinking delta: samples=${durations.length}, max=${stats.max.toFixed(3)}ms, avg=${stats.avg.toFixed(3)}ms`
    )

    expect(stats.max).toBeLessThan(50)
  })

  it('T5-3: React Profiler 下 ChatPanel 单次 update commit 时间应保持在 50ms 内', () => {
    const messageId = seedLongConversation()
    const commitDurations: number[] = []

    let renderer: TestRenderer.ReactTestRenderer | null = null

    act(() => {
      renderer = TestRenderer.create(
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
    })

    for (let i = 0; i < 120; i++) {
      act(() => {
        useAppStore.getState().handleTextDelta(messageId, 'x')
      })
    }

    const stats = getStats(commitDurations)
    console.info(
      `[phase3] chatpanel profiler: samples=${commitDurations.length}, max=${stats.max.toFixed(3)}ms, avg=${stats.avg.toFixed(3)}ms`
    )

    expect(commitDurations.length).toBeGreaterThan(0)
    expect(stats.max).toBeLessThan(50)

    act(() => {
      renderer?.unmount()
    })
  })
})
