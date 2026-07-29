import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resetAgentStoreForTests } from '../../../src/renderer/stores/useAgentStore'
import { resetChatStoreForTests, useChatStore } from '../../../src/renderer/stores/useChatStore'
import {
  resetWorkspaceStoreForTests,
  useWorkspaceStore
} from '../../../src/renderer/stores/useWorkspaceStore'

const mockInvoke = vi.fn()

function assertMessageIndexConsistent(): void {
  const { messages, messageIndexById } = useChatStore.getState()
  expect(Object.keys(messageIndexById).length).toBe(messages.length)
  for (let i = 0; i < messages.length; i++) {
    expect(messageIndexById[messages[i].id]).toBe(i)
  }
}

function buildMessages(count: number, sessionId = 'sess-1') {
  return Array.from({ length: count }, (_, i) => ({
    id: `msg_${i}`,
    sessionId,
    role: (i % 2 === 0 ? 'user' : 'assistant') as const,
    content: `c_${i}`,
    timestamp: i,
    _revision: 0
  }))
}

describe('chat message invariants baseline', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    mockInvoke.mockReset()
    mockInvoke.mockResolvedValue(undefined)
    resetAgentStoreForTests()
    resetChatStoreForTests()
    resetWorkspaceStoreForTests()
    global.window = {
      ...global.window,
      api: {
        invoke: mockInvoke,
        on: vi.fn(() => () => {}),
        removeAllListeners: vi.fn()
      }
    } as unknown as Window & typeof globalThis
  })

  it('每个流式写入 action 执行后立即保持 messageIndexById 一致', () => {
    useChatStore.setState({ currentSessionId: 'sess-1', isGenerating: true })

    useChatStore.getState().handleMessageStart('msg_a')
    assertMessageIndexConsistent()

    useChatStore.getState().handleThinkingDelta('msg_a', 'thinking')
    assertMessageIndexConsistent()

    useChatStore.getState().handleTextDelta('msg_a', 'hello')
    assertMessageIndexConsistent()

    useChatStore.getState().handleAttemptFailed('msg_a', 'attempt_1')
    assertMessageIndexConsistent()

    useChatStore.getState().handleToolCallStart('msg_a', 'tc_1', 'write')
    assertMessageIndexConsistent()

    useChatStore.getState().handleToolCallDelta('msg_a', 'tc_1', '{"path":"a.ts"}')
    assertMessageIndexConsistent()

    useChatStore.getState().handleToolCall('msg_a', 'tc_1', 'write', { path: 'a.ts', content: 'x' })
    assertMessageIndexConsistent()

    useChatStore.getState().handleToolResult('msg_a', 'tc_1', 'write', 'ok')
    assertMessageIndexConsistent()

    useChatStore.getState().applyStreamDeltas([{ kind: 'text', messageId: 'msg_a', delta: ' world' }])
    assertMessageIndexConsistent()
  })

  it('sendMessage 追加用户消息后保持索引一致', async () => {
    useWorkspaceStore.setState({ currentProjectPath: '/tmp/project' })
    useChatStore.setState({ currentSessionId: 'sess-1' })

    const sent = await useChatStore.getState().sendMessage('hello')

    expect(sent).toBe(true)
    expect(useChatStore.getState().messages.at(-1)?.role).toBe('user')
    assertMessageIndexConsistent()
  })

  it('sendMessage 追加越过窗口上限时裁掉最早消息', async () => {
    const messages = buildMessages(240)
    useWorkspaceStore.setState({ currentProjectPath: '/tmp/project' })
    useChatStore.setState({
      currentSessionId: 'sess-1',
      messages,
      messageIndexById: Object.fromEntries(messages.map((message, index) => [message.id, index])),
      suspendHeadTrim: false
    })

    const sent = await useChatStore.getState().sendMessage('new tail')

    expect(sent).toBe(true)
    const state = useChatStore.getState()
    expect(state.messages).toHaveLength(240)
    expect(state.messages[0].id).toBe('msg_1')
    expect(state.messages.at(-1)).toMatchObject({ role: 'user', content: 'new tail' })
    assertMessageIndexConsistent()
  })

  it('sendMessage 失败回滚消息树后保持索引一致', async () => {
    const messages = buildMessages(4)
    const messageIndexById = Object.fromEntries(messages.map((message, index) => [message.id, index]))
    useWorkspaceStore.setState({ currentProjectPath: '/tmp/project' })
    vi.spyOn(useWorkspaceStore.getState(), 'bumpMessagesRevision').mockResolvedValue()
    mockInvoke.mockRejectedValueOnce(new Error('send failed'))
    useChatStore.setState({
      currentSessionId: 'sess-1',
      messages,
      messageIndexById
    })

    await useChatStore.getState().sendMessage('replacement', undefined, {
      rollbackSnapshot: { messages, messageIndexById }
    })

    expect(useChatStore.getState().messages).toEqual(messages)
    assertMessageIndexConsistent()
  })

  it('editResend 截断并重新追加后保持索引一致', async () => {
    const messages = buildMessages(4)
    const messageIndexById = Object.fromEntries(messages.map((message, index) => [message.id, index]))
    useWorkspaceStore.setState({ currentProjectPath: '/tmp/project' })
    vi.spyOn(useWorkspaceStore.getState(), 'prepareEditResend').mockResolvedValue()
    useChatStore.setState({
      currentSessionId: 'sess-1',
      messages,
      messageIndexById
    })

    await useChatStore.getState().editResend('sess-1', 'msg_2', 'updated')

    const state = useChatStore.getState()
    expect(state.messages).toHaveLength(3)
    expect(state.messages.slice(0, 2).map((message) => message.id)).toEqual(['msg_0', 'msg_1'])
    expect(state.messages[2].content).toBe('updated')
    assertMessageIndexConsistent()
  })

  it('loadOlderMessages prepend 后立即保持索引一致', async () => {
    const current = buildMessages(2)
    useChatStore.setState({
      currentSessionId: 'sess-1',
      messages: current,
      messageIndexById: Object.fromEntries(current.map((message, index) => [message.id, index])),
      hasMoreMessagesAbove: true,
      oldestLoadedMessageId: 'msg_0'
    })
    mockInvoke.mockResolvedValueOnce({
      messages: [{ id: 'older_1', sessionId: 'sess-1', role: 'user', content: 'older', timestamp: -1 }],
      hasMore: false
    })

    await useChatStore.getState().loadOlderMessages()

    expect(useChatStore.getState().messages[0].id).toBe('older_1')
    assertMessageIndexConsistent()
  })

  it('loadOlderMessages prepend 超过窗口上限时保留完整补载结果', async () => {
    const current = buildMessages(240)
    useChatStore.setState({
      currentSessionId: 'sess-1',
      messages: current,
      messageIndexById: Object.fromEntries(current.map((message, index) => [message.id, index])),
      hasMoreMessagesAbove: true,
      oldestLoadedMessageId: 'msg_0',
      suspendHeadTrim: false
    })
    mockInvoke.mockResolvedValueOnce({
      messages: Array.from({ length: 10 }, (_, index) => ({
        id: `older_${index}`,
        sessionId: 'sess-1',
        role: 'user',
        content: `older ${index}`,
        timestamp: index - 10
      })),
      hasMore: false
    })

    await useChatStore.getState().loadOlderMessages()

    const state = useChatStore.getState()
    expect(state.messages).toHaveLength(250)
    expect(state.messages[0].id).toBe('older_0')
    expect(state.messages.at(-1)?.id).toBe('msg_239')
    expect(state.suspendHeadTrim).toBe(true)
    assertMessageIndexConsistent()
  })

  it('handleMessageEnd 与 handleError 各分支写入后分别保持索引一致', async () => {
    const messages = buildMessages(2)
    messages[1] = {
      ...messages[1],
      role: 'assistant',
      blocks: [{
        type: 'tool',
        toolCallId: 'tc_1',
        toolName: 'write',
        arguments: {},
        argumentsRaw: '{}',
        status: 'running'
      }],
      toolCalls: [{
        id: 'tc_1',
        name: 'write',
        arguments: {},
        argumentsRaw: '{}',
        status: 'running'
      }]
    }
    useChatStore.setState({
      messages,
      messageIndexById: Object.fromEntries(messages.map((message, index) => [message.id, index])),
      isGenerating: true,
      currentGeneratingMessageId: 'msg_1',
      activeAgentSessionId: 'sess-1'
    })

    await useChatStore.getState().handleMessageEnd('msg_1', true)
    assertMessageIndexConsistent()

    await useChatStore.getState().handleError('msg_1', 'existing message failed')
    assertMessageIndexConsistent()

    await useChatStore.getState().handleError('error_before_start', 'early failure')
    expect(useChatStore.getState().messageIndexById.error_before_start).toBe(2)
    assertMessageIndexConsistent()
  })

  it('markRunningAsCancelled 更新运行中工具后保持索引一致', async () => {
    const messages = buildMessages(2)
    messages[1] = {
      ...messages[1],
      role: 'assistant',
      blocks: [{
        type: 'tool',
        toolCallId: 'tc_1',
        toolName: 'write',
        arguments: {},
        argumentsRaw: '{}',
        status: 'running'
      }],
      toolCalls: [{
        id: 'tc_1',
        name: 'write',
        arguments: {},
        argumentsRaw: '{}',
        status: 'running'
      }]
    }
    useChatStore.setState({
      messages,
      messageIndexById: Object.fromEntries(messages.map((message, index) => [message.id, index])),
      isGenerating: true,
      currentGeneratingMessageId: 'msg_1'
    })

    await useChatStore.getState().markRunningAsCancelled()
    const cancelled = useChatStore.getState().messages[1]
    expect(cancelled.blocks?.[0]).toMatchObject({ status: 'error', result: '用户取消执行' })
    assertMessageIndexConsistent()
  })

  it('流式路径超过阈值后头部裁剪并保留尾部窗口', () => {
    const msgs = buildMessages(241)
    const index = Object.fromEntries(msgs.map((m, i) => [m.id, i]))
    useChatStore.setState({
      currentSessionId: 'sess-1',
      messages: msgs,
      messageIndexById: index,
      isGenerating: true,
      currentGeneratingMessageId: 'msg_240',
      suspendHeadTrim: false
    })

    useChatStore.getState().applyStreamDeltas([{ kind: 'text', messageId: 'msg_240', delta: 'tail' }])
    const state = useChatStore.getState()
    expect(state.messages).toHaveLength(240)
    expect(state.messages[0].id).toBe('msg_1')
    expect(state.messages[239].id).toBe('msg_240')
    assertMessageIndexConsistent()
  })

  it('suspendHeadTrim=true 时流式路径不裁剪', () => {
    const msgs = buildMessages(241)
    const index = Object.fromEntries(msgs.map((m, i) => [m.id, i]))
    useChatStore.setState({
      currentSessionId: 'sess-1',
      messages: msgs,
      messageIndexById: index,
      isGenerating: true,
      currentGeneratingMessageId: 'msg_240',
      suspendHeadTrim: true
    })

    useChatStore.getState().applyStreamDeltas([{ kind: 'text', messageId: 'msg_240', delta: 'tail' }])
    expect(useChatStore.getState().messages).toHaveLength(241)
    assertMessageIndexConsistent()
  })

  it('裁剪后分页游标同步到新窗口首条', () => {
    const msgs = buildMessages(241)
    const index = Object.fromEntries(msgs.map((m, i) => [m.id, i]))
    useChatStore.setState({
      currentSessionId: 'sess-1',
      messages: msgs,
      messageIndexById: index,
      isGenerating: true,
      currentGeneratingMessageId: 'msg_240',
      oldestLoadedMessageId: 'msg_0',
      hasMoreMessagesAbove: false
    })

    useChatStore.getState().applyStreamDeltas([{ kind: 'text', messageId: 'msg_240', delta: 'tail' }])
    const state = useChatStore.getState()
    expect(state.oldestLoadedMessageId).toBe('msg_1')
    expect(state.hasMoreMessagesAbove).toBe(true)
  })

  it('非流式路径（message_start）当前行为不过窗口裁剪', () => {
    const msgs = buildMessages(240)
    const index = Object.fromEntries(msgs.map((m, i) => [m.id, i]))
    useChatStore.setState({
      currentSessionId: 'sess-1',
      messages: msgs,
      messageIndexById: index
    })

    useChatStore.getState().handleMessageStart('msg_240_new')
    const state = useChatStore.getState()
    expect(state.messages).toHaveLength(241)
    expect(state.messages[240].id).toBe('msg_240_new')
    assertMessageIndexConsistent()
  })

  it('水合路径（syncFromWorkspace）当前行为不过窗口裁剪', async () => {
    const large = buildMessages(300).map(({ _revision, ...m }) => m)
    mockInvoke.mockImplementation(async (channel: string) => {
      if (channel === 'run:get-snapshot') return { snapshot: null, waitingSessions: [] }
      if (channel === 'load-session') {
        return {
          id: 'sess-1',
          workspaceRoot: '/tmp/project',
          mode: 'default',
          createdAt: 1,
          updatedAt: 2,
          messageCount: large.length,
          messages: large,
          hasMoreMessagesAbove: false
        }
      }
      return undefined
    })

    useChatStore.getState().syncFromWorkspace({
      currentSessionId: 'sess-1',
      availableSessions: [{
        id: 'sess-1',
        workspaceRoot: '/tmp/project',
        mode: 'default',
        createdAt: 1,
        updatedAt: 2,
        messageCount: large.length
      }],
      messagesRevision: 1,
      tier1BranchContext: null
    })

    await vi.waitFor(() => {
      expect(useChatStore.getState().messages.length).toBe(300)
    })
    assertMessageIndexConsistent()
  })

  it('分叉路径（regenerateAssistant 截断）当前行为不过窗口裁剪', async () => {
    const messages = buildMessages(500)
    messages[399] = {
      ...messages[399],
      role: 'user',
      blocks: [{ type: 'text', content: 'u399' }]
    }
    messages[400] = {
      ...messages[400],
      role: 'assistant',
      id: 'assistant_target'
    }
    const index = Object.fromEntries(messages.map((m, i) => [m.id, i]))

    useChatStore.setState({
      currentSessionId: 'sess-1',
      messages,
      messageIndexById: index,
      isGenerating: false
    })

    mockInvoke.mockImplementation(async (channel: string) => {
      if (channel === 'workspace:regenerate') {
        return {
          currentProjectPath: '/tmp/project',
          currentSessionId: 'sess-1',
          currentMode: 'default',
          availableSessions: [{
            id: 'sess-1',
            workspaceRoot: '/tmp/project',
            mode: 'default',
            createdAt: 1,
            updatedAt: 1,
            messageCount: 500
          }],
          messagesRevision: 1,
          tier1BranchContext: null
        }
      }
      if (channel === 'load-session') {
        return {
          id: 'sess-1',
          workspaceRoot: '/tmp/project',
          mode: 'default',
          createdAt: 1,
          updatedAt: 1,
          messageCount: 0,
          messages: []
        }
      }
      if (channel === 'send-message') return undefined
      return undefined
    })

    await useChatStore.getState().regenerateAssistant('sess-1', 'assistant_target')
    const state = useChatStore.getState()
    expect(state.messages.length).toBe(400)
    expect(state.messages[0].id).toBe('msg_0')
    expect(state.messages[399].id).toBe('msg_399')
    assertMessageIndexConsistent()
  })
})
