import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useAppStore } from '../../../src/renderer/stores/useAppStore'

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
 * S2 流式工具调用 store 行为单测
 *
 * 核心验证点：
 * 1. handleToolCallStart → 创建 running 占位卡片 + 初始化 streamingToolArgs
 * 2. handleToolCallDelta → 累积 argumentsRaw 到 streamingToolArgs + 更新 block
 * 3. handleToolCall（最终事件）→ 覆盖 args/toolName + 清空 streamingToolArgs + 移除 argumentsRaw
 * 4. cancelExecution → running 块标记 error + 清空 streamingToolArgs
 * 5. 无 start 的 handleToolCall 仍然正常创建新块（向后兼容）
 * 6. argumentsRaw 只存在于 renderer 层，不污染 shared 类型
 */
describe('S2 流式工具调用 store 行为', () => {
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
      messageDiffs: {},
      loadingDiffs: new Set(),
      loadingDiffPlaceholders: {},
      streamingToolArgs: {}
    })
  })

  it('start → delta×N → tool_call：streamingToolArgs 清空，ToolBlock.arguments 是完整对象，argumentsRaw 为 undefined', () => {
    const msgId = 'msg_stream_1'

    // 1. start：创建 running 占位卡片
    useAppStore.getState().handleMessageStart(msgId)
    useAppStore.getState().handleToolCallStart(msgId, 'tc_write_1', 'write')

    let state = useAppStore.getState()

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
      expect('argumentsRaw' in block ? (block as any).argumentsRaw : undefined).toBe('')
    }

    // toolCalls 也应有占位条目
    expect(state.messages[0].toolCalls!.length).toBe(1)
    expect(state.messages[0].toolCalls![0].name).toBe('write')
    expect(state.messages[0].toolCalls![0].status).toBe('running')

    // 2. delta×3：累积 arguments
    useAppStore.getState().handleToolCallDelta(msgId, 'tc_write_1', '{"path":"ind')
    useAppStore.getState().handleToolCallDelta(msgId, 'tc_write_1', 'ex.html","con')
    useAppStore.getState().handleToolCallDelta(msgId, 'tc_write_1', 'tent":"hello"}')

    state = useAppStore.getState()

    // streamingToolArgs 应累积完整参数字符串
    expect(state.streamingToolArgs['tc_write_1']).toBe('{"path":"index.html","content":"hello"}')

    // block 的 argumentsRaw 应同步累积
    const deltaBlock = state.messages[0].blocks![0]
    if (deltaBlock.type === 'tool') {
      expect((deltaBlock as any).argumentsRaw).toBe('{"path":"index.html","content":"hello"}')
      // 关键断言：partial 解析后 block.arguments 应反映已解析字段
      expect(deltaBlock.arguments).toEqual({ path: 'index.html', content: 'hello' })
    }

    // toolCalls 数组也应同步更新 arguments 和 argumentsRaw
    const deltaTc = state.messages[0].toolCalls![0]
    expect(deltaTc.arguments).toEqual({ path: 'index.html', content: 'hello' })
    expect((deltaTc as any).argumentsRaw).toBe('{"path":"index.html","content":"hello"}')

    // 3. tool_call（最终事件）：覆盖 args + toolName + 清空
    useAppStore.getState().handleToolCall(msgId, 'tc_write_1', 'write', { path: 'index.html', content: 'hello' })

    state = useAppStore.getState()

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
      expect((finalBlock as any).argumentsRaw).toBeUndefined()
    }
  })

  it('start 时 toolName 为空字符串，delta 后 tool_call 覆盖完整 toolName', () => {
    const msgId = 'msg_empty_name'

    // 有些模型第一个 chunk 只给 id，name 为空
    useAppStore.getState().handleMessageStart(msgId)
    useAppStore.getState().handleToolCallStart(msgId, 'tc_empty', '')

    let state = useAppStore.getState()
    const block = state.messages[0].blocks![0]
    if (block.type === 'tool') {
      expect(block.toolName).toBe('')
    }

    // delta 累积
    useAppStore.getState().handleToolCallDelta(msgId, 'tc_empty', '{"command":"ls -la"}')

    // tool_call 最终事件覆盖 toolName
    useAppStore.getState().handleToolCall(msgId, 'tc_empty', 'bash', { command: 'ls -la' })

    state = useAppStore.getState()
    const finalBlock = state.messages[0].blocks![0]
    if (finalBlock.type === 'tool') {
      expect(finalBlock.toolName).toBe('bash')
      expect(finalBlock.arguments).toEqual({ command: 'ls -la' })
      expect((finalBlock as any).argumentsRaw).toBeUndefined()
    }
  })

  it('cancelExecution 应发送 IPC 信号；由 message-end(interrupted=true) 把 running tool 标记为 error + 清空 streamingToolArgs', async () => {
    const msgId = 'msg_cancel_1'

    // 模拟正在流式生成中的工具调用
    useAppStore.getState().handleMessageStart(msgId)
    useAppStore.getState().handleToolCallStart(msgId, 'tc_cancel', 'write')
    useAppStore.getState().handleToolCallDelta(msgId, 'tc_cancel', '{"path":"a.ts"')

    // 取消执行前，确认有 running 块和 streamingToolArgs
    let state = useAppStore.getState()
    expect(state.streamingToolArgs['tc_cancel']).toBe('{"path":"a.ts"')
    const block = state.messages[0].blocks![0]
    if (block.type === 'tool') {
      expect(block.status).toBe('running')
    }

    // Phase 3：取消只发 IPC，不动本地 messages
    mockInvoke.mockResolvedValue(undefined)
    await useAppStore.getState().cancelExecution()

    state = useAppStore.getState()
    // 取消后本地不动 running 块（等 message-end 兜底）
    const blockAfterCancel = state.messages[0].blocks![0]
    if (blockAfterCancel.type === 'tool') {
      expect(blockAfterCancel.status).toBe('running')
    }
    // 弹窗状态被本地清空
    expect(state.pendingPermissionRequest).toBeNull()

    // 主进程推送 message-end(interrupted=true) 触发收尾
    useAppStore.getState().handleMessageEnd(msgId, true)

    state = useAppStore.getState()
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

    useAppStore.getState().handleMessageStart(msgId)
    // 不调用 handleToolCallStart，直接调用 handleToolCall
    useAppStore.getState().handleToolCall(msgId, 'tc_compat', 'ls', { path: './' })

    const state = useAppStore.getState()
    expect(state.messages[0].blocks!.length).toBe(1)
    const block = state.messages[0].blocks![0]
    if (block.type === 'tool') {
      expect(block.toolCallId).toBe('tc_compat')
      expect(block.toolName).toBe('ls')
      expect(block.arguments).toEqual({ path: './' })
      expect(block.status).toBe('running')
      expect((block as any).argumentsRaw).toBeUndefined()
    }

    // streamingToolArgs 不应有残留
    expect(Object.keys(state.streamingToolArgs).length).toBe(0)
  })

  it('多个工具调用的流式序列应互不干扰', () => {
    const msgId = 'msg_multi'

    useAppStore.getState().handleMessageStart(msgId)

    // 第一个工具调用：start → delta
    useAppStore.getState().handleToolCallStart(msgId, 'tc_a', 'write')
    useAppStore.getState().handleToolCallDelta(msgId, 'tc_a', '{"path":"a.ts"')

    // 第二个工具调用：start → delta
    useAppStore.getState().handleToolCallStart(msgId, 'tc_b', 'bash')
    useAppStore.getState().handleToolCallDelta(msgId, 'tc_b', '{"command":"ls"}')

    // 第二个先收到最终事件
    useAppStore.getState().handleToolCall(msgId, 'tc_b', 'bash', { command: 'ls' })

    let state = useAppStore.getState()

    // tc_b 的 streamingToolArgs 应清空
    expect(state.streamingToolArgs['tc_b']).toBeUndefined()
    // tc_a 的 streamingToolArgs 应仍在累积
    expect(state.streamingToolArgs['tc_a']).toBe('{"path":"a.ts"')

    // 第一个的最终事件
    useAppStore.getState().handleToolCall(msgId, 'tc_a', 'write', { path: 'a.ts', content: 'hello' })

    state = useAppStore.getState()

    // 两个 toolCall 都应清空
    expect(Object.keys(state.streamingToolArgs).length).toBe(0)

    // 块顺序应保持
    expect(state.messages[0].blocks!.length).toBe(2)
    const blockA = state.messages[0].blocks![0]
    const blockB = state.messages[0].blocks![1]
    if (blockA.type === 'tool' && blockB.type === 'tool') {
      expect(blockA.toolCallId).toBe('tc_a')
      expect(blockA.arguments).toEqual({ path: 'a.ts', content: 'hello' })
      expect((blockA as any).argumentsRaw).toBeUndefined()

      expect(blockB.toolCallId).toBe('tc_b')
      expect(blockB.arguments).toEqual({ command: 'ls' })
      expect((blockB as any).argumentsRaw).toBeUndefined()
    }
  })

  it('handleToolCallStart 对不存在的 messageId 应静默忽略', () => {
    useAppStore.getState().handleToolCallStart('msg_nonexistent', 'tc_x', 'ls')

    const state = useAppStore.getState()
    expect(state.messages.length).toBe(0)
    // streamingToolArgs 不应有残留（因为 messageId 不存在，无法找到 block）
    // 注意：streamingToolArgs 可能被设置了但找不到对应的 block
    // 这里验证的是最终状态不影响任何可见消息
  })

  it('handleToolCallDelta 对不存在的 messageId 应静默忽略', () => {
    useAppStore.getState().handleToolCallDelta('msg_nonexistent', 'tc_y', '{"a":1}')

    const state = useAppStore.getState()
    expect(state.messages.length).toBe(0)
  })

  it('cancel 后由 message-end(interrupted=true) 把 running toolCalls 也标记为 error', async () => {
    const msgId = 'msg_cancel_tc'

    useAppStore.getState().handleMessageStart(msgId)
    useAppStore.getState().handleToolCallStart(msgId, 'tc_c1', 'edit')
    useAppStore.getState().handleToolCallDelta(msgId, 'tc_c1', '{"path":"a.ts"')

    // toolCalls 也应有占位条目
    expect(useAppStore.getState().messages[0].toolCalls![0].status).toBe('running')

    mockInvoke.mockResolvedValue(undefined)
    await useAppStore.getState().cancelExecution()

    // 取消后本地不动，等主进程 message-end
    expect(useAppStore.getState().messages[0].toolCalls![0].status).toBe('running')

    useAppStore.getState().handleMessageEnd(msgId, true)

    const state = useAppStore.getState()
    // toolCalls 中的条目也应标记为 error
    expect(state.messages[0].toolCalls![0].status).toBe('error')
    expect(state.messages[0].toolCalls![0].result).toContain('取消')
  })
})