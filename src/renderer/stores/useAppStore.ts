import { create } from 'zustand'
import type { Mode, PermissionDecision, Session, SessionDetail, ToolCall, Message } from '../../shared/session/types'
import type { ModelConfig } from '../../shared/config'

/** 
 * 扩展的工具调用接口
 * 提供在 UI 渲染时跟踪工具执行状态和返回结果的能力
 */
export interface ExtendedToolCall extends ToolCall {
  result?: string
  status: 'running' | 'success' | 'error'
}

/** 
 * 扩展的单条聊天消息接口
 * 将标准的 toolCalls 扩展为携带状态和结果的 ExtendedToolCall，便于流式呈现
 */
export interface ExtendedMessage {
  id: string
  sessionId: string
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  toolCalls?: ExtendedToolCall[]
  timestamp: number
  isError?: boolean
}

/** 等待用户决策的权限请求 */
export interface PendingPermissionRequest {
  messageId: string
  requestId: string
  toolName: string
  args: Record<string, unknown>
  riskLevel: 'low' | 'medium' | 'high'
  reason: string
}

type SessionMessagePayload = Message & { _toolCallResults?: Record<string, string> }

function getToolCallStatus(result?: string): ExtendedToolCall['status'] {
  if (!result) return 'success'
  return result.startsWith('工具执行失败') || result.startsWith('权限拒绝:')
    ? 'error'
    : 'success'
}

function restoreSessionMessages(messages: SessionDetail['messages']): ExtendedMessage[] {
  return messages.map((message) => {
    const payload = message as SessionMessagePayload
    const results = payload._toolCallResults ?? {}

    return {
      ...message,
      toolCalls: message.toolCalls?.map((toolCall) => {
        const result = results[toolCall.id]
        return {
          id: toolCall.id,
          name: toolCall.name,
          arguments: toolCall.arguments,
          status: getToolCallStatus(result),
          result
        }
      })
    }
  })
}

function upsertSessionSummary(sessions: Session[], detail: SessionDetail): Session[] {
  const nextSummary: Session = {
    id: detail.id,
    workspaceRoot: detail.workspaceRoot,
    mode: detail.mode,
    createdAt: detail.createdAt,
    updatedAt: detail.updatedAt,
    messageCount: detail.messageCount
  }

  const others = sessions.filter(session => session.id !== detail.id)
  return [nextSummary, ...others]
}

/** Zustand 全局状态定义 */
interface AppState {
  currentProject: string | null
  currentMode: Mode
  sessions: Session[]
  currentSessionId: string | null
  messages: ExtendedMessage[]
  isGenerating: boolean
  currentGeneratingMessageId: string | null
  modelConfig: ModelConfig | null
  isConfigModalOpen: boolean
  pendingPermissionRequest: PendingPermissionRequest | null
  isSubmittingPermission: boolean
  permissionError: string | null

  // ── Actions ──────────────────────────────────────────
  
  /** 加载或切换工作区 */
  selectProject: () => Promise<void>
  
  /** 更换当前运行模式 */
  setMode: (mode: Mode) => Promise<void>
  
  /** 发送用户消息 */
  sendMessage: (content: string) => Promise<void>
  
  /** 中断当前的流式生成 */
  cancelExecution: () => Promise<void>
  
  /** 载入持久化的模型配置 */
  loadModelConfig: () => Promise<void>
  
  /** 保存新模型配置 */
  saveModelConfig: (config: ModelConfig) => Promise<void>
  
  /** 手工打开或关闭配置弹窗 */
  setConfigModalOpen: (isOpen: boolean) => void

  /** 加载会话列表及当前会话 */
  loadSessions: () => Promise<void>
  
  /** 选中指定会话，并载入相关消息 */
  selectSession: (sessionId: string) => Promise<void>

  /** 按消息回退到某条消息之前的状态 */
  rollbackMessage: (sessionId: string, messageId: string) => Promise<void>

  /** 按文件拒绝某个文件的改动 */
  rejectFile: (sessionId: string, messageId: string, filePath: string) => Promise<void>

  // ── 主进程事件驱动的状态更新 ──────────────────────────────
  
  handleMessageStart: (messageId: string) => void
  handleTextDelta: (messageId: string, delta: string) => void
  handleToolCall: (messageId: string, toolCallId: string, toolName: string, args: Record<string, unknown>) => void
  handleToolResult: (messageId: string, toolCallId: string, toolName: string, result: string) => void
  handleMessageEnd: (messageId: string) => void
  handleError: (messageId: string, error: string) => void
  handlePermissionRequest: (request: PendingPermissionRequest) => void
  respondPermissionRequest: (decision: PermissionDecision) => Promise<void>
}

export const useAppStore = create<AppState>((set, get) => ({
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

  selectProject: async () => {
    try {
      const selectedPath = await window.api.invoke('select-project')
      if (selectedPath) {
        // 通过 IPC 创建后端管理的真实会话
        const sessionDetail: SessionDetail = await window.api.invoke('create-session', {
          workspaceRoot: selectedPath,
          mode: get().currentMode
        })

        set(state => ({
          currentProject: selectedPath,
          currentSessionId: sessionDetail.id,
          currentMode: sessionDetail.mode,
          sessions: upsertSessionSummary(state.sessions, sessionDetail),
          messages: restoreSessionMessages(sessionDetail.messages)
        }))
      }
    } catch (err) {
      console.error('选择项目工作区失败:', err)
    }
  },

  setMode: async (mode: Mode) => {
    try {
      const { currentSessionId, sessions } = get()
      await window.api.invoke('set-mode', { mode, sessionId: currentSessionId ?? undefined })
      set({ currentMode: mode })
      
      // 更新当前会话的模式属性
      if (currentSessionId) {
        set({
          sessions: sessions.map(s => 
            s.id === currentSessionId ? { ...s, mode } : s
          )
        })
      }
    } catch (err) {
      console.error('切换模式失败:', err)
    }
  },

  sendMessage: async (content: string) => {
    const { currentSessionId, isGenerating, currentProject } = get()
    if (isGenerating || !currentProject) return

    const activeSessionId = currentSessionId || 'session_default'

    // 1. 创建并追加用户消息
    const userMsg: ExtendedMessage = {
      id: 'msg_' + Date.now() + '_user',
      sessionId: activeSessionId,
      role: 'user',
      content,
      timestamp: Date.now()
    }

    set(state => ({
      messages: [...state.messages, userMsg],
      isGenerating: true
    }))

    try {
      // 2. 异步发起 IPC 消息发送给主进程，主进程开始 Agent 循环并通过事件反馈
      await window.api.invoke('send-message', {
        sessionId: activeSessionId,
        content
      })
    } catch (err) {
      // 若启动 AgentLoop 出错，在此更新界面状态
      get().handleError('msg_err_' + Date.now(), (err as Error).message)
    }
  },

  cancelExecution: async () => {
    try {
      await window.api.invoke('cancel-execution')
      set({
        isGenerating: false,
        currentGeneratingMessageId: null,
        pendingPermissionRequest: null,
        isSubmittingPermission: false,
        permissionError: null
      })
    } catch (err) {
      console.error('取消执行失败:', err)
    }
  },

  loadModelConfig: async () => {
    try {
      const config = await window.api.invoke('load-model-config')
      set({ modelConfig: config })
    } catch (err) {
      console.error('读取模型配置失败:', err)
    }
  },

  saveModelConfig: async (config: ModelConfig) => {
    try {
      await window.api.invoke('save-model-config', config)
      set({ modelConfig: config, isConfigModalOpen: false })
    } catch (err) {
      console.error('保存模型配置失败:', err)
      throw err
    }
  },

  setConfigModalOpen: (isOpen: boolean) => {
    set({ isConfigModalOpen: isOpen })
  },

  loadSessions: async () => {
    try {
      const sessions: Session[] = await window.api.invoke('load-sessions')
      set({ sessions })
    } catch (err) {
      console.error('加载会话列表出错:', err)
    }
  },

  selectSession: async (sessionId: string) => {
    try {
      const detail: SessionDetail = await window.api.invoke('load-session', { sessionId })
      set({
        currentSessionId: sessionId,
        currentProject: detail.workspaceRoot,
        currentMode: detail.mode,
        sessions: upsertSessionSummary(get().sessions, detail),
        messages: restoreSessionMessages(detail.messages)
      })
    } catch (err) {
      console.error('加载会话详情出错:', err)
    }
  },

  rollbackMessage: async (sessionId: string, messageId: string) => {
    try {
      await window.api.invoke('rollback-message', { sessionId, messageId })
      // 回退成功后重新加载会话数据
      const detail: SessionDetail = await window.api.invoke('load-session', { sessionId })
      set({
        currentProject: detail.workspaceRoot,
        currentMode: detail.mode,
        sessions: upsertSessionSummary(get().sessions, detail),
        messages: restoreSessionMessages(detail.messages)
      })
    } catch (err) {
      console.error('回退消息出错:', err)
    }
  },

  rejectFile: async (sessionId: string, messageId: string, filePath: string) => {
    try {
      await window.api.invoke('reject-file', { sessionId, messageId, filePath })
    } catch (err) {
      console.error('拒绝文件改动出错:', err)
    }
  },

  // ── 主进程流式事件响应器 ────────────────────────────────────

  handleMessageStart: (messageId: string) => {
    const { currentSessionId } = get()
    const activeSessionId = currentSessionId || 'session_default'

    // 收到 Assistant 消息开始，向消息队列追加一个空的 assistant 卡片
    const assistantMsg: ExtendedMessage = {
      id: messageId,
      sessionId: activeSessionId,
      role: 'assistant',
      content: '',
      toolCalls: [],
      timestamp: Date.now()
    }

    set(state => ({
      messages: [...state.messages, assistantMsg],
      currentGeneratingMessageId: messageId
    }))
  },

  handleTextDelta: (messageId: string, delta: string) => {
    set(state => ({
      messages: state.messages.map(msg => 
        msg.id === messageId ? { ...msg, content: msg.content + delta } : msg
      )
    }))
  },

  handleToolCall: (messageId: string, toolCallId: string, toolName: string, args: Record<string, unknown>) => {
    // 插入一个新的 ExtendedToolCall，状态为 'running'
    const newToolCall: ExtendedToolCall = {
      id: toolCallId,
      name: toolName,
      arguments: args,
      status: 'running'
    }

    set(state => ({
      messages: state.messages.map(msg => {
        if (msg.id === messageId) {
          const toolCalls = msg.toolCalls ? [...msg.toolCalls, newToolCall] : [newToolCall]
          return { ...msg, toolCalls }
        }
        return msg
      })
    }))
  },

  handleToolResult: (messageId: string, toolCallId: string, toolName: string, result: string) => {
    // 通过 toolCallId 精确匹配工具调用记录，更新其执行结果与状态
    set(state => ({
      messages: state.messages.map(msg => {
        if (msg.id === messageId && msg.toolCalls) {
          const toolCalls = msg.toolCalls.map(tc => {
            if (tc.id === toolCallId) {
              const isError = result.startsWith('工具执行失败') || result.startsWith('权限拒绝:')
              return {
                ...tc,
                result,
                status: isError ? ('error' as const) : ('success' as const)
              }
            }
            return tc
          })
          return { ...msg, toolCalls }
        }
        return msg
      })
    }))
  },

  handleMessageEnd: (messageId: string) => {
    set({
      isGenerating: false,
      currentGeneratingMessageId: null,
      pendingPermissionRequest: null,
      isSubmittingPermission: false,
      permissionError: null
    })

    // 更新当前会话的消息数属性
    const { currentSessionId, sessions, messages } = get()
    if (currentSessionId) {
      set({
        sessions: sessions.map(s => 
          s.id === currentSessionId ? { ...s, messageCount: messages.length, updatedAt: Date.now() } : s
        )
      })
    }
  },

  handleError: (messageId: string, error: string) => {
    const { currentSessionId } = get()
    const activeSessionId = currentSessionId || 'session_default'

    // 发生异常时，向队列追加一条明显的错误卡片，并标记 isError = true
    const errorMsg: ExtendedMessage = {
      id: messageId,
      sessionId: activeSessionId,
      role: 'assistant',
      content: error,
      isError: true,
      timestamp: Date.now()
    }

    set(state => ({
      messages: [...state.messages, errorMsg],
      isGenerating: false,
      currentGeneratingMessageId: null,
      pendingPermissionRequest: null,
      isSubmittingPermission: false,
      permissionError: null
    }))
  },

  handlePermissionRequest: (request: PendingPermissionRequest) => {
    set({
      pendingPermissionRequest: request,
      isSubmittingPermission: false,
      permissionError: null
    })
  },

  respondPermissionRequest: async (decision: PermissionDecision) => {
    const { pendingPermissionRequest } = get()
    if (!pendingPermissionRequest) return

    set({ isSubmittingPermission: true, permissionError: null })

    try {
      await window.api.invoke('respond-permission', {
        requestId: pendingPermissionRequest.requestId,
        decision
      })
      set({
        pendingPermissionRequest: null,
        isSubmittingPermission: false,
        permissionError: null
      })
    } catch (err) {
      set({
        isSubmittingPermission: false,
        permissionError: err instanceof Error ? err.message : '提交权限决策失败'
      })
    }
  }
}))
