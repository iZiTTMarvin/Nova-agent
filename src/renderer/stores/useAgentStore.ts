/**
 * useAgentStore — Agent 运行时状态、权限、取消
 *
 * 负责：
 * - 权限请求与提交状态
 * - 验证权限请求
 * - 取消执行（cancelExecution）：由 RunCoordinator 确认终态，不再本地 5s 宣布结束
 *
 * 依赖方向：
 * - useAgentStore → useChatStore（取消时需要把 running 工具标记为 error）
 * - useAgentStore → useRunStore（cancelling / snapshot 终态）
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
  /** askQuestion 提交中（ACK 前不删 pending） */
  isSubmittingAskQuestion: boolean
  /**
   * 主进程当前进行中轮次所属的会话 id（由 run:snapshot → useRunStore 投影）。
   * 与 chat store 的 isGenerating 不同：它是跨会话的全局事实，
   * 切会话不会被重置，用于「另一个会话正在运行」提示与跨会话停止入口。
   */
  mainTurnSessionId: string | null

  // ── Actions ──
  /**
   * 中断当前流式生成。
   * - 立即进入 cancelling（按钮「正在停止」）
   * - 等 RunCoordinator snapshot 确认 terminal 后才 idle
   * - 超 grace 由 useRunStore 显示「部分任务未退出」+ 强制终止
   * - Renderer 不能独立宣布后台 run 已结束
   */
  cancelExecution: (runId?: string) => Promise<void>

  /**
   * 兼容旧 clearCancelFallback：现由 run snapshot 终态驱动，保留空实现避免调用方报错。
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
  /** 用户提交答案：ACK 前只置 submitting，不提前删 pending */
  respondAskQuestion: (answers: AskQuestionAnswer[]) => Promise<void>
  /** 用户点击跳过全部：invoke 传空数组，工具 formatAnswers 输出 dismissed */
  dismissAskQuestion: () => Promise<void>

  /** 由 useRunStore 根据 run:snapshot 投影全局轮次归属 */
  handleTurnState: (inProgress: boolean, sessionId: string | null) => void

  /**
   * 切换会话时清空本地 pending 投影。
   * snapshot-first 会在随后 pullSnapshot 中按新会话恢复；此处只清 UI，不宣布 run 结束。
   */
  resetAgentRuntime: () => void
}

function newCommandId(): string {
  return `cmd_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
}

export const useAgentStore = create<AgentState>((set, get) => ({
  pendingPermissionRequest: null,
  isSubmittingPermission: false,
  permissionError: null,
  pendingVerificationRequest: null,
  pendingAskQuestion: null,
  isSubmittingAskQuestion: false,
  mainTurnSessionId: null,

  cancelExecution: async (targetRunId?: string) => {
    try {
      const { useRunStore } = await import('./useRunStore')
      const runState = useRunStore.getState()
      // 停止按钮只针对当前选中会话的活动 run，不能误取消后台其他会话。
      const runId = targetRunId ??
        (runState.selectedSessionId
          ? runState.activeRunIdBySessionId[runState.selectedSessionId]
          : runState.snapshot?.runId)

      // 本地立即进入 cancelling，不清 isGenerating（等 snapshot 终态）
      useRunStore.getState().beginLocalCancel(runId ?? 'unknown')

      // 本地清空弹窗，避免卡在已取消的交互上
      set({
        pendingPermissionRequest: null,
        isSubmittingPermission: false,
        permissionError: null,
        pendingAskQuestion: null,
        isSubmittingAskQuestion: false
      })

      const result = runId
        ? await window.api.invoke('cancel-execution', { runId })
        : await window.api.invoke('cancel-execution')
      if (result?.runId) {
        useRunStore.getState().beginLocalCancel(result.runId)
      }
      // 不在此处复位 isGenerating——等 run:snapshot 终态或 force-terminate
    } catch (err) {
      console.error('取消执行失败:', err)
    }
  },

  clearCancelFallback: () => {
    // 旧 5s 兜底已移除；保留空实现兼容调用方
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

    const commandId = newCommandId()
    try {
      const result = await window.api.invoke('respond-permission', {
        requestId: pendingPermissionRequest.requestId,
        decision,
        commandId,
        expectedVersion: pendingPermissionRequest.version,
        interactionId: pendingPermissionRequest.interactionId ?? pendingPermissionRequest.requestId
      })

      // 新路径：根据 ACK 决定是否清除；旧路径 result 为 void 视为成功
      if (result && typeof result === 'object' && 'ok' in result && result.ok === false) {
        set({
          isSubmittingPermission: false,
          permissionError: result.message || '提交权限决策失败'
        })
        // 刷新 snapshot
        if (pendingPermissionRequest.sessionId) {
          const { useRunStore } = await import('./useRunStore')
          void useRunStore.getState().pullSnapshot(pendingPermissionRequest.sessionId)
        }
        return
      }

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
    set({ pendingAskQuestion: request, isSubmittingAskQuestion: false })
  },

  clearAskQuestionRequest: (requestId: string) => {
    const current = get().pendingAskQuestion
    if (current?.requestId === requestId) {
      set({ pendingAskQuestion: null, isSubmittingAskQuestion: false })
    }
  },

  respondAskQuestion: async (answers: AskQuestionAnswer[]) => {
    const pending = get().pendingAskQuestion
    if (!pending || get().isSubmittingAskQuestion) return
    // ACK 前只置 submitting，不提前删 pending
    set({ isSubmittingAskQuestion: true })
    const commandId = newCommandId()
    try {
      const result = await window.api.invoke('respond-ask-question', {
        requestId: pending.requestId,
        answers,
        commandId,
        expectedVersion: pending.version,
        interactionId: pending.interactionId ?? pending.requestId
      })
      if (result && typeof result === 'object' && 'ok' in result && result.ok === false) {
        set({ isSubmittingAskQuestion: false })
        if (pending.sessionId) {
          const { useRunStore } = await import('./useRunStore')
          void useRunStore.getState().pullSnapshot(pending.sessionId)
        }
        return
      }
      set({ pendingAskQuestion: null, isSubmittingAskQuestion: false })
    } catch (err) {
      console.error('respondAskQuestion 失败:', err)
      set({ isSubmittingAskQuestion: false })
    }
  },

  dismissAskQuestion: async () => {
    const pending = get().pendingAskQuestion
    if (!pending || get().isSubmittingAskQuestion) return
    set({ isSubmittingAskQuestion: true })
    const commandId = newCommandId()
    try {
      const result = await window.api.invoke('respond-ask-question', {
        requestId: pending.requestId,
        answers: [],
        commandId,
        expectedVersion: pending.version,
        interactionId: pending.interactionId ?? pending.requestId
      })
      if (result && typeof result === 'object' && 'ok' in result && result.ok === false) {
        set({ isSubmittingAskQuestion: false })
        if (pending.sessionId) {
          const { useRunStore } = await import('./useRunStore')
          void useRunStore.getState().pullSnapshot(pending.sessionId)
        }
        return
      }
      set({ pendingAskQuestion: null, isSubmittingAskQuestion: false })
    } catch (err) {
      console.error('dismissAskQuestion 失败:', err)
      set({ isSubmittingAskQuestion: false })
    }
  },

  handleTurnState: (inProgress, sessionId) => {
    set({ mainTurnSessionId: inProgress ? sessionId : null })
  },

  resetAgentRuntime: () => {
    // 注意：不清 mainTurnSessionId——它是主进程广播的全局事实，与会话切换无关
    // snapshot-first 会在切会话后 pullSnapshot 恢复本会话 pending
    set({
      pendingPermissionRequest: null,
      isSubmittingPermission: false,
      permissionError: null,
      pendingVerificationRequest: null,
      pendingAskQuestion: null,
      isSubmittingAskQuestion: false
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
    isSubmittingAskQuestion: false,
    mainTurnSessionId: null
  })
}
