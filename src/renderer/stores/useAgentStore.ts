/**
 * useAgentStore — Agent 运行时状态、权限、取消
 *
 * 负责：
 * - 权限请求与提交状态
 * - 验证权限请求
 * - 取消执行（cancelExecution）
 *
 * 依赖方向：
 * - useAgentStore → useChatStore（取消时需要把 running 工具标记为 error）
 * - 不被 useChatStore 内部状态依赖
 */
import { create } from 'zustand'
import type { PermissionDecision } from '../../shared/session/types'
import type { PendingPermissionRequest, PendingVerificationRequest } from './types'
import type { AskQuestionRequest, AskQuestionAnswer } from '../../shared/askQuestion/types'

export interface AgentState {
  // ── 状态 ──
  pendingPermissionRequest: PendingPermissionRequest | null
  isSubmittingPermission: boolean
  permissionError: string | null
  pendingVerificationRequest: PendingVerificationRequest | null
  /** askQuestion 工具发起的提问请求；为空时面板不渲染 */
  pendingAskQuestion: AskQuestionRequest | null
  /**
   * 主进程当前进行中轮次所属的会话 id（agent:turn-state 广播）。
   * 与 chat store 的 isGenerating 不同：它是跨会话的全局事实，
   * 切会话不会被重置，用于「另一个会话正在运行」提示与跨会话停止入口。
   */
  mainTurnSessionId: string | null

  // ── Actions ──
  /**
   * Phase 3：中断当前的流式生成。
   * - 只发 IPC 信号，不在本地擦 messages 状态
   * - 主进程 cancel → AgentLoop 中断 → 最终发送 message_end(interrupted: true)
   * - 前端通过 useChatStore.handleMessageEnd 收到 interrupted 事件，标记消息
   * - 本地立即清空 pendingPermissionRequest，避免弹窗卡死
   * - 5 秒兜底超时：主进程未响应时强制恢复 isGenerating = false
   */
  cancelExecution: () => Promise<void>

  /**
   * 清除 5s 兜底定时器。由 useChatStore.handleMessageEnd / markRunningAsCancelled 在
   * 正常完成路径上调用，避免空跑定时器。
   */
  clearCancelFallback: () => void

  /** 收到主进程权限请求 */
  handlePermissionRequest: (request: PendingPermissionRequest) => void
  /** 用户回应权限请求 */
  respondPermissionRequest: (decision: PermissionDecision) => Promise<void>

  /** 收到验证权限请求 */
  handleVerificationPermissionRequest: (request: PendingVerificationRequest) => void
  /** 清除验证权限请求（用户回应、超时或取消后） */
  clearVerificationPermissionRequest: (requestId: string) => void
  /** 用户回应验证权限请求 */
  respondVerificationPermission: (granted: boolean) => void

  /** 收到 askQuestion 工具请求，写入 pendingAskQuestion 触发面板渲染 */
  handleAskQuestionRequest: (request: AskQuestionRequest) => void
  /** 主进程 resolved（用户已回答 / dismissed / 新消息 guardFollowup / cancel）后清除前端状态。
   *  仅当 requestId 匹配时清空，避免清错新请求 */
  clearAskQuestionRequest: (requestId: string) => void
  /** 用户提交答案：先清空 state 防重复提交，再 invoke IPC 让主进程 resolve 工具 Promise */
  respondAskQuestion: (answers: AskQuestionAnswer[]) => Promise<void>
  /** 用户点击跳过全部：invoke 传空数组，工具 formatAnswers 输出 dismissed */
  dismissAskQuestion: () => Promise<void>

  /** 主进程 agent:turn-state 广播：同步全局轮次归属 */
  handleTurnState: (inProgress: boolean, sessionId: string | null) => void

  /** 切换会话 / 取消时统一清空所有挂起权限（被 useChatStore 调用） */
  resetAgentRuntime: () => void
}

/** Phase 3 兜底超时：主进程未在此时长内推 message-end 时强制恢复 */
const CANCEL_FALLBACK_TIMEOUT_MS = 5_000

// 兜底定时器句柄。模块级变量，确保同一时刻只有一个待触发定时器。
// 收到 message-end 正常完成（markRunningAsCancelled）后立即 clearTimeout，
// 避免定时器空跑 5s 浪费资源。
let cancelFallbackTimer: ReturnType<typeof setTimeout> | null = null

function clearCancelFallbackTimer(): void {
  if (cancelFallbackTimer !== null) {
    clearTimeout(cancelFallbackTimer)
    cancelFallbackTimer = null
  }
}

export const useAgentStore = create<AgentState>((set, get) => ({
  pendingPermissionRequest: null,
  isSubmittingPermission: false,
  permissionError: null,
  pendingVerificationRequest: null,
  pendingAskQuestion: null,
  mainTurnSessionId: null,

  cancelExecution: async () => {
    try {
      // 记录取消时刻的 currentGeneratingMessageId 与时间戳，
      // 5s 兜底定时器触发时只有当"还没开始新消息"才真正 markRunningAsCancelled，
      // 避免误杀正常的下一轮生成。
      const { useChatStore } = await import('./useChatStore')
      const chatAtCancel = useChatStore.getState()
      const cancelledMessageId = chatAtCancel.currentGeneratingMessageId

      // 边界：cancelledMessageId 为 null 表示当前没有正在生成的消息（双击取消按钮、刷新后立即点击等）。
      // 此时没必要启动兜底定时器，只发 IPC 信号即可。
      if (!cancelledMessageId) {
        // 本地仍清空弹窗相关状态
        set({
          pendingPermissionRequest: null,
          isSubmittingPermission: false,
          permissionError: null
        })
        await window.api.invoke('cancel-execution')
        return
      }

      // 替换可能存在的旧定时器（防双击）：先 clear 再 setTimeout
      clearCancelFallbackTimer()

      // 本地立即清空弹窗相关状态，避免用户卡在已取消的弹窗上
      set({
        pendingPermissionRequest: null,
        isSubmittingPermission: false,
        permissionError: null
      })

      // 发起 IPC 取消信号
      await window.api.invoke('cancel-execution')

      // 兜底超时：主进程在 5s 内未推 message-end（极端卡死场景），
      // 强制把 chat store 的 isGenerating 复位，避免 UI 永远卡在生成中。
      // 重要：触发时必须检查"当前正在生成的消息"是否还是取消时的那条。
      // 如果主进程已正常推 message-end 并触发 dispatchNextPending 发了新消息，
      // 此时 isGenerating=true 但 currentGeneratingMessageId 已不是 cancelledMessageId，
      // 不能误杀新消息。
      cancelFallbackTimer = setTimeout(() => {
        cancelFallbackTimer = null
        const chat = useChatStore.getState()
        const isStillSameTurn =
          chat.isGenerating &&
          chat.currentGeneratingMessageId === cancelledMessageId
        if (isStillSameTurn) {
          console.warn('[cancelExecution] 兜底超时触发，强制复位 isGenerating')
          chat.markRunningAsCancelled()
        }
      }, CANCEL_FALLBACK_TIMEOUT_MS)
    } catch (err) {
      console.error('取消执行失败:', err)
    }
  },

  /**
   * 清除兜底定时器。由 useChatStore.handleMessageEnd / markRunningAsCancelled 调用，
   * 表示主进程已正常完成，取消流程不再需要兜底。
   */
  clearCancelFallback: () => {
    clearCancelFallbackTimer()
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

  handleVerificationPermissionRequest: (request: PendingVerificationRequest) => {
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
  },

  handleAskQuestionRequest: (request: AskQuestionRequest) => {
    set({ pendingAskQuestion: request })
  },

  clearAskQuestionRequest: (requestId: string) => {
    const current = get().pendingAskQuestion
    if (current?.requestId === requestId) {
      set({ pendingAskQuestion: null })
    }
  },

  respondAskQuestion: async (answers: AskQuestionAnswer[]) => {
    const pending = get().pendingAskQuestion
    if (!pending) return
    // 先清空 state，避免用户连点导致重复提交
    set({ pendingAskQuestion: null })
    await window.api.invoke('respond-ask-question', {
      requestId: pending.requestId,
      answers
    })
  },

  dismissAskQuestion: async () => {
    const pending = get().pendingAskQuestion
    if (!pending) return
    set({ pendingAskQuestion: null })
    await window.api.invoke('respond-ask-question', {
      requestId: pending.requestId,
      answers: []
    })
  },

  handleTurnState: (inProgress, sessionId) => {
    set({ mainTurnSessionId: inProgress ? sessionId : null })
  },

  resetAgentRuntime: () => {
    // 注意：不清 mainTurnSessionId——它是主进程广播的全局事实，与会话切换无关
    set({
      pendingPermissionRequest: null,
      isSubmittingPermission: false,
      permissionError: null,
      pendingVerificationRequest: null,
      pendingAskQuestion: null
    })
  }
}))

/** 重置整个 agent store 到默认值。供测试 setup 复用。 */
export function resetAgentStoreForTests(): void {
  useAgentStore.setState({
    pendingPermissionRequest: null,
    isSubmittingPermission: false,
    permissionError: null,
    pendingVerificationRequest: null,
    pendingAskQuestion: null,
    mainTurnSessionId: null
  })
}
