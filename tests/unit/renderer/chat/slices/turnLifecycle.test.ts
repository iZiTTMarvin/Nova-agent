import { makeRunSnapshot, publishRunSnapshot } from '../../runSnapshotFixture'
import { useRunStore, selectSessionIsRunning } from '../../../../../src/renderer/stores/useRunStore'
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
    mockInvoke.mockImplementation(async (channel: string) =>
      channel === 'send-message' ? { accepted: true } : undefined
    )
    resetAgentStoreForTests()
    resetChatStoreForTests()
    useRunStore.getState().resetForTests()
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

  it('handleMessageEnd 封存显示但不终止权威运行', async () => {
    publishRunSnapshot(makeRunSnapshot({ sessionId: 'sess-1' }))
    useChatStore.getState().handleMessageStart('msg_1')
    useChatStore.setState({ activeAgentSessionId: 'sess-1' })

    await useChatStore.getState().handleMessageEnd('msg_1')

    const state = useChatStore.getState()
    expect(state.currentGeneratingMessageId).toBeNull()
    expect(state.activeAgentSessionId).toBeNull()
    expect(state.sendInFlight).toBe(false)
    expect(state.messages[0].turnEndedAt).toBeTypeOf('number')
    expect(selectSessionIsRunning(useRunStore.getState(), 'sess-1')).toBe(true)
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
      activeAgentSessionId: 'sess-1',
      sendInFlight: true,
      branchForkInProgress: true
    })

    await useChatStore.getState().handleError('msg_err', '模型连接失败')

    const state = useChatStore.getState()
    const msg = state.messages[0]
    expect(msg.isError).toBe(true)
    expect(msg.turnEndedAt).toBeTypeOf('number')
    expect(msg.blocks?.at(-1)).toMatchObject({
      type: 'text',
      content: '部分输出\n\n⚠️ 模型连接失败'
    })
    expect(state.currentGeneratingMessageId).toBeNull()
    // 消息错误不拥有运行结束或发送锁的生命周期。
    expect(state.activeAgentSessionId).toBeNull()
    expect(state.sendInFlight).toBe(true)
    expect(state.branchForkInProgress).toBe(true)
    expect(state.recoveryState).toEqual({})
    expect(state.recoveryHints).toEqual({})
    expect(state.hookErrors).toEqual({})
  })

  it('未落盘的本地错误消息会被默认对账擦掉，skipReconcile 时保留', async () => {
    mockInvoke.mockImplementation(async (channel: string) => {
      if (channel === 'load-session') {
        return {
          id: 'sess-1',
          workspaceRoot: '/tmp/project',
          mode: 'default',
          createdAt: 1,
          updatedAt: 2,
          messageCount: 0,
          messages: [],
          hasMoreMessagesAbove: false
        }
      }
      return undefined
    })
    useChatStore.setState({ currentSessionId: 'sess-1' })

    await useChatStore.getState().handleError('msg_err_wiped', '未找到技能 /typo')
    expect(useChatStore.getState().messages.some(m => m.id === 'msg_err_wiped')).toBe(false)

    await useChatStore.getState().handleError('msg_err_kept', '未找到技能 /typo', { skipReconcile: true })
    const kept = useChatStore.getState().messages.find(m => m.id === 'msg_err_kept')
    expect(kept?.isError).toBe(true)
    expect(kept?.content).toContain('未找到技能 /typo')
  })

  it('取消终态清空本轮展示状态与发送、分叉锁', async () => {
    useChatStore.setState({
      messages: [{
        id: 'msg_cancel',
        sessionId: 'sess-1',
        role: 'assistant',
        content: '',
        blocks: [{
          type: 'tool',
          toolCallId: 'tc_cancel',
          toolName: 'bash',
          arguments: {},
          status: 'running'
        }],
        timestamp: 100,
        _revision: 0
      }],
      messageIndexById: { msg_cancel: 0 },
      currentGeneratingMessageId: 'msg_cancel',
      activeAgentSessionId: 'sess-1',
      sendInFlight: true,
      branchForkInProgress: true
    })

    useChatStore.setState({ currentSessionId: 'sess-1' })
    await useChatStore.getState().handleRunTerminal(makeRunSnapshot({
      sessionId: 'sess-1', messageId: 'msg_cancel', status: 'cancelled'
    }))

    const state = useChatStore.getState()
    expect(state.currentGeneratingMessageId).toBeNull()
    expect(state.activeAgentSessionId).toBeNull()
    expect(state.sendInFlight).toBe(false)
    expect(state.branchForkInProgress).toBe(false)
    expect(state.messages[0]).toMatchObject({
      interrupted: true,
      turnStartedAt: 100,
      blocks: [{
        status: 'error',
        result: '用户取消执行'
      }]
    })
    expect(state.messages[0].turnEndedAt).toBeTypeOf('number')
  })

  it('取消确认先于 message-end 时，已完成工具和纯文本轮次也必须原子标记中断', async () => {
    const history = { id: 'history', role: 'assistant' as const, content: '历史回答', timestamp: 1 }
    const completedTool = { type: 'tool' as const, toolCallId: 'done', toolName: 'write', arguments: { path: 'done.txt' }, status: 'success' as const, result: 'ok' }
    for (const blocks of [undefined, [completedTool]]) {
      useChatStore.setState({
        messages: [history, { id: 'active', role: 'assistant', content: '已有内容', timestamp: 2, blocks }],
        messageIndexById: { history: 0, active: 1 },
        currentGeneratingMessageId: 'active'
      })
      await useChatStore.getState().handleMessageEnd('active', true)
      const state = useChatStore.getState()
      expect(state.messages[1]).toMatchObject({ interrupted: true, content: '已有内容' })
      expect(state.messages[1].blocks).toEqual(blocks)
      expect(state.messages[0]).toBe(history)
    }
  })

  it.each(['message_end', 'error'] as const)('%s 只封存显示，不派发 steering 队列', async event => {
    publishRunSnapshot(makeRunSnapshot({ sessionId: 'sess-1', messageId: 'msg_turn' }))
    useChatStore.getState().handleMessageStart('msg_turn')
    useChatStore.getState().enqueuePendingMessage('排队消息', [])
    if (event === 'error') await useChatStore.getState().handleError('msg_turn', '模型连接失败')
    else await useChatStore.getState().handleMessageEnd('msg_turn')
    expect(useChatStore.getState().pendingUserMessages.map(item => item.text)).toEqual(['排队消息'])
    expect(selectSessionIsRunning(useRunStore.getState(), 'sess-1')).toBe(true)
    expect(mockInvoke.mock.calls.filter(([channel]) => channel === 'send-message')).toEqual([])
  })

  it('无消息块时只转换预算错误，其他终态错误保留原文', async () => {
    await useChatStore.getState().handleError(
      'msg_budget',
      'ContextBudgetExceeded: estimatedTokens=120 serializedBytes=480 attemptedCompaction=true'
    )
    await useChatStore.getState().handleError('msg_network', '网络连接失败')

    const messages = useChatStore.getState().messages
    expect(messages.find(message => message.id === 'msg_budget')?.content)
      .toBe('对话内容已超过模型上下文预算。请移除部分图片、缩短消息，或新建会话后重试。')
    expect(messages.find(message => message.id === 'msg_network')?.content)
      .toBe('网络连接失败')
  })
})
