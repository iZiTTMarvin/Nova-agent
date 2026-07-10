import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useAppStore } from '../../../src/renderer/stores/useAppStore'
import { useChatStore, resetChatStoreForTests } from '../../../src/renderer/stores/useChatStore'
import { useWorkspaceStore } from '../../../src/renderer/stores/useWorkspaceStore'
import { resetWorkspaceDispatcherForTests } from '../../../src/renderer/stores/workspaceDispatcher'

// 模拟 window.api
const mockInvoke = vi.fn()
const mockOn = vi.fn(() => () => {}) // on 返回 unsubscribe 函数
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

/**
 * 构造一个 WorkspaceState 广播载荷（PRD §5.1 新架构）。
 * selectSession / regenerateAssistant / switchBranch / setMode 等操作的主进程返回值都是这个结构。
 */
function makeWorkspaceState(overrides: Partial<{
  currentSessionId: string | null
  currentProjectPath: string | null
  currentMode: 'plan' | 'default' | 'compose'
  availableSessions: Array<{ id: string; workspaceRoot: string; mode: 'plan' | 'default' | 'compose'; createdAt: number; updatedAt: number; messageCount: number }>
  messagesRevision: number
  tier1BranchContext: null
}> = {}): {
  currentSessionId: string | null
  currentProjectPath: string | null
  currentMode: 'plan' | 'default' | 'compose'
  availableSessions: Array<{ id: string; workspaceRoot: string; mode: 'plan' | 'default' | 'compose'; createdAt: number; updatedAt: number; messageCount: number }>
  messagesRevision: number
  tier1BranchContext: null
} {
  return {
    currentSessionId: null,
    currentProjectPath: '/project/root',
    currentMode: 'default',
    availableSessions: [],
    messagesRevision: 0,
    tier1BranchContext: null,
    ...overrides
  }
}

describe('useAppStore Zustand Store', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    // 默认处理 run:* IPC，避免 dispatcher/pullSnapshot 吞掉用例里的 mockResolvedValueOnce
    mockInvoke.mockImplementation(async (channel: string) => {
      if (channel === 'run:get-snapshot') {
        return { snapshot: null, waitingSessions: [] }
      }
      if (channel === 'run:list-waiting-sessions') {
        return { waitingSessions: [] }
      }
      return undefined
    })

    // 重置 store 状态到默认值
    resetChatStoreForTests()
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
    // PRD §5.1：重置 workspace store 与 dispatcher 内部状态
    useWorkspaceStore.setState({
      currentSessionId: null,
      currentProjectPath: null,
      currentMode: 'default',
      availableSessions: [],
      initialized: false
    })
    resetWorkspaceDispatcherForTests()
  })

  it('应该能够成功切换运行模式并同步至主进程', async () => {
    // PRD §5.1：setMode 现在转发到 workspace store，返回 WorkspaceState
    mockInvoke.mockResolvedValue(makeWorkspaceState({ currentMode: 'plan' }))

    // 执行模式切换
    await useAppStore.getState().setMode('plan')

    // 验证调用了 workspace IPC（单一事实源）
    expect(mockInvoke).toHaveBeenCalledWith('workspace:set-mode', { mode: 'plan' })
    // 验证 store 的值已被 dispatcher 同步更新
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

    // T2-6：回答携带 commandId（幂等）；其余字段与旧契约兼容
    expect(mockInvoke).toHaveBeenCalledWith(
      'respond-permission',
      expect.objectContaining({
        requestId: 'req_2',
        decision: 'allow',
        commandId: expect.any(String)
      })
    )
    expect(useAppStore.getState().pendingPermissionRequest).toBeNull()
    expect(useAppStore.getState().isSubmittingPermission).toBe(false)
  })

  it('加载历史会话时应正确恢复工具调用结果和错误状态', async () => {
    // PRD §5.1 新链路：workspace:select-session（返回 WorkspaceState）→ load-session（返回 SessionDetail）
    mockInvoke
      .mockResolvedValueOnce(makeWorkspaceState({ currentSessionId: 'sess_1', currentMode: 'default' }))
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

    // T06：selectSession 不再自动调 loadMessageDiffs，无需 mock get-message-diffs

    await useAppStore.getState().selectSession('sess_1')
    // 等待 syncFromWorkspace 内部异步 load-session 完成
    await new Promise(resolve => setTimeout(resolve, 0))

    const message = useAppStore.getState().messages[0]
    expect(message.toolCalls?.[0].result).toBe('工具执行失败: 测试失败')
    expect(message.toolCalls?.[0].status).toBe('error')
  })

  it('加载带 blocks 的历史会话时应保留顺序块结构', async () => {
    mockInvoke
      .mockResolvedValueOnce(makeWorkspaceState({ currentSessionId: 'sess_blocks', currentMode: 'plan' }))
      .mockResolvedValueOnce({
        id: 'sess_blocks',
        workspaceRoot: '/project/root',
        mode: 'plan',
        createdAt: 1,
        updatedAt: 2,
        messageCount: 1,
        messages: [
          {
            id: 'msg_blocks_1',
            sessionId: 'sess_blocks',
            role: 'assistant',
            content: '规划结论',
            timestamp: 3,
            blocks: [
              { type: 'thinking', content: '先看目录' },
              { type: 'text', content: '规划结论' }
            ]
          }
        ]
      })

    // T06：selectSession 不再自动调 loadMessageDiffs

    await useAppStore.getState().selectSession('sess_blocks')
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(useAppStore.getState().messages[0].blocks).toEqual([
      { type: 'thinking', content: '先看目录' },
      { type: 'text', content: '规划结论' }
    ])
  })

  it('旧消息无 blocks 时应去掉历史 think 标签，只保留正文', async () => {
    mockInvoke
      .mockResolvedValueOnce(makeWorkspaceState({ currentSessionId: 'sess_legacy', currentMode: 'default' }))
      .mockResolvedValueOnce({
        id: 'sess_legacy',
        workspaceRoot: '/project/root',
        mode: 'default',
        createdAt: 1,
        updatedAt: 2,
        messageCount: 1,
        messages: [
          {
            id: 'msg_legacy_1',
            sessionId: 'sess_legacy',
            role: 'assistant',
            // 含诸如标签的旧消息回归测试，字符串拼接避免编辑器误识别
            content: '<' + 'think' + '>先分析</' + 'think' + '>真正正文',
            timestamp: 3
          }
        ]
      })

    // T06：selectSession 不再自动调 loadMessageDiffs

    await useAppStore.getState().selectSession('sess_legacy')
    await new Promise(resolve => setTimeout(resolve, 0))

    await useAppStore.getState().selectSession('sess_legacy')

    const message = useAppStore.getState().messages[0]
    expect(message.content).toBe('真正正文')
    expect(message.blocks).toEqual([{ type: 'text', content: '真正正文' }])
  })

  it('切换分支后重新加载会话时应复用同一套工具结果恢复逻辑', async () => {
    mockInvoke
      .mockResolvedValueOnce(makeWorkspaceState({ currentSessionId: 'sess_1', currentMode: 'compose', messagesRevision: 1 }))
      .mockResolvedValueOnce({
        id: 'sess_1',
        workspaceRoot: '/project/root',
        mode: 'compose',
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

    await useAppStore.getState().switchBranch('sess_1', 'msg_user_2')
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(mockInvoke).toHaveBeenNthCalledWith(1, 'workspace:switch-branch', {
      sessionId: 'sess_1',
      targetMessageId: 'msg_user_2'
    })
    expect(mockInvoke).toHaveBeenNthCalledWith(2, 'load-session', { sessionId: 'sess_1' })

    const state = useAppStore.getState()
    expect(state.currentMode).toBe('compose')
    expect(state.messages[0].toolCalls?.[0].result).toBe('构建成功')
    expect(state.messages[0].toolCalls?.[0].status).toBe('success')
  })

  it('同会话切换分支时 messagesRevision 递增应触发重拉消息', async () => {
    const { dispatchWorkspaceChange } = await import('../../../src/renderer/stores/workspaceDispatcher')

    // 先选中会话并加载首屏
    mockInvoke
      .mockResolvedValueOnce(makeWorkspaceState({ currentSessionId: 'sess_rev', messagesRevision: 0 }))
      .mockResolvedValueOnce({
        id: 'sess_rev',
        workspaceRoot: '/project/root',
        mode: 'default',
        createdAt: 1,
        updatedAt: 2,
        messageCount: 2,
        messages: [
          { id: 'u1', sessionId: 'sess_rev', role: 'user', content: '旧', timestamp: 1 },
          { id: 'a1', sessionId: 'sess_rev', role: 'assistant', content: '答', timestamp: 2 }
        ]
      })

    await useAppStore.getState().selectSession('sess_rev')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(useAppStore.getState().messages).toHaveLength(2)
    expect(useChatStore.getState().lastMessagesRevision).toBe(0)

    mockInvoke.mockClear()
    mockInvoke.mockResolvedValueOnce({
      id: 'sess_rev',
      workspaceRoot: '/project/root',
      mode: 'default',
      createdAt: 1,
      updatedAt: 3,
      messageCount: 1,
      messages: [
        { id: 'u1', sessionId: 'sess_rev', role: 'user', content: '旧', timestamp: 1 }
      ]
    })

    dispatchWorkspaceChange(makeWorkspaceState({ currentSessionId: 'sess_rev', messagesRevision: 1 }))
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(mockInvoke).toHaveBeenCalledWith('load-session', { sessionId: 'sess_rev' })
    expect(useAppStore.getState().messages).toHaveLength(1)
    expect(useAppStore.getState().messages[0].id).toBe('u1')
  })

  it('editResend 应先分叉准备再发送新内容', async () => {
    useWorkspaceStore.setState({
      currentSessionId: 'sess_edit',
      currentProjectPath: '/project/root',
      currentMode: 'default',
      availableSessions: [],
      initialized: true
    })
    useAppStore.setState({
      currentProject: '/project/root',
      currentSessionId: 'sess_edit',
      messages: [
        { id: 'u1', sessionId: 'sess_edit', role: 'user', content: '你好', timestamp: 1, _revision: 0 },
        { id: 'a1', sessionId: 'sess_edit', role: 'assistant', content: '嗨', timestamp: 2, _revision: 0 }
      ],
      messageIndexById: { u1: 0, a1: 1 }
    })
    useChatStore.setState({ lastMessagesRevision: 0 })

    mockInvoke
      .mockResolvedValueOnce(makeWorkspaceState({ currentSessionId: 'sess_edit', messagesRevision: 0 }))
      .mockResolvedValueOnce(undefined) // send-message

    await useAppStore.getState().editResend('sess_edit', 'u1', '你好呀')

    expect(mockInvoke).toHaveBeenCalledWith('workspace:edit-resend', {
      sessionId: 'sess_edit',
      messageId: 'u1'
    })
    const sendCall = mockInvoke.mock.calls.find(c => c[0] === 'send-message')
    expect(sendCall).toBeDefined()
    expect(sendCall![1]).toEqual(expect.objectContaining({
      sessionId: 'sess_edit',
      content: '你好呀',
      userMessageId: expect.stringMatching(/^msg_\d+_user$/)
    }))
    // 乐观截断后 sendMessage 会追加新用户消息
    const after = useAppStore.getState()
    expect(after.messages).toHaveLength(1)
    expect(after.messages[0].content).toBe('你好呀')
    expect(after.messages[0].role).toBe('user')
    // IPC 携带的 userMessageId 须与界面乐观消息 id 一致
    expect((sendCall![1] as { userMessageId?: string }).userMessageId).toBe(after.messages[0].id)
  })

  it('sendMessage 应向主进程传递与乐观 UI 相同的 userMessageId', async () => {
    useWorkspaceStore.setState({
      currentSessionId: 'sess_send',
      currentProjectPath: '/project/root',
      currentMode: 'default',
      availableSessions: [],
      initialized: true
    })
    useChatStore.setState({
      currentSessionId: 'sess_send',
      messages: [],
      messageIndexById: {}
    })
    mockInvoke.mockResolvedValue(undefined)

    await useChatStore.getState().sendMessage('你好')

    const userMsg = useChatStore.getState().messages[0]
    expect(userMsg?.role).toBe('user')
    expect(mockInvoke).toHaveBeenCalledWith('send-message', expect.objectContaining({
      sessionId: 'sess_send',
      content: '你好',
      userMessageId: userMsg!.id
    }))
  })

  it('regenerateAssistant 应先分叉准备再以 regenerate 模式发送', async () => {
    useWorkspaceStore.setState({
      currentSessionId: 'sess_regen',
      currentProjectPath: '/project/root',
      currentMode: 'default',
      availableSessions: [],
      initialized: true
    })
    useAppStore.setState({
      currentProject: '/project/root',
      currentSessionId: 'sess_regen',
      messages: [
        { id: 'u1', sessionId: 'sess_regen', role: 'user', content: '你好', timestamp: 1, _revision: 0 },
        { id: 'a1', sessionId: 'sess_regen', role: 'assistant', content: '嗨', timestamp: 2, _revision: 0 }
      ],
      messageIndexById: { u1: 0, a1: 1 }
    })

    mockInvoke
      .mockResolvedValueOnce(makeWorkspaceState({ currentSessionId: 'sess_regen', messagesRevision: 0 }))
      .mockResolvedValueOnce(undefined)

    await useAppStore.getState().regenerateAssistant('sess_regen', 'a1')

    expect(mockInvoke).toHaveBeenCalledWith('workspace:regenerate', {
      sessionId: 'sess_regen',
      messageId: 'a1'
    })
    const sendCall = mockInvoke.mock.calls.find(c => c[0] === 'send-message')
    expect(sendCall).toBeDefined()
    expect(sendCall![1]).toEqual(expect.objectContaining({
      sessionId: 'sess_regen',
      content: '',
      regenerate: true
    }))
    expect(useAppStore.getState().messages).toHaveLength(1)
    expect(useAppStore.getState().messages[0].id).toBe('u1')
  })

  it('finishBranchMetaRefresh 应在 pending 时 bump revision 并触发 load-session', async () => {
    mockInvoke.mockReset()
    useWorkspaceStore.setState({
      currentSessionId: 'sess_branch',
      currentProjectPath: '/project/root',
      currentMode: 'default',
      availableSessions: [],
      initialized: true
    })
    useChatStore.setState({
      currentSessionId: 'sess_branch',
      lastMessagesRevision: 0,
      pendingBranchMetaReload: true,
      messages: [{ id: 'u1', sessionId: 'sess_branch', role: 'user', content: 'x', timestamp: 1, _revision: 0 }],
      messageIndexById: { u1: 0 }
    })

    mockInvoke
      .mockResolvedValueOnce(makeWorkspaceState({ currentSessionId: 'sess_branch', messagesRevision: 1 }))
      .mockResolvedValueOnce({
        id: 'sess_branch',
        messages: [
          { id: 'u1', sessionId: 'sess_branch', role: 'user', content: 'x', timestamp: 1, branch: { index: 1, total: 2, siblingIds: ['u1', 'u2'] } }
        ],
        hasMoreMessagesAbove: false
      })

    await useChatStore.getState().finishBranchMetaRefresh()

    expect(mockInvoke).toHaveBeenCalledWith('workspace:bump-messages-revision')
    expect(useChatStore.getState().pendingBranchMetaReload).toBe(false)
    expect(useChatStore.getState().lastMessagesRevision).toBe(1)
    await vi.waitFor(() => {
      expect(useChatStore.getState().messages[0]?.branch?.total).toBe(2)
    })
  })

  it('editResend send 失败时应 await finishBranchMetaRefresh 对齐主进程', async () => {
    useWorkspaceStore.setState({
      currentSessionId: 'sess_fail',
      currentProjectPath: '/project/root',
      currentMode: 'default',
      availableSessions: [],
      initialized: true
    })
    useChatStore.setState({
      currentSessionId: 'sess_fail',
      lastMessagesRevision: 0,
      messages: [
        { id: 'u1', sessionId: 'sess_fail', role: 'user', content: '你好', timestamp: 1, _revision: 0 },
        { id: 'a1', sessionId: 'sess_fail', role: 'assistant', content: '嗨', timestamp: 2, _revision: 0 }
      ],
      messageIndexById: { u1: 0, a1: 1 }
    })

    // 按 channel 路由，避免 run:get-snapshot 抢走 once 队列
    mockInvoke.mockImplementation(async (channel: string) => {
      if (channel === 'run:get-snapshot') return { snapshot: null, waitingSessions: [] }
      if (channel === 'run:list-waiting-sessions') return { waitingSessions: [] }
      if (channel === 'workspace:edit-resend') {
        return makeWorkspaceState({ currentSessionId: 'sess_fail', messagesRevision: 0 })
      }
      if (channel === 'send-message') throw new Error('send failed')
      if (channel === 'workspace:bump-messages-revision') {
        return makeWorkspaceState({ currentSessionId: 'sess_fail', messagesRevision: 1 })
      }
      if (channel === 'load-session') {
        return { id: 'sess_fail', messages: [], hasMoreMessagesAbove: false }
      }
      return undefined
    })

    await useAppStore.getState().editResend('sess_fail', 'u1', '你好呀')

    expect(mockInvoke).toHaveBeenCalledWith('workspace:bump-messages-revision')
    expect(useChatStore.getState().pendingBranchMetaReload).toBe(false)
    expect(useChatStore.getState().branchForkInProgress).toBe(false)
    expect(useChatStore.getState().isGenerating).toBe(false)
  })

  it('loadMessageDiffs 应缓存 diff 与审查状态', async () => {
    mockInvoke.mockImplementation(async (channel: string) => {
      if (channel === 'run:get-snapshot') return { snapshot: null, waitingSessions: [] }
      if (channel === 'get-message-diffs') {
        return {
          diffs: [{ filePath: 'src/app.ts', status: 'modified', hunks: [] }],
          reviews: { 'src/app.ts': 'accepted' }
        }
      }
      return undefined
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

  it('handleDiffUpdate(live) 不应写入 messageDiffs，而应把 messageId 标记为 loading', () => {
    useAppStore.getState().handleDiffUpdate(
      'msg_live_1',
      'live',
      [{ filePath: 'src/live.ts', status: 'modified' }],
      {}
    )

    const state = useAppStore.getState()
    expect(state.messageDiffs['msg_live_1']).toBeUndefined()
    expect(state.loadingDiffs.has('msg_live_1')).toBe(true)
  })

  it('handleDiffUpdate(final) 应写入完整 diff 数据并清除 loading 标记', () => {
    // 先模拟一次 live 占位
    useAppStore.getState().handleDiffUpdate(
      'msg_final_1',
      'live',
      [{ filePath: 'src/final.ts', status: 'modified' }],
      {}
    )
    expect(useAppStore.getState().loadingDiffs.has('msg_final_1')).toBe(true)

    // 再模拟 final：携带完整 hunks
    useAppStore.getState().handleDiffUpdate(
      'msg_final_1',
      'final',
      [{
        filePath: 'src/final.ts',
        status: 'modified',
        hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, content: ' a' }]
      }],
      { 'src/final.ts': 'pending' as const }
    )

    const state = useAppStore.getState()
    expect(state.loadingDiffs.has('msg_final_1')).toBe(false)
    expect(state.messageDiffs['msg_final_1']).toEqual({
      diffs: [{
        filePath: 'src/final.ts',
        status: 'modified',
        hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, content: ' a' }]
      }],
      reviews: { 'src/final.ts': 'pending' }
    })
  })

  it('handleDiffUpdate 应实时写入当前消息的 diff 元数据', () => {
    useAppStore.getState().handleDiffUpdate(
      'msg_1',
      'final',
      [{ filePath: 'src/live.ts', status: 'modified', hunks: [] }],
      {}
    )

    expect(useAppStore.getState().messageDiffs['msg_1']).toEqual({
      diffs: [{ filePath: 'src/live.ts', status: 'modified', hunks: [] }],
      reviews: {}
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
    mockInvoke.mockImplementation(async (channel: string) => {
      if (channel === 'run:get-snapshot') return { snapshot: null, waitingSessions: [] }
      if (channel === 'reject-file') throw new Error('boom')
      return undefined
    })
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      await expect(
        useAppStore.getState().rejectFile('sess_1', 'msg_1', 'src/app.ts')
      ).rejects.toThrow('boom')
    } finally {
      consoleErrorSpy.mockRestore()
    }
  })

  /**
   * T1 回归：tool_result → diff_update(live) → message_end → loadMessageDiffs(final)
   * 断言中间任何时刻都不会出现"+0 -0"语义（即不会出现 hunks 为空但被当作完整数据的 messageDiffs 条目）。
   */
  it('T1 回归：流式期间不应出现 hunks 为空的 messageDiffs 中间态', async () => {
    const messageId = 'msg_t1_regression'
    const sessionId = 'sess_t1'

    useAppStore.setState({ currentSessionId: sessionId })

    // 1. 模拟 message_start + tool_call + tool_result（与 store 实际接收事件一致）
    useAppStore.getState().handleMessageStart(messageId)
    useAppStore.getState().handleToolCall(messageId, 'tc_w_1', 'write', { path: 'src/foo.ts' })
    useAppStore.getState().handleToolResult(messageId, 'tc_w_1', 'write', '写入成功')

    // 此时还没有 diff_update：messageDiffs 应为空
    expect(useAppStore.getState().messageDiffs[messageId]).toBeUndefined()

    // 2. 模拟 emitLiveDiffUpdate 推送 phase: 'live'
    useAppStore.getState().handleDiffUpdate(
      messageId,
      'live',
      [{ filePath: 'src/foo.ts', status: 'modified' }],
      {}
    )

    // 关键断言：live 阶段不应写入 messageDiffs（避免 DiffViewer 渲染 +0 -0）
    expect(useAppStore.getState().messageDiffs[messageId]).toBeUndefined()
    expect(useAppStore.getState().loadingDiffs.has(messageId)).toBe(true)
    expect(useAppStore.getState().loadingDiffPlaceholders[messageId]).toEqual([
      { filePath: 'src/foo.ts', status: 'modified' }
    ])

    // 3. 模拟 message_end 触发 loadMessageDiffs，后端返回完整 hunks
    mockInvoke.mockImplementation(async (channel: string) => {
      if (channel === 'run:get-snapshot') return { snapshot: null, waitingSessions: [] }
      if (channel === 'get-message-diffs') {
        return {
          diffs: [{
            filePath: 'src/foo.ts',
            status: 'modified',
            hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, content: ' a\n+b' }]
          }],
          reviews: {}
        }
      }
      return undefined
    })
    // handleMessageEnd 内部会调 loadMessageDiffs(currentSessionId, messageId)
    useAppStore.getState().handleMessageEnd(messageId)
    // 等微任务：loadMessageDiffs 是 async
    await new Promise(resolve => setTimeout(resolve, 0))

    // 最终状态：拿到完整 hunks，loading 标记被清除
    const finalState = useAppStore.getState()
    expect(finalState.loadingDiffs.has(messageId)).toBe(false)
    expect(finalState.messageDiffs[messageId]?.diffs[0].hunks).toEqual([
      { oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, content: ' a\n+b' }
    ])
    expect(finalState.loadingDiffPlaceholders[messageId]).toBeUndefined()
  })

  /**
   * T1 竞态回归：final 已经写入 messageDiffs 后，迟到的 live 事件不能把真实数据压回骨架。
   *
   * 触发场景：tool_result 被 setImmediate 异步调度的 live emit 排队中，message_end 已经
   * 同步走完，loadMessageDiffs 拿到 final 数据，最后 live 才被事件循环消费。
   */
  it('T1 竞态：late live 不应覆盖已存在的最终 diff 数据', () => {
    const messageId = 'msg_late_live'

    // 1. 模拟 final 已经先到（loadMessageDiffs 完成）
    useAppStore.getState().handleDiffUpdate(
      messageId,
      'final',
      [{
        filePath: 'src/foo.ts',
        status: 'modified',
        hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, content: ' a\n+b' }]
      }],
      {}
    )
    expect(useAppStore.getState().messageDiffs[messageId]).toBeDefined()
    expect(useAppStore.getState().loadingDiffs.has(messageId)).toBe(false)

    // 2. 模拟迟到的 live 事件（被 setImmediate 排队晚到）
    useAppStore.getState().handleDiffUpdate(
      messageId,
      'live',
      [{ filePath: 'src/foo.ts', status: 'modified' }],
      {}
    )

    // 关键断言：messageDiffs 不应被清掉，loadingDiffs 不应被重新打开
    const state = useAppStore.getState()
    expect(state.messageDiffs[messageId]?.diffs[0].hunks).toEqual([
      { oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, content: ' a\n+b' }
    ])
    expect(state.loadingDiffs.has(messageId)).toBe(false)
    expect(state.loadingDiffPlaceholders[messageId]).toBeUndefined()
  })

  /**
   * T5 回归：messageIndexById 索引在 delta 处理中应与 messages 数组保持一致
   */
  describe('T5: messageIndexById 索引与 delta 优化', () => {
    it('handleMessageStart 应同步维护 messageIndexById', () => {
      useAppStore.getState().handleMessageStart('msg_idx_1')
      const state = useAppStore.getState()
      expect(state.messageIndexById['msg_idx_1']).toBe(0)
      expect(state.messages[0].id).toBe('msg_idx_1')
    })

    it('多次追加消息后索引应正确反映位置', () => {
      useAppStore.getState().handleMessageStart('msg_a')
      useAppStore.getState().handleMessageStart('msg_b')
      const state = useAppStore.getState()
      expect(state.messageIndexById['msg_a']).toBe(0)
      expect(state.messageIndexById['msg_b']).toBe(1)
    })

    it('handleThinkingDelta 应通过索引定位消息，不影响其他消息', () => {
      useAppStore.getState().handleMessageStart('msg_first')
      useAppStore.getState().handleMessageStart('msg_second')

      useAppStore.getState().handleThinkingDelta('msg_second', '思考中...')

      const state = useAppStore.getState()
      // 第二条消息应该更新
      expect(state.messages[1].thinking).toBe('思考中...')
      // 第一条消息应保持不变
      expect(state.messages[0].thinking).toBe('')
    })

    it('handleTextDelta 应通过索引定位消息，不影响其他消息', () => {
      useAppStore.getState().handleMessageStart('msg_text_1')
      useAppStore.getState().handleMessageStart('msg_text_2')

      useAppStore.getState().handleTextDelta('msg_text_2', '你好')
      useAppStore.getState().handleTextDelta('msg_text_1', '世界')

      const state = useAppStore.getState()
      expect(state.messages[0].content).toBe('世界')
      expect(state.messages[1].content).toBe('你好')
    })

    it('handleToolCall 应通过索引定位消息并正确追加工具调用', () => {
      useAppStore.getState().handleMessageStart('msg_tc')
      useAppStore.getState().handleToolCall('msg_tc', 'tc_1', 'ls', { path: './' })

      const state = useAppStore.getState()
      expect(state.messages[0].toolCalls?.length).toBe(1)
      expect(state.messages[0].toolCalls![0].name).toBe('ls')
    })

    it('handleToolResult 应通过索引定位消息并正确更新工具状态', () => {
      useAppStore.getState().handleMessageStart('msg_tr')
      useAppStore.getState().handleToolCall('msg_tr', 'tc_tr_1', 'read', { path: 'a.ts' })
      useAppStore.getState().handleToolResult('msg_tr', 'tc_tr_1', 'read', '文件内容')

      const state = useAppStore.getState()
      expect(state.messages[0].toolCalls![0].status).toBe('success')
      expect(state.messages[0].toolCalls![0].result).toBe('文件内容')
    })

    it('两个工具结果反序到达时，仍应更新到各自的卡片和 toolCall', () => {
      useAppStore.getState().handleMessageStart('msg_order')
      useAppStore.getState().handleToolCall('msg_order', 'tc_a', 'read', { path: 'a.ts' })
      useAppStore.getState().handleToolCall('msg_order', 'tc_b', 'grep', { pattern: 'foo' })

      useAppStore.getState().handleToolResult('msg_order', 'tc_b', 'grep', 'grep 结果')
      useAppStore.getState().handleToolResult('msg_order', 'tc_a', 'read', 'read 结果')

      const state = useAppStore.getState()
      expect(state.messages[0].toolCalls?.[0].id).toBe('tc_a')
      expect(state.messages[0].toolCalls?.[0].result).toBe('read 结果')
      expect(state.messages[0].toolCalls?.[1].id).toBe('tc_b')
      expect(state.messages[0].toolCalls?.[1].result).toBe('grep 结果')

      const blocks = state.messages[0].blocks ?? []
      const blockA = blocks.find(b => b.type === 'tool' && b.toolCallId === 'tc_a')
      const blockB = blocks.find(b => b.type === 'tool' && b.toolCallId === 'tc_b')
      if (blockA && blockA.type === 'tool') {
        expect(blockA.result).toBe('read 结果')
        expect(blockA.status).toBe('success')
      }
      if (blockB && blockB.type === 'tool') {
        expect(blockB.result).toBe('grep 结果')
        expect(blockB.status).toBe('success')
      }
    })

    it('handleVerificationResult 应通过索引定位消息', () => {
      useAppStore.getState().handleMessageStart('msg_vr')
      useAppStore.getState().handleVerificationResult('msg_vr', '✓ 验证通过')

      const state = useAppStore.getState()
      expect(state.messages[0].verificationSummary).toBe('✓ 验证通过')
    })

    it('不存在的 messageId 应静默忽略，不修改状态', () => {
      useAppStore.getState().handleMessageStart('msg_exists')
      const before = useAppStore.getState().messages.length

      useAppStore.getState().handleThinkingDelta('msg_nonexistent', '不会出现')
      useAppStore.getState().handleTextDelta('msg_nonexistent', '不会出现')
      useAppStore.getState().handleToolCall('msg_nonexistent', 'tc_x', 'ls', {})

      const after = useAppStore.getState()
      expect(after.messages.length).toBe(before)
      expect(after.messages[0].content).toBe('')
    })
  })
})
