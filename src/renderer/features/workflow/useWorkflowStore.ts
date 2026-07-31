/**
 * 编排运行态 store（renderer 侧投影）。
 *
 * run 状态的真源在主进程 orchestrator；本 store 只镜像 workflow:run-state 事件，
 * 供输入框判断是否进入运行态。任何一处都不得据此改写 run 状态本身。
 */
import { create } from 'zustand'
import type { WorkflowRunStatus } from '../../../shared/workflow/types'

export interface ActiveWorkflowRun {
  runId: string
  sessionId: string | null
  workflow: string
  phase: string
}

/** 拒绝新消息时的运行态提示；用户确认后走中断，取消后仅关闭提示 */
export interface WorkflowBusyNotice {
  runId: string
  workflow: string
  phase: string
}

export interface WorkflowUiState {
  /** 当前运行中的编排；终态后置空 */
  activeRun: ActiveWorkflowRun | null
  busyNotice: WorkflowBusyNotice | null

  applyRunState: (payload: {
    runId: string
    sessionId?: string
    workflow: string
    status: WorkflowRunStatus
    phase: string
  }) => void
  /** 主进程拒绝了运行态下的新消息 */
  showBusyNotice: (notice: WorkflowBusyNotice) => void
  dismissBusyNotice: () => void
  /** 会话切换 / 会话删除时清理 */
  clear: () => void
  /** 指定会话是否处于编排运行态 */
  isRunningForSession: (sessionId: string | null) => boolean
}

export const useWorkflowStore = create<WorkflowUiState>((set, get) => ({
  activeRun: null,
  busyNotice: null,

  applyRunState: (payload) => {
    if (payload.status === 'running') {
      set({
        activeRun: {
          runId: payload.runId,
          sessionId: payload.sessionId ?? null,
          workflow: payload.workflow,
          phase: payload.phase
        }
      })
      return
    }
    // 终态：只清理属于同一 runId 的记录，避免并发会话的编排互相顶掉
    set((state) =>
      state.activeRun?.runId === payload.runId
        ? { activeRun: null, busyNotice: null }
        : state
    )
  },

  showBusyNotice: (notice) => set({ busyNotice: notice }),
  dismissBusyNotice: () => set({ busyNotice: null }),
  clear: () => set({ activeRun: null, busyNotice: null }),

  isRunningForSession: (sessionId) => {
    const active = get().activeRun
    if (!active) return false
    // 事件缺 sessionId（旧事件 / 无会话归属）时按「当前会话」处理，宁可拦住也不误发
    if (active.sessionId === null) return true
    return active.sessionId === sessionId
  }
}))
