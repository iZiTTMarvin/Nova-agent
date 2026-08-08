/**
 * compose 生命周期渲染端 store
 *
 * 职责：
 * - 缓存 main 推送的 `agent:compose-stages-updated` 阶段表（按 sessionId 隔离，切会话不串数据）
 * - 缓存 main 推送的 `agent:compose-plan-approval-updated` 计划确认门状态（同样按 sessionId 隔离）
 * - 会话水合时接收 load-session 透出的持久化阶段表 / 批准状态
 * - 值为 null 表示会话尚无该数据（新会话/旧会话），由投影层按默认值纯显示，不写回
 */
import { create } from 'zustand'
import type { ComposePlanApproval, ComposeStageEntry } from '../../../shared/composeLifecycle'

export interface ComposeStageUpdate {
  sessionId: string
  stages: ComposeStageEntry[]
}

export interface ComposePlanApprovalUpdate {
  sessionId: string
  approval: ComposePlanApproval
}

interface ComposeStageStoreState {
  /** 按 sessionId 缓存的阶段表；null = 已知该会话但尚无阶段表 */
  bySession: Record<string, ComposeStageEntry[] | null>
  /** 按 sessionId 缓存的计划确认门状态；null = 已知该会话但尚无批准记录（视为 pending） */
  planApprovalBySession: Record<string, ComposePlanApproval | null>
}

interface ComposeStageStoreActions {
  /** 处理来自 main 进程的阶段表更新事件 */
  applyUpdate: (update: ComposeStageUpdate) => void
  /** 会话水合时写入持久化阶段表（磁盘为事实源，事件推送先于持久化不会发生） */
  setSessionStages: (sessionId: string, stages: ComposeStageEntry[] | null) => void
  /** 处理来自 main 进程的计划确认门更新事件 */
  applyPlanApprovalUpdate: (update: ComposePlanApprovalUpdate) => void
  /** 会话水合时写入持久化的计划确认门状态 */
  setSessionPlanApproval: (sessionId: string, approval: ComposePlanApproval | null) => void
  reset: () => void
}

export const useComposeStageStore = create<ComposeStageStoreState & ComposeStageStoreActions>((set) => ({
  bySession: {},
  planApprovalBySession: {},

  applyUpdate: ({ sessionId, stages }) => {
    set((state) => ({
      bySession: { ...state.bySession, [sessionId]: stages }
    }))
  },

  setSessionStages: (sessionId, stages) => {
    set((state) => ({
      bySession: { ...state.bySession, [sessionId]: stages }
    }))
  },

  applyPlanApprovalUpdate: ({ sessionId, approval }) => {
    set((state) => ({
      planApprovalBySession: { ...state.planApprovalBySession, [sessionId]: approval }
    }))
  },

  setSessionPlanApproval: (sessionId, approval) => {
    set((state) => ({
      planApprovalBySession: { ...state.planApprovalBySession, [sessionId]: approval }
    }))
  },

  reset: () => {
    set({ bySession: {}, planApprovalBySession: {} })
  }
}))

/** 选中某会话的阶段表（不存在时返回 null，投影层据此回退初始表显示） */
export function selectSessionComposeStages(
  state: ComposeStageStoreState,
  sessionId: string | null
): ComposeStageEntry[] | null {
  if (!sessionId) return null
  return state.bySession[sessionId] ?? null
}

/** 选中某会话的计划确认门状态（不存在时返回 null，调用方按 pending 处理） */
export function selectSessionComposePlanApproval(
  state: ComposeStageStoreState,
  sessionId: string | null
): ComposePlanApproval | null {
  if (!sessionId) return null
  return state.planApprovalBySession[sessionId] ?? null
}
