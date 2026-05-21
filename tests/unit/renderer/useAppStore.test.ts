import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useAppStore } from '../../../src/renderer/stores/useAppStore'

// 模拟 window.api
const mockInvoke = vi.fn()
const mockOn = vi.fn()
const mockRemoveAllListeners = vi.fn()

// 挂载到全局 window 对象
global.window = {
  ...global.window,
  api: {
    invoke: mockInvoke,
    on: mockOn,
    removeAllListeners: mockRemoveAllListeners
  }
} as unknown as Window & typeof globalThis

describe('useAppStore Zustand Store', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    
    // 重置 store 状态到默认值
    useAppStore.setState({
      currentProject: null,
      currentMode: 'default',
      sessions: [],
      currentSessionId: null,
      messages: [],
      isGenerating: false,
      currentGeneratingMessageId: null,
      modelConfig: null,
      isConfigModalOpen: false,
      pendingPermissionRequest: null,
      isSubmittingPermission: false,
      permissionError: null
    })
  })

  it('应该能够成功切换运行模式并同步至主进程', async () => {
    mockInvoke.mockResolvedValue(undefined)

    // 执行模式切换
    await useAppStore.getState().setMode('plan')

    // 验证调用了 IPC
    expect(mockInvoke).toHaveBeenCalledWith('set-mode', 'plan')
    // 验证 store 的值已被更新
    expect(useAppStore.getState().currentMode).toBe('plan')
  })

  it('应该能正确处理主进程推送的 assistant 消息流式开始事件', () => {
    const testMsgId = 'assistant-msg-1'
    
    // 触发 handleMessageStart
    useAppStore.getState().handleMessageStart(testMsgId)

    const state = useAppStore.getState()
    expect(state.isGenerating).toBe(false) // 这里只追加消息壳，sendMessage 才设置 isGenerating
    expect(state.currentGeneratingMessageId).toBe(testMsgId)
    expect(state.messages.length).toBe(1)
    expect(state.messages[0]).toEqual(expect.objectContaining({
      id: testMsgId,
      role: 'assistant',
      content: '',
      toolCalls: []
    }))
  })

  it('应该能正确处理流式字符片段追加', () => {
    const testMsgId = 'assistant-msg-1'
    
    // 先开始消息
    useAppStore.getState().handleMessageStart(testMsgId)
    // 触发两次文本追加
    useAppStore.getState().handleTextDelta(testMsgId, '你好')
    useAppStore.getState().handleTextDelta(testMsgId, '，我是 Nova。')

    const state = useAppStore.getState()
    expect(state.messages[0].content).toBe('你好，我是 Nova。')
  })

  it('应该能正确处理只读工具调用的流式插入与结果更新', () => {
    const testMsgId = 'assistant-msg-1'
    
    // 1. 初始化消息
    useAppStore.getState().handleMessageStart(testMsgId)

    // 2. 触发工具调用开始执行
    useAppStore.getState().handleToolCall(testMsgId, 'ls', { path: './' })
    let state = useAppStore.getState()
    
    expect(state.messages[0].toolCalls?.length).toBe(1)
    const toolCall = state.messages[0].toolCalls![0]
    expect(toolCall.name).toBe('ls')
    expect(toolCall.status).toBe('running')
    expect(toolCall.arguments).toEqual({ path: './' })

    // 3. 触发工具执行成功并回传结果
    useAppStore.getState().handleToolResult(testMsgId, 'ls', 'file1.txt\nfile2.txt')
    state = useAppStore.getState()

    const toolResult = state.messages[0].toolCalls![0]
    expect(toolResult.status).toBe('success')
    expect(toolResult.result).toBe('file1.txt\nfile2.txt')
  })

  it('当工具执行失败时应该能正确标记状态为 error', () => {
    const testMsgId = 'assistant-msg-1'
    useAppStore.getState().handleMessageStart(testMsgId)
    useAppStore.getState().handleToolCall(testMsgId, 'read', { path: 'none.txt' })
    
    // 回传失败结果
    useAppStore.getState().handleToolResult(testMsgId, 'read', '工具执行失败: 文件不存在')
    const state = useAppStore.getState()

    const toolResult = state.messages[0].toolCalls![0]
    expect(toolResult.status).toBe('error')
    expect(toolResult.result).toBe('工具执行失败: 文件不存在')
  })

  it('应该保存来自主进程的权限请求', () => {
    useAppStore.getState().handlePermissionRequest({
      messageId: 'msg_1',
      requestId: 'req_1',
      toolName: 'bash',
      args: { command: 'npm test' },
      riskLevel: 'low',
      reason: '命令执行'
    })

    const state = useAppStore.getState()
    expect(state.pendingPermissionRequest).toEqual({
      messageId: 'msg_1',
      requestId: 'req_1',
      toolName: 'bash',
      args: { command: 'npm test' },
      riskLevel: 'low',
      reason: '命令执行'
    })
    expect(state.permissionError).toBeNull()
  })

  it('用户回应权限请求后应回传主进程并清空挂起状态', async () => {
    mockInvoke.mockResolvedValue(undefined)
    useAppStore.getState().handlePermissionRequest({
      messageId: 'msg_2',
      requestId: 'req_2',
      toolName: 'bash',
      args: { command: 'npm run build' },
      riskLevel: 'medium',
      reason: '命令执行'
    })

    await useAppStore.getState().respondPermissionRequest('allow')

    expect(mockInvoke).toHaveBeenCalledWith('respond-permission', {
      requestId: 'req_2',
      decision: 'allow'
    })
    expect(useAppStore.getState().pendingPermissionRequest).toBeNull()
    expect(useAppStore.getState().isSubmittingPermission).toBe(false)
  })
})
