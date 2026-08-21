/**
 * 「继续分析」恢复入口契约：
 * continue 必须走正常消息链开新轮次，不得把旧 run 转 resuming（主 loop 无 resuming 消费入口，
 * 转换会永久占用会话 turn）；rollback / inspect 仍走 run:interrupted-action。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  useRunStore,
  CONTINUE_AFTER_INTERRUPT_PROMPT
} from '../../../src/renderer/stores/useRunStore'
import {
  useChatStore,
  resetChatStoreForTests,
  type ChatState
} from '../../../src/renderer/stores/useChatStore'

const mockInvoke = vi.fn(async () => undefined)
const originalSendMessage = useChatStore.getState().sendMessage

function stubSendMessage(result: boolean) {
  const sendMessage = vi.fn(async () => result)
  useChatStore.setState({
    sendMessage: sendMessage as unknown as ChatState['sendMessage']
  })
  return sendMessage
}

describe('interruptedAction continue 恢复路径', () => {
  beforeEach(() => {
    mockInvoke.mockClear()
    global.window = {
      ...global.window,
      api: {
        invoke: mockInvoke,
        on: vi.fn(),
        removeAllListeners: vi.fn()
      }
    } as unknown as Window & typeof globalThis
    useRunStore.getState().resetForTests()
    resetChatStoreForTests()
  })

  afterEach(() => {
    useRunStore.getState().resetForTests()
    resetChatStoreForTests()
    useChatStore.setState({ sendMessage: originalSendMessage })
  })

  it('点击继续 → 代发继续指令消息开新轮次，旧 run 不进 resuming，横幅清除', async () => {
    useRunStore.setState({
      interruptedRunId: 'runA',
      interruptedSteps: [{ toolCallId: 'tc1', toolName: 'write', phase: 'committed' }]
    })
    const sendMessage = stubSendMessage(true)

    await useRunStore.getState().interruptedAction('continue')

    expect(sendMessage).toHaveBeenCalledWith(CONTINUE_AFTER_INTERRUPT_PROMPT)
    // 不得再走 run:interrupted-action（旧路径会把 runA 转 resuming 造成死锁）
    expect(mockInvoke).not.toHaveBeenCalledWith(
      'run:interrupted-action',
      expect.anything()
    )
    expect(useRunStore.getState().interruptedRunId).toBeNull()
    expect(useRunStore.getState().interruptedSteps).toEqual([])
  })

  it('发送失败时不隐藏中断横幅，保留恢复入口', async () => {
    useRunStore.setState({
      interruptedRunId: 'runA',
      interruptedSteps: [{ toolCallId: 'tc1', toolName: 'write', phase: 'failed' }]
    })
    stubSendMessage(false)

    await useRunStore.getState().interruptedAction('continue')

    expect(useRunStore.getState().interruptedRunId).toBe('runA')
    expect(useRunStore.getState().interruptedSteps).toHaveLength(1)
  })

  it('rollback / inspect 仍走 run:interrupted-action，且不写回兼容 snapshot 槽位', async () => {
    mockInvoke.mockImplementation(async (channel: string) => {
      if (channel === 'run:interrupted-action') {
        return {
          ok: false,
          message: 'm',
          steps: [],
          snapshot: null
        }
      }
      return undefined
    })
    useRunStore.setState({ interruptedRunId: 'runA' })

    await useRunStore.getState().interruptedAction('inspect')

    expect(mockInvoke).toHaveBeenCalledWith('run:interrupted-action', {
      runId: 'runA',
      action: 'inspect'
    })
  })
})
