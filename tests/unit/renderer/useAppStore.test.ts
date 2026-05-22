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
      permissionError: null,
      messageDiffs: {},
      loadingDiffs: new Set()
    })
  })

  it('应该能够成功切换运行模式并同步至主进程', async () => {
    mockInvoke.mockResolvedValue(undefined)

    // 执行模式切换
    await useAppStore.getState().setMode('plan')

    // 验证调用了 IPC
    expect(mockInvoke).toHaveBeenCalledWith('set-mode', {
      mode: 'plan',
      sessionId: undefined
    })
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
    useAppStore.getState().handleToolCall(testMsgId, 'tc_ls_1', 'ls', { path: './' })
    let state = useAppStore.getState()
    
    expect(state.messages[0].toolCalls?.length).toBe(1)
    const toolCall = state.messages[0].toolCalls![0]
    expect(toolCall.id).toBe('tc_ls_1')
    expect(toolCall.name).toBe('ls')
    expect(toolCall.status).toBe('running')
    expect(toolCall.arguments).toEqual({ path: './' })

    // 3. 触发工具执行成功并回传结果
    useAppStore.getState().handleToolResult(testMsgId, 'tc_ls_1', 'ls', 'file1.txt\nfile2.txt')
    state = useAppStore.getState()

    const toolResult = state.messages[0].toolCalls![0]
    expect(toolResult.status).toBe('success')
    expect(toolResult.result).toBe('file1.txt\nfile2.txt')
  })

  it('当工具执行失败时应该能正确标记状态为 error', () => {
    const testMsgId = 'assistant-msg-1'
    useAppStore.getState().handleMessageStart(testMsgId)
    useAppStore.getState().handleToolCall(testMsgId, 'tc_read_1', 'read', { path: 'none.txt' })
    
    // 回传失败结果
    useAppStore.getState().handleToolResult(testMsgId, 'tc_read_1', 'read', '工具执行失败: 文件不存在')
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

  it('加载历史会话时应正确恢复工具调用结果和错误状态', async () => {
    mockInvoke
      .mockResolvedValueOnce({
        id: 'sess_1',
        workspaceRoot: '/project/root',
        mode: 'default',
        createdAt: 1,
        updatedAt: 2,
        messageCount: 1,
        messages: [
          {
            id: 'msg_assistant_1',
            sessionId: 'sess_1',
            role: 'assistant',
            content: '已完成',
            timestamp: 3,
            toolCalls: [
              {
                id: 'tc_1',
                name: 'bash',
                arguments: { command: 'npm test' }
              }
            ],
            _toolCallResults: {
              tc_1: '工具执行失败: 测试失败'
            }
          }
        ]
      })
      .mockResolvedValueOnce({
        diffs: [],
        reviews: {}
      })

    await useAppStore.getState().selectSession('sess_1')

    const message = useAppStore.getState().messages[0]
    expect(message.toolCalls?.[0].result).toBe('工具执行失败: 测试失败')
    expect(message.toolCalls?.[0].status).toBe('error')
  })

  it('回退后重新加载会话时应复用同一套工具结果恢复逻辑', async () => {
    mockInvoke
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({
        id: 'sess_1',
        workspaceRoot: '/project/root',
        mode: 'auto',
        createdAt: 1,
        updatedAt: 4,
        messageCount: 1,
        messages: [
          {
            id: 'msg_assistant_2',
            sessionId: 'sess_1',
            role: 'assistant',
            content: '构建完成',
            timestamp: 5,
            toolCalls: [
              {
                id: 'tc_2',
                name: 'bash',
                arguments: { command: 'npm run build' }
              }
            ],
            _toolCallResults: {
              tc_2: '构建成功'
            }
          }
        ]
      })

    await useAppStore.getState().rollbackMessage('sess_1', 'msg_user_1')

    expect(mockInvoke).toHaveBeenNthCalledWith(1, 'rollback-message', {
      sessionId: 'sess_1',
      messageId: 'msg_user_1'
    })
    expect(mockInvoke).toHaveBeenNthCalledWith(2, 'load-session', { sessionId: 'sess_1' })

    const state = useAppStore.getState()
    expect(state.currentMode).toBe('auto')
    expect(state.messages[0].toolCalls?.[0].result).toBe('构建成功')
    expect(state.messages[0].toolCalls?.[0].status).toBe('success')
  })

  it('loadMessageDiffs 应缓存 diff 与审查状态', async () => {
    mockInvoke.mockResolvedValueOnce({
      diffs: [
        {
          filePath: 'src/app.ts',
          status: 'modified',
          hunks: []
        }
      ],
      reviews: {
        'src/app.ts': 'accepted'
      }
    })

    await useAppStore.getState().loadMessageDiffs('sess_1', 'msg_1')

    expect(useAppStore.getState().messageDiffs['msg_1']).toEqual({
      diffs: [
        {
          filePath: 'src/app.ts',
          status: 'modified',
          hunks: []
        }
      ],
      reviews: {
        'src/app.ts': 'accepted'
      }
    })
  })

  it('acceptFile 应更新本地缓存中的审查状态', async () => {
    mockInvoke.mockResolvedValueOnce(undefined)
    useAppStore.setState({
      messageDiffs: {
        msg_1: {
          diffs: [{ filePath: 'src/app.ts', status: 'modified', hunks: [] }],
          reviews: {}
        }
      }
    })

    await useAppStore.getState().acceptFile('sess_1', 'msg_1', 'src/app.ts')

    expect(mockInvoke).toHaveBeenCalledWith('accept-file', {
      sessionId: 'sess_1',
      messageId: 'msg_1',
      filePath: 'src/app.ts'
    })
    expect(useAppStore.getState().messageDiffs['msg_1'].reviews['src/app.ts']).toBe('accepted')
  })

  it('rejectFile 应更新本地缓存中的 rejected 状态', async () => {
    mockInvoke.mockResolvedValueOnce(undefined)
    useAppStore.setState({
      messageDiffs: {
        msg_1: {
          diffs: [{ filePath: 'src/app.ts', status: 'modified', hunks: [] }],
          reviews: {}
        }
      }
    })

    await useAppStore.getState().rejectFile('sess_1', 'msg_1', 'src/app.ts')

    expect(mockInvoke).toHaveBeenCalledWith('reject-file', {
      sessionId: 'sess_1',
      messageId: 'msg_1',
      filePath: 'src/app.ts'
    })
    expect(useAppStore.getState().messageDiffs['msg_1'].reviews['src/app.ts']).toBe('rejected')
  })

  it('rejectFile 失败时应继续向上抛错，供 UI 显示错误', async () => {
    mockInvoke.mockRejectedValueOnce(new Error('boom'))
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      await expect(
        useAppStore.getState().rejectFile('sess_1', 'msg_1', 'src/app.ts')
      ).rejects.toThrow('boom')
    } finally {
      consoleErrorSpy.mockRestore()
    }
  })
})
