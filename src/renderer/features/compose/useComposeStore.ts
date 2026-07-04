/**
 * 编排模式 UI store：进度面板 state + askUser 挂起请求
 */
import { create } from 'zustand'
import {
  parseComposeStateView,
  type ComposeStateView,
  type PendingComposeAskUser
} from './types'

export interface ComposeUiState {
  /** 当前/最近一次编排 runId */
  runId: string | null
  /** state.json 快照 */
  state: ComposeStateView | null
  /** 最近若干条脚本日志 */
  logs: string[]
  /** 阶段 5 / 失败确认等 askUser 挂起 */
  pendingAskUser: PendingComposeAskUser | null
  /** 是否正在提交 askUser 答案 */
  isSubmittingAskUser: boolean

  applyState: (runId: string, state: unknown) => void
  applyPhase: (runId: string, phase: string) => void
  applyTasks: (runId: string, tasks: unknown[]) => void
  appendLog: (runId: string, message: string) => void
  handleAskUser: (req: PendingComposeAskUser) => void
  respondAskUser: (answer: string) => Promise<void>
  /** 从磁盘拉取 state（切换项目 / 恢复面板） */
  loadStateFromDisk: (workspaceRoot: string) => Promise<void>
  clear: () => void
}

const MAX_LOGS = 50

export const useComposeStore = create<ComposeUiState>((set, get) => ({
  runId: null,
  state: null,
  logs: [],
  pendingAskUser: null,
  isSubmittingAskUser: false,

  applyState: (runId, state) => {
    const view = parseComposeStateView(state)
    if (!view) return
    set({ runId, state: view })
  },

  applyPhase: (runId, phase) => {
    const prev = get().state
    if (!prev || get().runId !== runId) {
      // 尚无完整 state 时先占位 phase
      set({
        runId,
        state: {
          run: {
            id: runId,
            command: 'br-full-dev',
            script: 'br-full-dev',
            started_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            status: 'running'
          },
          phase: {
            current: phase,
            label: phase,
            entered_at: new Date().toISOString()
          }
        }
      })
      return
    }
    set({
      state: {
        ...prev,
        phase: {
          current: phase,
          label: prev.phase?.label === phase ? phase : phase,
          entered_at: prev.phase?.current === phase
            ? prev.phase.entered_at
            : new Date().toISOString()
        },
        run: { ...prev.run, updated_at: new Date().toISOString() }
      }
    })
  },

  applyTasks: (runId, tasks) => {
    const prev = get().state
    if (!prev || get().runId !== runId) return
    const list = Array.isArray(tasks) ? (tasks as ComposeStateView['tasks']) : []
    const stats = {
      total: list?.length ?? 0,
      done: list?.filter((t) => t.status === 'done').length ?? 0,
      skipped: list?.filter((t) => t.status === 'skipped').length ?? 0,
      failed: list?.filter((t) => t.status === 'failed').length ?? 0
    }
    set({
      state: { ...prev, tasks: list, stats }
    })
  },

  appendLog: (runId, message) => {
    if (get().runId && get().runId !== runId) return
    const logs = [...get().logs, message].slice(-MAX_LOGS)
    set({ runId: get().runId ?? runId, logs })
  },

  handleAskUser: (req) => {
    set({ pendingAskUser: req, runId: req.runId })
  },

  respondAskUser: async (answer) => {
    const pending = get().pendingAskUser
    if (!pending || get().isSubmittingAskUser) return
    set({ isSubmittingAskUser: true, pendingAskUser: null })
    try {
      await window.api.invoke('compose:respond-ask-user', {
        runId: pending.runId,
        requestId: pending.requestId,
        answer
      })
    } finally {
      set({ isSubmittingAskUser: false })
    }
  },

  loadStateFromDisk: async (workspaceRoot) => {
    if (!workspaceRoot) return
    try {
      const raw = await window.api.invoke('compose:get-state', { workspaceRoot })
      const view = parseComposeStateView(raw)
      if (view) {
        set({ runId: view.run.id, state: view })
      } else {
        // 目标项目无编排 state：清空面板，避免残留上一项目进度
        set({
          runId: null,
          state: null,
          logs: [],
          pendingAskUser: null,
          isSubmittingAskUser: false
        })
      }
    } catch {
      set({
        runId: null,
        state: null,
        logs: [],
        pendingAskUser: null,
        isSubmittingAskUser: false
      })
    }
  },

  clear: () => {
    set({
      runId: null,
      state: null,
      logs: [],
      pendingAskUser: null,
      isSubmittingAskUser: false
    })
  }
}))

/** 测试重置 */
export function resetComposeStoreForTests(): void {
  useComposeStore.setState({
    runId: null,
    state: null,
    logs: [],
    pendingAskUser: null,
    isSubmittingAskUser: false
  })
}
