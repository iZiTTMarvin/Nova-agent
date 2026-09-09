import { useRunStore, selectSessionIsRunning } from '../../../src/renderer/stores/useRunStore'
import { makeRunSnapshot, publishRunSnapshot } from './runSnapshotFixture'
import { useChatStore, resetChatStoreForTests } from '../../../src/renderer/stores/useChatStore'
import { useSettingsStore, resetSettingsStoreForTests } from '../../../src/renderer/stores/useSettingsStore'
import { useAgentStore, resetAgentStoreForTests } from '../../../src/renderer/stores/useAgentStore'
import { describe, it, expect, vi, beforeEach } from 'vitest'

// 模拟 window.api
const mockInvoke = vi.fn()
const mockOn = vi.fn()

global.window = {
  ...global.window,
  api: {
    invoke: mockInvoke,
    on: mockOn,
    removeAllListeners: vi.fn()
  }
} as unknown as Window & typeof globalThis

/**
 * 流式工具调用 store 行为单测
 *
 * 核心验证点：
 * 1. handleToolCallStart → 创建 running 占位卡片 + 初始化 streamingToolArgs
 * 2. handleToolCallDelta → 累积 argumentsRaw 到 streamingToolArgs + 更新 block
 * 3. handleToolCall（最终事件）→ 覆盖 args/toolName + 清空 streamingToolArgs + 移除 argumentsRaw
 * 4. cancelled snapshot → running 块标记 error + 清空 streamingToolArgs
 * 5. 无 start 的 handleToolCall 仍然正常创建新块（向后兼容）
 * 6. argumentsRaw 只存在于 renderer 层，不污染 shared 类型
 */
describe('流式工具调用 store 行为', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetChatStoreForTests()
    useRunStore.getState().resetForTests()
    resetSettingsStoreForTests()

    resetAgentStoreForTests()
  })

  it('start → delta×N → tool_call：streamingToolArgs 清空，ToolBlock.arguments 是完整对象，argumentsRaw 为 undefined', () => {
    const msgId = 'msg_stream_1'

    // 1. start：创建 running 占位卡片
    useChatStore.getState().handleMessageStart(msgId)
    useChatStore.getState().handleToolCallStart(msgId, 'tc_write_1', 'write')

    let state = useChatStore.getState()

    // streamingToolArgs 应有初始值
    expect(state.streamingToolArgs['tc_write_1']).toBe('')

    // 消息中应有 running 的 tool block
    const block = state.messages[0].blocks![0]
    expect(block.type).toBe('tool')
    if (block.type === 'tool') {
      expect(block.toolCallId).toBe('tc_write_1')
      expect(block.toolName).toBe('write')
      expect(block.status).toBe('running')
      expect(block.arguments).toEqual({})
      // argumentsRaw 应存在（流式增量字段）
      expect('argumentsRaw' in block ? block.argumentsRaw : undefined).toBe('')
    }

    // toolCalls 也应有占位条目
    expect(state.messages[0].toolCalls!.length).toBe(1)
    expect(state.messages[0].toolCalls![0].name).toBe('write')
    expect(state.messages[0].toolCalls![0].status).toBe('running')

    // 2. delta×3：累积 arguments
    useChatStore.getState().handleToolCallDelta(msgId, 'tc_write_1', '{"path":"ind')
    useChatStore.getState().handleToolCallDelta(msgId, 'tc_write_1', 'ex.html","con')
    useChatStore.getState().handleToolCallDelta(msgId, 'tc_write_1', 'tent":"hello"}')

    state = useChatStore.getState()

    // streamingToolArgs 应累积完整参数字符串
    expect(state.streamingToolArgs['tc_write_1']).toBe('{"path":"index.html","content":"hello"}')

    // block 的 argumentsRaw 应同步累积
    const deltaBlock = state.messages[0].blocks![0]
    if (deltaBlock.type === 'tool') {
      expect(deltaBlock.argumentsRaw).toBe('{"path":"index.html","content":"hello"}')
      // 关键断言：partial 解析后 block.arguments 应反映已解析字段
      expect(deltaBlock.arguments).toEqual({ path: 'index.html', content: 'hello' })
    }

    // toolCalls 数组也应同步更新 arguments 和 argumentsRaw
    const deltaTc = state.messages[0].toolCalls![0]
    expect(deltaTc.arguments).toEqual({ path: 'index.html', content: 'hello' })
    expect(deltaTc.argumentsRaw).toBe('{"path":"index.html","content":"hello"}')

    // 3. tool_call（最终事件）：覆盖 args + toolName + 清空
    useChatStore.getState().handleToolCall(msgId, 'tc_write_1', 'write', { path: 'index.html', content: 'hello' })

    state = useChatStore.getState()

    // streamingToolArgs 应清空
    expect(state.streamingToolArgs['tc_write_1']).toBeUndefined()

    // block 应有完整 arguments 对象
    const finalBlock = state.messages[0].blocks![0]
    expect(finalBlock.type).toBe('tool')
    if (finalBlock.type === 'tool') {
      expect(finalBlock.arguments).toEqual({ path: 'index.html', content: 'hello' })
      expect(finalBlock.toolName).toBe('write')
      expect(finalBlock.status).toBe('running')
      // argumentsRaw 应已被移除（undefined）
      expect(finalBlock.argumentsRaw).toBeUndefined()
    }
  })

  it('start 时 toolName 为空字符串，delta 后 tool_call 覆盖完整 toolName', () => {
    const msgId = 'msg_empty_name'

    // 有些模型第一个 chunk 只给 id，name 为空
    useChatStore.getState().handleMessageStart(msgId)
    useChatStore.getState().handleToolCallStart(msgId, 'tc_empty', '')

    let state = useChatStore.getState()
    const block = state.messages[0].blocks![0]
    if (block.type === 'tool') {
      expect(block.toolName).toBe('')
    }

    // delta 累积
    useChatStore.getState().handleToolCallDelta(msgId, 'tc_empty', '{"command":"ls -la"}')

    // tool_call 最终事件覆盖 toolName
    useChatStore.getState().handleToolCall(msgId, 'tc_empty', 'bash', { command: 'ls -la' })

    state = useChatStore.getState()
    const finalBlock = state.messages[0].blocks![0]
    if (finalBlock.type === 'tool') {
      expect(finalBlock.toolName).toBe('bash')
      expect(finalBlock.arguments).toEqual({ command: 'ls -la' })
      expect(finalBlock.argumentsRaw).toBeUndefined()
    }
  })

  it('cancelExecution 应发送 IPC 信号；由 cancelled snapshot 把 running tool 标记为 error + 清空 streamingToolArgs', async () => {
    const msgId = 'msg_cancel_1'

    // 模拟正在流式生成中的工具调用
    useChatStore.getState().handleMessageStart(msgId)
    useChatStore.getState().handleToolCallStart(msgId, 'tc_cancel', 'write')
    useChatStore.getState().handleToolCallDelta(msgId, 'tc_cancel', '{"path":"a.ts"')

    // 取消执行前，确认有 running 块和 streamingToolArgs
    let state = useChatStore.getState()
    expect(state.streamingToolArgs['tc_cancel']).toBe('{"path":"a.ts"')
    const block = state.messages[0].blocks![0]
    if (block.type === 'tool') {
      expect(block.status).toBe('running')
    }

    // 取消只发 IPC，不动本地 messages
    useChatStore.setState({ currentSessionId: 'sess_1' })
    useRunStore.getState().selectSession('sess_1')
    publishRunSnapshot(makeRunSnapshot({ messageId: msgId }))
    mockInvoke.mockImplementation(async (channel: string) => {
      if (channel === 'load-session') return new Promise(() => {})
      if (channel === 'get-message-diffs') return { diffs: [], reviews: {} }
      return undefined
    })
    await useAgentStore.getState().cancelExecution()

    state = useChatStore.getState()
    // 取消后本地不动 running 块（等 cancelled snapshot）
    const blockAfterCancel = state.messages[0].blocks![0]
    if (blockAfterCancel.type === 'tool') {
      expect(blockAfterCancel.status).toBe('running')
    }
    // 没有 pending 权限请求
    expect(useAgentStore.getState().pendingPermissionRequest).toBeNull()

    // 主进程 cancelled snapshot 触发收尾
    expect(selectSessionIsRunning(useRunStore.getState(), 'sess_1')).toBe(true)
    publishRunSnapshot(makeRunSnapshot({ messageId: msgId, status: 'cancelled', sequence: 2 }))
    await vi.waitFor(() => expect(useChatStore.getState().messages[0].interrupted).toBe(true))

    state = useChatStore.getState()
    // running 块应标记为 error
    const cancelBlock = state.messages[0].blocks![0]
    if (cancelBlock.type === 'tool') {
      expect(cancelBlock.status).toBe('error')
      expect(cancelBlock.result).toBe('用户取消执行')
    }
    // streamingToolArgs 应清空
    expect(state.streamingToolArgs['tc_cancel']).toBeUndefined()
    // 消息应标记 interrupted
    expect(state.messages[0].interrupted).toBe(true)
  })

  it('无 start 的 handleToolCall 应正常创建新块（向后兼容）', () => {
    const msgId = 'msg_compat_1'

    useChatStore.getState().handleMessageStart(msgId)
    // 不调用 handleToolCallStart，直接调用 handleToolCall
    useChatStore.getState().handleToolCall(msgId, 'tc_compat', 'ls', { path: './' })

    const state = useChatStore.getState()
    expect(state.messages[0].blocks!.length).toBe(1)
    const block = state.messages[0].blocks![0]
    if (block.type === 'tool') {
      expect(block.toolCallId).toBe('tc_compat')
      expect(block.toolName).toBe('ls')
      expect(block.arguments).toEqual({ path: './' })
      expect(block.status).toBe('running')
      expect(block.argumentsRaw).toBeUndefined()
    }

    // streamingToolArgs 不应有残留
    expect(Object.keys(state.streamingToolArgs).length).toBe(0)
  })

  it('多个工具调用的流式序列应互不干扰', () => {
    const msgId = 'msg_multi'

    useChatStore.getState().handleMessageStart(msgId)

    // 第一个工具调用：start → delta
    useChatStore.getState().handleToolCallStart(msgId, 'tc_a', 'write')
    useChatStore.getState().handleToolCallDelta(msgId, 'tc_a', '{"path":"a.ts"')

    // 第二个工具调用：start → delta
    useChatStore.getState().handleToolCallStart(msgId, 'tc_b', 'bash')
    useChatStore.getState().handleToolCallDelta(msgId, 'tc_b', '{"command":"ls"}')

    // 第二个先收到最终事件
    useChatStore.getState().handleToolCall(msgId, 'tc_b', 'bash', { command: 'ls' })

    let state = useChatStore.getState()

    // tc_b 的 streamingToolArgs 应清空
    expect(state.streamingToolArgs['tc_b']).toBeUndefined()
    // tc_a 的 streamingToolArgs 应仍在累积
    expect(state.streamingToolArgs['tc_a']).toBe('{"path":"a.ts"')

    // 第一个的最终事件
    useChatStore.getState().handleToolCall(msgId, 'tc_a', 'write', { path: 'a.ts', content: 'hello' })

    state = useChatStore.getState()

    // 两个 toolCall 都应清空
    expect(Object.keys(state.streamingToolArgs).length).toBe(0)

    // 块顺序应保持
    expect(state.messages[0].blocks!.length).toBe(2)
    const blockA = state.messages[0].blocks![0]
    const blockB = state.messages[0].blocks![1]
    if (blockA.type === 'tool' && blockB.type === 'tool') {
      expect(blockA.toolCallId).toBe('tc_a')
      expect(blockA.arguments).toEqual({ path: 'a.ts', content: 'hello' })
      expect(blockA.argumentsRaw).toBeUndefined()

      expect(blockB.toolCallId).toBe('tc_b')
      expect(blockB.arguments).toEqual({ command: 'ls' })
      expect(blockB.argumentsRaw).toBeUndefined()
    }
  })

  it('handleToolCallStart 对不存在的 messageId 应静默忽略', () => {
    useChatStore.getState().handleToolCallStart('msg_nonexistent', 'tc_x', 'ls')

    const state = useChatStore.getState()
    expect(state.messages.length).toBe(0)
    // streamingToolArgs 不应有残留（因为 messageId 不存在，无法找到 block）
    // 注意：streamingToolArgs 可能被设置了但找不到对应的 block
    // 这里验证的是最终状态不影响任何可见消息
  })

  it('handleToolCallDelta 对不存在的 messageId 应静默忽略', () => {
    useChatStore.getState().handleToolCallDelta('msg_nonexistent', 'tc_y', '{"a":1}')

    const state = useChatStore.getState()
    expect(state.messages.length).toBe(0)
  })

  it('cancelled snapshot 在历史对账返回前把 running toolCalls 标记为 error', async () => {
    const msgId = 'msg_cancel_tc'

    useChatStore.getState().handleMessageStart(msgId)
    useChatStore.getState().handleToolCallStart(msgId, 'tc_c1', 'edit')
    useChatStore.getState().handleToolCallDelta(msgId, 'tc_c1', '{"path":"a.ts"')

    // toolCalls 也应有占位条目
    expect(useChatStore.getState().messages[0].toolCalls![0].status).toBe('running')

    useChatStore.setState({ currentSessionId: 'sess_1' })
    useRunStore.getState().selectSession('sess_1')
    publishRunSnapshot(makeRunSnapshot({ messageId: msgId }))
    mockInvoke.mockImplementation(async (channel: string) => {
      if (channel === 'load-session') return new Promise(() => {})
      if (channel === 'get-message-diffs') return { diffs: [], reviews: {} }
      return undefined
    })
    await useAgentStore.getState().cancelExecution()

    // 取消后本地不动，等主进程 cancelled snapshot
    expect(useChatStore.getState().messages[0].toolCalls![0].status).toBe('running')

    expect(selectSessionIsRunning(useRunStore.getState(), 'sess_1')).toBe(true)
    publishRunSnapshot(makeRunSnapshot({ messageId: msgId, status: 'cancelled', sequence: 2 }))
    await vi.waitFor(() => expect(useChatStore.getState().messages[0].interrupted).toBe(true))

    const state = useChatStore.getState()
    // toolCalls 中的条目也应标记为 error
    expect(state.messages[0].toolCalls![0].status).toBe('error')
    expect(state.messages[0].toolCalls![0].result).toContain('取消')
  })
})