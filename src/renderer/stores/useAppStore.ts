import { create } from 'zustand'
import type { Mode, PermissionDecision, Session, SessionDetail, ToolCall, Message, MessageBlock, ThinkingBlock, TextBlock, ToolBlock } from '../../shared/session/types'
import type { ModelConfig } from '../../shared/config'
import type { DiffEntry, DiffReviewStatus } from '../../shared/diff/types'
import type { NormalizedUsage } from '../../runtime/model/types'
import { inferContextWindow } from '../../shared/config/types'
import { parsePartialToolArgs } from '../features/chat/partialJsonArgs'

/**
 * 扩展的工具调用接口
 * 提供在 UI 渲染时跟踪工具执行状态和返回结果的能力
 * argumentsRaw 仅在流式增量阶段有值，final tool_call 到达后移除
 */
export interface ExtendedToolCall extends ToolCall {
  result?: string
  status: 'running' | 'success' | 'error'
  argumentsRaw?: string
}

/**
 * 渲染器专用 ToolBlock：在流式增量阶段携带 argumentsRaw（原始 JSON 字符串）
 * argumentsRaw 只在流式期间存在，tool_call 最终事件到达后移除。
 * 此类型仅在 renderer 内部使用，不污染 shared/session/types.ts。
 */
export type RendererToolBlock = ToolBlock & { argumentsRaw?: string }

/** 渲染器专用顺序消息块类型，ToolBlock 使用携带 argumentsRaw 的扩展版本 */
export type RendererMessageBlock = ThinkingBlock | TextBlock | RendererToolBlock

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
  thinking?: string
  /** 顺序块数组，按流式事件顺序排列，ToolBlock 使用 renderer 扩展类型携带 argumentsRaw */
  blocks?: RendererMessageBlock[]
  /** 验证结果摘要（修改后自动验证的结果） */
  verificationSummary?: string
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
type MessageDiffCache = {
  diffs: DiffEntry[]
  reviews: Record<string, DiffReviewStatus>
}

/** 会话级 token 用量聚合统计 */
export interface SessionUsageStats {
  totalPromptTokens: number
  totalCompletionTokens: number
  totalCachedTokens: number
  /** 缓存写入总量（cache_write_tokens 累计） */
  totalCacheWriteTokens: number
  /** 缓存命中率 = totalCachedTokens / totalPromptTokens */
  hitRate: number
}

function getToolCallStatus(result?: string): ExtendedToolCall['status'] {
  if (!result) return 'success'
  return result.startsWith('工具执行失败') || result.startsWith('权限拒绝:')
    ? 'error'
    : 'success'
}

/** 旧会话兼容路径：正文只保留用户可见文本，不把历史 think 标签重新展示出来 */
function stripLegacyThinkingTags(content: string): string {
  return content.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/<think>[\s\S]*$/g, '')
}

function restoreSessionMessages(messages: SessionDetail['messages']): ExtendedMessage[] {
  return messages.map((message) => {
    const payload = message as SessionMessagePayload
    const results = payload._toolCallResults ?? {}
    const sanitizedContent = stripLegacyThinkingTags(message.content)

    const toolCalls = message.toolCalls?.map((toolCall) => {
      const result = results[toolCall.id]
      return {
        id: toolCall.id,
        name: toolCall.name,
        arguments: toolCall.arguments,
        status: getToolCallStatus(result),
        result
      }
    })

    // 如果消息已有 blocks（从持久化加载），直接使用
    if (message.blocks && message.blocks.length > 0) {
      return { ...message, content: sanitizedContent, toolCalls }
    }

    // 旧消息无 blocks：从 content 和 toolCalls 构造
    const blocks: MessageBlock[] = []
    if (sanitizedContent) {
      blocks.push({ type: 'text', content: sanitizedContent })
    }
    if (toolCalls) {
      for (const tc of toolCalls) {
        blocks.push({
          type: 'tool',
          toolCallId: tc.id,
          toolName: tc.name,
          arguments: tc.arguments,
          status: tc.status,
          result: tc.result
        })
      }
    }

    return { ...message, content: sanitizedContent, toolCalls, blocks }
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

function applyDiffReviewStatus(
  cache: MessageDiffCache,
  filePath: string,
  status: DiffReviewStatus
): MessageDiffCache {
  const existingDiff = cache.diffs.find(diff => diff.filePath === filePath)
  const nextDiffs = existingDiff
    ? cache.diffs
    : [...cache.diffs, { filePath, hunks: [], status: 'modified' as const }]

  return {
    diffs: nextDiffs,
    reviews: { ...cache.reviews, [filePath]: status }
  }
}

/** 根据 messages 数组构建 id → index 索引，加速 delta 更新时按 id 定位 */
function buildMessageIndex(messages: ExtendedMessage[]): Record<string, number> {
  const index: Record<string, number> = {}
  for (let i = 0; i < messages.length; i++) {
    index[messages[i].id] = i
  }
  return index
}

/** Zustand 全局状态定义 */
interface AppState {
  currentProject: string | null
  currentMode: Mode
  sessions: Session[]
  currentSessionId: string | null
  messages: ExtendedMessage[]
  /** id → 数组索引，用于 delta 处理时 O(1) 定位消息，避免全量 .map() */
  messageIndexById: Record<string, number>
  isGenerating: boolean
  currentGeneratingMessageId: string | null
  modelConfig: ModelConfig | null
  isConfigModalOpen: boolean
  pendingPermissionRequest: PendingPermissionRequest | null
  isSubmittingPermission: boolean
  permissionError: string | null
  /** 验证权限请求（用户确认是否执行验证命令） */
  pendingVerificationRequest: { requestId: string; command: string } | null

  /**
   * 流式工具调用参数累积：toolCallId → 已累积的原始 arguments 字符串。
   * start 时初始化为空字符串，delta 追加片段，最终 tool_call 事件到达后清空对应条目。
   */
  streamingToolArgs: Record<string, string>

  /** 每条消息的 diff 数据缓存 */
  messageDiffs: Record<string, MessageDiffCache>
  /** 正在加载 diff 的消息 ID 集合 */
  loadingDiffs: Set<string>
  /**
   * live 阶段的占位文件列表，仅在等待最终 diff 数据时使用。
   * 让 DiffViewer 在 skeleton 状态下也能展示文件名，给用户更明确的反馈。
   */
  loadingDiffPlaceholders: Record<string, Array<{ filePath: string; status: DiffEntry['status'] }>>

  /** 当前会话的 token 用量聚合统计 */
  sessionUsage: SessionUsageStats | null
  /** 模型上下文窗口上限（tokens），用于前端显示上下文占用指示器 */
  contextLimit: number

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

  /** 删除会话 */
  deleteSession: (sessionId: string) => Promise<void>

  /** 创建新会话 */
  createNewSession: (workspaceRoot?: string) => Promise<void>

  /** 按消息回退到某条消息之前的状态 */
  rollbackMessage: (sessionId: string, messageId: string) => Promise<void>

  /** 按文件拒绝某个文件的改动 */
  rejectFile: (sessionId: string, messageId: string, filePath: string) => Promise<void>

  /** 按需加载某条消息的 diff 数据 */
  loadMessageDiffs: (sessionId: string, messageId: string) => Promise<void>

  /** 接受文件改动：标记为已审查 */
  acceptFile: (sessionId: string, messageId: string, filePath: string) => Promise<void>

  /** 清除指定消息的 diff 缓存（拒绝后刷新用） */
  clearMessageDiffs: (messageId: string) => void

  // ── 主进程事件驱动的状态更新 ──────────────────────────────
  
  handleMessageStart: (messageId: string) => void
  handleThinkingDelta: (messageId: string, delta: string) => void
  handleTextDelta: (messageId: string, delta: string) => void
  handleToolCall: (messageId: string, toolCallId: string, toolName: string, args: Record<string, unknown>) => void

  /** 流式工具调用开始：创建 running 占位卡片 + 初始化 streamingToolArgs */
  handleToolCallStart: (messageId: string, toolCallId: string, toolName: string) => void

  /** 流式工具调用参数增量：追加 argumentsRaw 到 streamingToolArgs + 更新 block */
  handleToolCallDelta: (messageId: string, toolCallId: string, argumentsDelta: string) => void
  handleToolResult: (messageId: string, toolCallId: string, toolName: string, result: string) => void
  handleDiffUpdate: (
    messageId: string,
    phase: 'live' | 'final',
    diffs: Array<{ filePath: string; status: DiffEntry['status']; hunks?: DiffEntry['hunks'] }>,
    reviews: Record<string, DiffReviewStatus>
  ) => void
  handleMessageEnd: (messageId: string) => void
  handleUsage: (usage: NormalizedUsage) => void
  handleError: (messageId: string, error: string) => void
  handleVerificationResult: (messageId: string, result: string) => void
  handlePermissionRequest: (request: PendingPermissionRequest) => void
  respondPermissionRequest: (decision: PermissionDecision) => Promise<void>
  /** 收到验证权限请求 */
  handleVerificationPermissionRequest: (request: { requestId: string; command: string }) => void
  /** 清除验证权限请求（用户回应、超时或取消后） */
  clearVerificationPermissionRequest: (requestId: string) => void
  /** 用户回应验证权限请求 */
  respondVerificationPermission: (granted: boolean) => void
}

export const useAppStore = create<AppState>((set, get) => ({
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
  pendingVerificationRequest: null,
  messageDiffs: {},
  loadingDiffs: new Set(),
  loadingDiffPlaceholders: {},
  streamingToolArgs: {},
  sessionUsage: null,
  contextLimit: 200_000,

  selectProject: async () => {
    try {
      const selectedPath = await window.api.invoke('select-project')
      if (selectedPath) {
        // 通过 IPC 创建后端管理的真实会话
        const sessionDetail: SessionDetail = await window.api.invoke('create-session', {
          workspaceRoot: selectedPath,
          mode: get().currentMode
        })

        const restored = restoreSessionMessages(sessionDetail.messages)
        set(state => ({
          currentProject: selectedPath,
          currentSessionId: sessionDetail.id,
          currentMode: sessionDetail.mode,
          sessions: upsertSessionSummary(state.sessions, sessionDetail),
          messages: restored,
          messageIndexById: buildMessageIndex(restored),
          pendingVerificationRequest: null
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

    set(state => {
      const nextMessages = [...state.messages, userMsg]
      return {
        messages: nextMessages,
        messageIndexById: { ...state.messageIndexById, [userMsg.id]: nextMessages.length - 1 },
        isGenerating: true
      }
    })

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
      set(state => {
        // 兜底：将所有 running 状态的 tool 块和 toolCall 条目标记为 error
        const nextMessages = state.messages.map(msg => {
          if (!msg.blocks && !msg.toolCalls) return msg
          let changed = false

          const blocks = msg.blocks?.map(b => {
            if (b.type === 'tool' && b.status === 'running') {
              changed = true
              const { argumentsRaw: _drop, ...restBlock } = b as RendererToolBlock
              return { ...restBlock, type: 'tool' as const, status: 'error' as const, result: '用户取消执行' }
            }
            return b
          })

          const toolCalls = msg.toolCalls?.map(tc => {
            if (tc.status === 'running') {
              changed = true
              const { argumentsRaw: _tcDrop, ...restTc } = tc
              return { ...restTc, status: 'error' as const, result: '用户取消执行' }
            }
            return tc
          })

          return changed ? { ...msg, blocks, toolCalls } : msg
        })

        return {
          messages: nextMessages,
          isGenerating: false,
          currentGeneratingMessageId: null,
          pendingPermissionRequest: null,
          pendingVerificationRequest: null,
          isSubmittingPermission: false,
          permissionError: null,
          streamingToolArgs: {}
        }
      })
    } catch (err) {
      console.error('取消执行失败:', err)
    }
  },

  loadModelConfig: async () => {
    try {
      const config = await window.api.invoke('load-model-config')
      set({
        modelConfig: config,
        contextLimit: config?.contextWindow ?? inferContextWindow(config?.modelId ?? '')
      })
    } catch (err) {
      console.error('读取模型配置失败:', err)
    }
  },

  saveModelConfig: async (config: ModelConfig) => {
    try {
      await window.api.invoke('save-model-config', config)
      set({
        modelConfig: config,
        isConfigModalOpen: false,
        contextLimit: config.contextWindow ?? inferContextWindow(config.modelId)
      })
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

  deleteSession: async (sessionId: string) => {
    try {
      await window.api.invoke('delete-session', { sessionId })
      const { currentSessionId, sessions } = get()
      const nextSessions = sessions.filter(s => s.id !== sessionId)
      set({ sessions: nextSessions })

      // 如果删除的是当前会话，需要切走
      if (currentSessionId === sessionId) {
        if (nextSessions.length > 0) {
          await get().selectSession(nextSessions[0].id)
        } else {
          set({
            currentSessionId: null,
            currentProject: null,
            messages: [],
            messageIndexById: {},
            pendingVerificationRequest: null
          })
        }
      }
    } catch (err) {
      console.error('删除会话出错:', err)
    }
  },

  createNewSession: async (workspaceRoot?: string) => {
    const { currentProject, currentMode } = get()
    const targetProject = workspaceRoot || currentProject
    if (!targetProject) return
    try {
      const sessionDetail: SessionDetail = await window.api.invoke('create-session', {
        workspaceRoot: targetProject,
        mode: currentMode
      })
      const restored = restoreSessionMessages(sessionDetail.messages)
      set(state => ({
        currentSessionId: sessionDetail.id,
        currentProject: targetProject,
        sessions: upsertSessionSummary(state.sessions, sessionDetail),
        messages: restored,
        messageIndexById: buildMessageIndex(restored),
        pendingVerificationRequest: null
      }))
    } catch (err) {
      console.error('创建新会话失败:', err)
    }
  },

  selectSession: async (sessionId: string) => {
    try {
      const detail: SessionDetail = await window.api.invoke('load-session', { sessionId })
      const restored = restoreSessionMessages(detail.messages)
      set({
        currentSessionId: sessionId,
        currentProject: detail.workspaceRoot,
        currentMode: detail.mode,
        sessions: upsertSessionSummary(get().sessions, detail),
        messages: restored,
        messageIndexById: buildMessageIndex(restored),
        messageDiffs: {}, // 切换会话时清空 diff 缓存
        pendingVerificationRequest: null,
        sessionUsage: null
      })

      // 为所有 assistant 消息异步加载 diff 数据
      for (const msg of restored) {
        if (msg.role === 'assistant') {
          get().loadMessageDiffs(sessionId, msg.id)
        }
      }
    } catch (err) {
      console.error('加载会话详情出错:', err)
    }
  },

  rollbackMessage: async (sessionId: string, messageId: string) => {
    try {
      await window.api.invoke('rollback-message', { sessionId, messageId })
      // 回退成功后重新加载会话数据
      const detail: SessionDetail = await window.api.invoke('load-session', { sessionId })
      const restored = restoreSessionMessages(detail.messages)
      set({
        currentProject: detail.workspaceRoot,
        currentMode: detail.mode,
        sessions: upsertSessionSummary(get().sessions, detail),
        messages: restored,
        messageIndexById: buildMessageIndex(restored),
        pendingVerificationRequest: null
      })
    } catch (err) {
      console.error('回退消息出错:', err)
    }
  },

  rejectFile: async (sessionId: string, messageId: string, filePath: string) => {
    try {
      await window.api.invoke('reject-file', { sessionId, messageId, filePath })
      const cache = get().messageDiffs[messageId]
      if (cache) {
        set(state => ({
          messageDiffs: {
            ...state.messageDiffs,
            [messageId]: applyDiffReviewStatus(cache, filePath, 'rejected')
          }
        }))
      }
    } catch (err) {
      console.error('拒绝文件改动出错:', err)
      throw err
    }
  },

  loadMessageDiffs: async (sessionId: string, messageId: string) => {
    // 注意：loadingDiffs 中的 messageId 既可能来自 live 占位，也可能来自上一次未完成的 final 请求。
    // 这里仅在「已存在缓存」或「已有进行中的 final 请求」时跳过；live 占位不阻断真实加载。
    const state = get()
    if (state.messageDiffs[messageId]) return

    set(s => ({
      loadingDiffs: new Set([...s.loadingDiffs, messageId])
    }))

    try {
      const result = await window.api.invoke('get-message-diffs', { sessionId, messageId })
      set(s => {
        const nextLoading = new Set(s.loadingDiffs)
        nextLoading.delete(messageId)
        const { [messageId]: _, ...nextPlaceholders } = s.loadingDiffPlaceholders
        return {
          messageDiffs: { ...s.messageDiffs, [messageId]: { diffs: result.diffs, reviews: result.reviews } },
          loadingDiffs: nextLoading,
          loadingDiffPlaceholders: nextPlaceholders
        }
      })
    } catch (err) {
      console.error('加载 diff 出错:', err)
      set(s => {
        const nextLoading = new Set(s.loadingDiffs)
        nextLoading.delete(messageId)
        return { loadingDiffs: nextLoading }
      })
    }
  },

  acceptFile: async (sessionId: string, messageId: string, filePath: string) => {
    try {
      await window.api.invoke('accept-file', { sessionId, messageId, filePath })
      const cache = get().messageDiffs[messageId]
      if (cache) {
        set(state => ({
          messageDiffs: {
            ...state.messageDiffs,
            [messageId]: applyDiffReviewStatus(cache, filePath, 'accepted')
          }
        }))
      }
    } catch (err) {
      console.error('接受文件出错:', err)
      throw err
    }
  },

  clearMessageDiffs: (messageId: string) => {
    set(state => {
      const { [messageId]: _, ...rest } = state.messageDiffs
      return { messageDiffs: rest }
    })
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
      timestamp: Date.now(),
      thinking: '',
      blocks: []
    }

    set(state => {
      const nextMessages = [...state.messages, assistantMsg]
      return {
        messages: nextMessages,
        messageIndexById: { ...state.messageIndexById, [messageId]: nextMessages.length - 1 },
        currentGeneratingMessageId: messageId
      }
    })
  },

  handleThinkingDelta: (messageId: string, delta: string) => {
    set(state => {
      const idx = state.messageIndexById[messageId]
      if (idx === undefined) return state
      const msg = state.messages[idx]
      if (!msg) return state
      const blocks = msg.blocks ? [...msg.blocks] : []
      const last = blocks[blocks.length - 1]
      if (last && last.type === 'thinking') {
        blocks[blocks.length - 1] = { ...last, content: last.content + delta }
      } else {
        blocks.push({ type: 'thinking', content: delta })
      }
      const nextMessages = state.messages.slice()
      nextMessages[idx] = { ...msg, thinking: (msg.thinking ?? '') + delta, blocks }
      return { messages: nextMessages }
    })
  },

  handleTextDelta: (messageId: string, delta: string) => {
    set(state => {
      const idx = state.messageIndexById[messageId]
      if (idx === undefined) return state
      const msg = state.messages[idx]
      if (!msg) return state
      const blocks = msg.blocks ? [...msg.blocks] : []
      const last = blocks[blocks.length - 1]
      if (last && last.type === 'text') {
        blocks[blocks.length - 1] = { ...last, content: last.content + delta }
      } else {
        blocks.push({ type: 'text', content: delta })
      }
      const nextMessages = state.messages.slice()
      nextMessages[idx] = { ...msg, content: msg.content + delta, blocks }
      return { messages: nextMessages }
    })
  },

  handleToolCall: (messageId: string, toolCallId: string, toolName: string, args: Record<string, unknown>) => {
    const newToolCall: ExtendedToolCall = {
      id: toolCallId,
      name: toolName,
      arguments: args,
      status: 'running'
    }

    set(state => {
      const idx = state.messageIndexById[messageId]
      if (idx === undefined) return state
      const msg = state.messages[idx]
      if (!msg) return state

      // 查找是否已有 start 创建的占位 block（流式增量场景）
      const blocks = msg.blocks ? [...msg.blocks] : []
      const existingBlockIdx = blocks.findIndex(
        b => b.type === 'tool' && b.toolCallId === toolCallId
      )

      if (existingBlockIdx !== -1) {
        // 已有占位 block：用最终 args 和 toolName 覆盖，解构剔除 argumentsRaw
        const existing = blocks[existingBlockIdx]
        if (existing.type === 'tool') {
          const { argumentsRaw: _drop, ...restBlock } = existing as RendererToolBlock
          blocks[existingBlockIdx] = {
            ...restBlock,
            type: 'tool',
            toolCallId,
            toolName,
            arguments: args,
            status: 'running'
          }
        }
      } else {
        // 无占位 block（向后兼容：未收到 start 事件时直接创建）
        blocks.push({
          type: 'tool',
          toolCallId,
          toolName,
          arguments: args,
          status: 'running'
        })
      }

      // 同步更新 toolCalls 数组：查找并更新或追加，解构剔除 argumentsRaw
      const toolCalls = msg.toolCalls ? [...msg.toolCalls] : []
      const tcIdx = toolCalls.findIndex(tc => tc.id === toolCallId)
      if (tcIdx !== -1) {
        const { argumentsRaw: _tcDrop, ...restTc } = toolCalls[tcIdx]
        toolCalls[tcIdx] = { ...restTc, name: toolName, arguments: args }
      } else {
        toolCalls.push(newToolCall)
      }

      const nextMessages = state.messages.slice()
      nextMessages[idx] = { ...msg, toolCalls, blocks }

      // 清空该 toolCallId 的流式增量累积
      const { [toolCallId]: _, ...restStreaming } = state.streamingToolArgs
      return { messages: nextMessages, streamingToolArgs: restStreaming }
    })
  },

  handleToolCallStart: (messageId: string, toolCallId: string, toolName: string) => {
    const placeholder: ExtendedToolCall = {
      id: toolCallId,
      name: toolName,
      arguments: {},
      status: 'running'
    }

    set(state => {
      const idx = state.messageIndexById[messageId]
      if (idx === undefined) return state
      const msg = state.messages[idx]
      if (!msg) return state

      // 创建 running 占位 block，携带空的 argumentsRaw
      const blocks: RendererMessageBlock[] = msg.blocks ? [...msg.blocks] : []
      blocks.push({
        type: 'tool',
        toolCallId,
        toolName,
        arguments: {},
        status: 'running',
        argumentsRaw: ''
      })

      const toolCalls = msg.toolCalls ? [...msg.toolCalls, placeholder] : [placeholder]
      const nextMessages = state.messages.slice()
      nextMessages[idx] = { ...msg, toolCalls, blocks }

      // 初始化流式增量累积
      return {
        messages: nextMessages,
        streamingToolArgs: { ...state.streamingToolArgs, [toolCallId]: '' }
      }
    })
  },

  handleToolCallDelta: (messageId: string, toolCallId: string, argumentsDelta: string) => {
    set(state => {
      const idx = state.messageIndexById[messageId]
      if (idx === undefined) return state
      const msg = state.messages[idx]
      if (!msg) return state

      // 累积 argumentsRaw 到 streamingToolArgs
      const prevRaw = state.streamingToolArgs[toolCallId] ?? ''
      const nextRaw = prevRaw + argumentsDelta

      // 从已有 block/toolCall 获取 toolName，用于派发 partial 解析
      const existingBlock = msg.blocks?.find(
        b => b.type === 'tool' && b.toolCallId === toolCallId
      )
      const toolName = existingBlock?.type === 'tool' ? existingBlock.toolName : ''
      const partialArgs = parsePartialToolArgs(toolName, nextRaw)

      // 同步更新 block 的 argumentsRaw 和 arguments
      const blocks: RendererMessageBlock[] = msg.blocks ? [...msg.blocks] : []
      const blockIdx = blocks.findIndex(
        b => b.type === 'tool' && b.toolCallId === toolCallId
      )
      if (blockIdx !== -1 && blocks[blockIdx].type === 'tool') {
        blocks[blockIdx] = {
          ...blocks[blockIdx],
          arguments: partialArgs,
          argumentsRaw: nextRaw
        } as RendererToolBlock
      }

      // 同步更新 toolCalls 数组的 arguments 和 argumentsRaw
      const toolCalls = msg.toolCalls ? msg.toolCalls.map(tc =>
        tc.id === toolCallId
          ? { ...tc, arguments: partialArgs, argumentsRaw: nextRaw }
          : tc
      ) : msg.toolCalls

      const nextMessages = state.messages.slice()
      nextMessages[idx] = { ...msg, blocks, toolCalls }

      return {
        messages: nextMessages,
        streamingToolArgs: { ...state.streamingToolArgs, [toolCallId]: nextRaw }
      }
    })
  },

  handleToolResult: (messageId: string, toolCallId: string, toolName: string, result: string) => {
    const isError = result.startsWith('工具执行失败') || result.startsWith('权限拒绝:')

    set(state => {
      const idx = state.messageIndexById[messageId]
      if (idx === undefined) return state
      const msg = state.messages[idx]
      if (!msg) return state

      // 更新 blocks 中的 tool 块
      const blocks = msg.blocks?.map(b => {
        if (b.type === 'tool' && b.toolCallId === toolCallId) {
          return { ...b, status: isError ? 'error' as const : 'success' as const, result }
        }
        return b
      })

      // 同步更新 toolCalls 数组
      const toolCalls = msg.toolCalls?.map(tc => {
        if (tc.id === toolCallId) {
          return { ...tc, result, status: isError ? 'error' as const : 'success' as const }
        }
        return tc
      })

      const nextMessages = state.messages.slice()
      nextMessages[idx] = { ...msg, blocks, toolCalls }
      return { messages: nextMessages }
    })
  },

  /**
   * 工具执行后实时点亮 diff 区域。
   *
   * phase === 'live'：占位信号。后端只发了文件名 + status，没有 hunks。
   *   此时不写 messageDiffs（否则 DiffViewer 会按空 hunks 渲染出 +0 -0 中间态），
   *   仅把 messageId 标记为正在加载，并把文件列表存到 placeholders 供 skeleton 展示，
   *   等到 message_end 后再拉取最终数据替换。
   *   竞态保护：如果 messageDiffs 已经被 final 写入，说明本条 live 是 setImmediate
   *   排队期间迟到的事件（message_end 先一步走完了 loadMessageDiffs），直接忽略，
   *   避免把真实数据压回骨架且没有后续 final 来清除。
   * phase === 'final'：完整数据。直接覆盖缓存并清除 loading 标记和 placeholders。
   */
  handleDiffUpdate: (messageId, phase, diffs, reviews) => {
    if (phase === 'live') {
      if (get().messageDiffs[messageId]) return
      const placeholders = diffs.map(d => ({ filePath: d.filePath, status: d.status }))
      set(state => ({
        loadingDiffs: new Set([...state.loadingDiffs, messageId]),
        loadingDiffPlaceholders: {
          ...state.loadingDiffPlaceholders,
          [messageId]: placeholders
        }
      }))
      return
    }

    const nextDiffs = diffs.map(diffMeta => ({
      filePath: diffMeta.filePath,
      status: diffMeta.status,
      hunks: diffMeta.hunks ?? []
    }))

    set(state => {
      const nextLoading = new Set(state.loadingDiffs)
      nextLoading.delete(messageId)
      const { [messageId]: _, ...nextPlaceholders } = state.loadingDiffPlaceholders
      return {
        messageDiffs: {
          ...state.messageDiffs,
          [messageId]: {
            diffs: nextDiffs,
            reviews
          }
        },
        loadingDiffs: nextLoading,
        loadingDiffPlaceholders: nextPlaceholders
      }
    })
  },

  handleMessageEnd: (messageId: string) => {
    set({
      isGenerating: false,
      currentGeneratingMessageId: null,
      pendingPermissionRequest: null,
      isSubmittingPermission: false,
      permissionError: null
    })

    // 更新当前会话的消息数属性，并自动加载 diff
    const { currentSessionId, sessions, messages } = get()
    if (currentSessionId) {
      get().loadMessageDiffs(currentSessionId, messageId)
      set({
        sessions: sessions.map(s =>
          s.id === currentSessionId ? { ...s, messageCount: messages.length, updatedAt: Date.now() } : s
        )
      })
    }
  },

  handleUsage: (usage: NormalizedUsage) => {
    set(state => {
      const prev = state.sessionUsage ?? {
        totalPromptTokens: 0,
        totalCompletionTokens: 0,
        totalCachedTokens: 0,
        totalCacheWriteTokens: 0,
        hitRate: 0
      }
      const totalPrompt = prev.totalPromptTokens + usage.promptTokens
      const totalCached = prev.totalCachedTokens + usage.cachedTokens
      const totalCacheWrite = prev.totalCacheWriteTokens + (usage.cacheWriteTokens ?? 0)
      return {
        sessionUsage: {
          totalPromptTokens: totalPrompt,
          totalCompletionTokens: prev.totalCompletionTokens + usage.completionTokens,
          totalCachedTokens: totalCached,
          totalCacheWriteTokens: totalCacheWrite,
          hitRate: totalPrompt > 0 ? totalCached / totalPrompt : 0
        }
      }
    })
  },

  handleVerificationResult: (messageId: string, result: string) => {
    set(state => {
      const idx = state.messageIndexById[messageId]
      if (idx === undefined) return state
      const msg = state.messages[idx]
      if (!msg) return state
      const nextMessages = state.messages.slice()
      nextMessages[idx] = { ...msg, verificationSummary: result }
      return { messages: nextMessages }
    })
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

    set(state => {
      const nextMessages = [...state.messages, errorMsg]
      return {
        messages: nextMessages,
        messageIndexById: { ...state.messageIndexById, [messageId]: nextMessages.length - 1 },
        isGenerating: false,
        currentGeneratingMessageId: null,
        pendingPermissionRequest: null,
        isSubmittingPermission: false,
        permissionError: null
      }
    })
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
  },

  handleVerificationPermissionRequest: (request: { requestId: string; command: string }) => {
    set({ pendingVerificationRequest: request })
  },

  clearVerificationPermissionRequest: (requestId: string) => {
    set(state => ({
      pendingVerificationRequest:
        state.pendingVerificationRequest?.requestId === requestId
          ? null
          : state.pendingVerificationRequest
    }))
  },

  respondVerificationPermission: (granted: boolean) => {
    const { pendingVerificationRequest } = get()
    if (!pendingVerificationRequest) return

    window.api.invoke('respond-verification-permission', {
      requestId: pendingVerificationRequest.requestId,
      granted
    })
    set({ pendingVerificationRequest: null })
  }
}))
