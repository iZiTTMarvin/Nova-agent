/**
 * compose 阶段条渲染端 store
 *
 * 职责：
 * - 缓存 main 推送的 `agent:compose-stages-updated` 阶段表（按 sessionId 隔离，切会话不串数据）
 * - 会话水合时接收 load-session 透出的持久化阶段表
 * - 值为 null 表示会话尚无阶段表（新会话/旧会话），由投影层按初始表纯显示，不写回
 */
import { create } from 'zustand'
import type { ComposeStageEntry } from '../../../shared/composeLifecycle'

export interface ComposeStageUpdate {
  sessionId: string
  stages: ComposeStageEntry[]
}

interface ComposeStageStoreState {
  /** 按 sessionId 缓存的阶段表；null = 已知该会话但尚无阶段表 */
  bySession: Record<string, ComposeStageEntry[] | null>
}

interface ComposeStageStoreActions {
  /** 处理来自 main 进程的阶段表更新事件 */
  applyUpdate: (update: ComposeStageUpdate) => void
  /** 会话水合时写入持久化阶段表（磁盘为事实源，事件推送先于持久化不会发生） */
  setSessionStages: (sessionId: string, stages: ComposeStageEntry[] | null) => void
  reset: () => void
}

export const useComposeStageStore = create<ComposeStageStoreState & ComposeStageStoreActions>((set) => ({
  bySession: {},

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

  reset: () => {
    set({ bySession: {} })
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
