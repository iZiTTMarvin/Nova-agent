import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resetAgentStoreForTests } from '../../../../../src/renderer/stores/useAgentStore'
import {
  resetChatStoreForTests,
  useChatStore
} from '../../../../../src/renderer/stores/useChatStore'
import {
  resetWorkspaceStoreForTests,
  useWorkspaceStore
} from '../../../../../src/renderer/stores/useWorkspaceStore'

const mockInvoke = vi.fn()

describe('turnLifecycleSlice', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockInvoke.mockResolvedValue(undefined)
    resetAgentStoreForTests()
    resetChatStoreForTests()
    resetWorkspaceStoreForTests()
    useWorkspaceStore.setState({ currentProjectPath: '/tmp/project' })
    global.window = {
      ...global.window,
      api: {
        invoke: mockInvoke,
        on: vi.fn(() => () => {}),
        removeAllListeners: vi.fn()
      }
    } as unknown as Window & typeof globalThis
  })

  it('handleMessageEnd 后轮次运行态回到终态', async () => {
    useChatStore.getState().handleMessageStart('msg_1')
    useChatStore.setState({ isGenerating: true, activeAgentSessionId: 'sess-1' })

    await useChatStore.getState().handleMessageEnd('msg_1')

    const state = useChatStore.getState()
    expect(state.isGenerating).toBe(false)
    expect(state.currentGeneratingMessageId).toBeNull()
    expect(state.activeAgentSessionId).toBeNull()
    expect(state.sendInFlight).toBe(false)
    expect(state.messages[0].turnEndedAt).toBeTypeOf('number')
  })

  it('handleMessageEnd(interrupted) 标记 running tool 为取消错误并清空流式参数', async () => {
    const runningTool = {
      type: 'tool' as const,
      toolCallId: 'tc_1',
      toolName: 'write',
      arguments: {},
      argumentsRaw: '{"pa',
      status: 'running' as const
    }
    useChatStore.setState({
      messages: [{
        id: 'msg_int',
        sessionId: 'sess-1',
        role: 'assistant',
        content: '',
        blocks: [runningTool],
        toolCalls: [{ id: 'tc_1', name: 'write', arguments: {}, argumentsRaw: '{"pa', status: 'running' }],
        timestamp: 1,
        _revision: 0
      }],
      messageIndexById: { msg_int: 0 },
      isGenerating: true,
      currentGeneratingMessageId: 'msg_int',
      streamingToolArgs: { tc_1: '{"pa' }
    })

    await useChatStore.getState().handleMessageEnd('msg_int', true)

    const msg = useChatStore.getState().messages[0]
    expect(msg.interrupted).toBe(true)
    expect(msg.blocks?.[0]).toMatchObject({ status: 'error', result: '用户取消执行' })
    expect(msg.blocks?.[0]).not.toHaveProperty('argumentsRaw')
    expect(msg.toolCalls?.[0]).toMatchObject({ status: 'error', result: '用户取消执行' })
    expect(useChatStore.getState().streamingToolArgs).toEqual({})
  })

  it('handleMessageEnd 非中断路径不改写消息块内容', async () => {
    const doneTool = {
      type: 'tool' as const,
      toolCallId: 'tc_ok',
      toolName: 'read',
      arguments: { path: 'a.ts' },
      status: 'success' as const,
      result: 'ok'
    }
    useChatStore.setState({
      messages: [{
        id: 'msg_ok',
        sessionId: 'sess-1',
        role: 'assistant',
        content: 'done',
        blocks: [doneTool],
        timestamp: 1,
        _revision: 0
      }],
      messageIndexById: { msg_ok: 0 },
      isGenerating: true,
      currentGeneratingMessageId: 'msg_ok'
    })

    await useChatStore.getState().handleMessageEnd('msg_ok')

    const msg = useChatStore.getState().messages[0]
    expect(msg.interrupted).toBeUndefined()
    expect(msg.blocks?.[0]).toEqual(doneTool)
    expect(msg.turnEndedAt).toBeTypeOf('number')
  })

  it('handleError 追加终态错误块并清理该消息的恢复态字段', async () => {
    useChatStore.getState().handleMessageStart('msg_err')
    useChatStore.getState().handleTextDelta('msg_err', '部分输出')
    useChatStore.getState().handleRecoveryState('msg_err', 'recovering')
    useChatStore.getState().handleRecoveryHint('msg_err', '重试中', 1)
    useChatStore.getState().handleHookError('msg_err', 'tool_before', 'hook 崩了')
    useChatStore.setState({
      isGenerating: true,
      activeAgentSessionId: 'sess-1',
      sendInFlight: true,
      branchForkInProgress: true
    })

    await useChatStore.getState().handleError('msg_err', '模型连接失败')

    const state = useChatStore.getState()
    const msg = state.messages[0]
    expect(msg.isError).toBe(true)
    expect(msg.blocks?.at(-1)).toMatchObject({
      type: 'text',
      content: '部分输出\n\n⚠️ 模型连接失败'
    })
    expect(state.isGenerating).toBe(false)
    expect(state.currentGeneratingMessageId).toBeNull()
    // error 事件只属于当前会话，运行态/发送锁/分叉锁必须无条件收敛，不能残留阻塞下次发送
    expect(state.activeAgentSessionId).toBeNull()
    expect(state.sendInFlight).toBe(false)
    expect(state.branchForkInProgress).toBe(false)
    expect(state.recoveryState).toEqual({})
    expect(state.recoveryHints).toEqual({})
    expect(state.hookErrors).toEqual({})
  })

  it('markRunningAsCancelled 清空轮次运行态（含发送锁与分叉锁）', async () => {
    useChatStore.setState({
      isGenerating: true,
      currentGeneratingMessageId: 'msg_cancel',
      activeAgentSessionId: 'sess-1',
      sendInFlight: true,
      branchForkInProgress: true
    })

    await useChatStore.getState().markRunningAsCancelled()

    const state = useChatStore.getState()
    expect(state.isGenerating).toBe(false)
    expect(state.currentGeneratingMessageId).toBeNull()
    expect(state.activeAgentSessionId).toBeNull()
    expect(state.sendInFlight).toBe(false)
    expect(state.branchForkInProgress).toBe(false)
  })

  it('终态后 steering 队列恰好出队一次', async () => {
    useChatStore.getState().handleMessageStart('msg_turn')
    useChatStore.getState().enqueuePendingMessage('排队消息', [])
    useChatStore.getState().enqueuePendingMessage('第二条', [])

    await useChatStore.getState().handleMessageEnd('msg_turn')

    const state = useChatStore.getState()
    expect(state.pendingUserMessages).toHaveLength(1)
    expect(state.pendingUserMessages[0].text).toBe('第二条')
    const sendCalls = mockInvoke.mock.calls.filter(([channel]) => channel === 'send-message')
    expect(sendCalls).toHaveLength(1)
    expect(sendCalls[0][1]).toMatchObject({ content: '排队消息' })
  })

  it('handleError 终态后 steering 队列被派发（error 也是 turn boundary）', async () => {
    useChatStore.getState().handleMessageStart('msg_err')
    useChatStore.getState().enqueuePendingMessage('error 后排队消息', [])
    useChatStore.setState({ isGenerating: true })

    await useChatStore.getState().handleError('msg_err', '模型连接失败')

    const state = useChatStore.getState()
    expect(state.pendingUserMessages).toHaveLength(0)
    const sendCalls = mockInvoke.mock.calls.filter(([channel]) => channel === 'send-message')
    expect(sendCalls).toHaveLength(1)
    expect(sendCalls[0][1]).toMatchObject({ content: 'error 后排队消息' })
  })
})
