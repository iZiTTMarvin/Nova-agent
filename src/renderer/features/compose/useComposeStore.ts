/**
 * 编排模式 UI store：进度面板 state + askUser 挂起请求
 * 按 sessionId 归属；viewStatus 仅表示 UI 展示态（如崩溃后的「已中断」），不写入 ComposeState。
 */
import { create } from 'zustand'
import {
  parseComposeStateView,
  type ComposeStateView,
  type PendingComposeAskUser
} from './types'

/** UI 层展示态：interrupted = 磁盘仍为 running 但主进程已无此 run */
export type ComposeViewStatus = 'interrupted' | null

const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'cancelled'])

export interface ComposeUiState {
  /** 当前/最近一次编排 runId */
  runId: string | null
  /** 编排所属会话 id（门控渲染用） */
  sessionId: string | null
  /** state.json 快照 */
  state: ComposeStateView | null
  /** 最近若干条脚本日志 */
  logs: string[]
  /** 阶段 5 / 失败确认等 askUser 挂起 */
  pendingAskUser: PendingComposeAskUser | null
  /** 是否正在提交 askUser 答案 */
  isSubmittingAskUser: boolean
  /**
   * 仅 UI 展示态：磁盘 status 仍为 running，但 compose:status 查无 activeRuns → interrupted。
   * 不污染 ComposeState.run.status。
   */
  viewStatus: ComposeViewStatus

  applyState: (runId: string, state: unknown, sessionId?: string | null) => void
  applyPhase: (runId: string, phase: string, sessionId?: string | null) => void
  applyTasks: (runId: string, tasks: unknown[], sessionId?: string | null) => void
  appendLog: (runId: string, message: string, sessionId?: string | null) => void
  handleAskUser: (req: PendingComposeAskUser, sessionId?: string | null) => void
  respondAskUser: (answer: string) => Promise<void>
  /** 从磁盘拉取 state（切换会话/项目时按 sessionId 过滤） */
  loadStateFromDisk: (workspaceRoot: string, sessionId: string) => Promise<void>
  clear: () => void
  /** UI「关闭」入口，语义等同 clear */
  dismiss: () => void
}

const MAX_LOGS = 50

const EMPTY_SLICE = {
  runId: null as string | null,
  sessionId: null as string | null,
  state: null as ComposeStateView | null,
  logs: [] as string[],
  pendingAskUser: null as PendingComposeAskUser | null,
  isSubmittingAskUser: false,
  viewStatus: null as ComposeViewStatus
}

export const useComposeStore = create<ComposeUiState>((set, get) => ({
  ...EMPTY_SLICE,

  applyState: (runId, state, sessionId) => {
    const view = parseComposeStateView(state)
    if (!view) return
    const prevRunId = get().runId
    const isNewRun = prevRunId !== null && prevRunId !== runId
    const isTerminal = TERMINAL_RUN_STATUSES.has(String(view.run.status))
    set({
      runId,
      sessionId: sessionId ?? get().sessionId,
      state: view,
      // 新 run：清空旧日志与挂起 askUser
      ...(isNewRun ? { logs: [], pendingAskUser: null } : {}),
      // 终态：runtime 已 resolve(null)，UI 同步清确认框
      ...(isTerminal ? { pendingAskUser: null } : {}),
      // 收到真实 state 事件时清除「已中断」展示态
      viewStatus: null
    })
  },

  applyPhase: (runId, phase, sessionId) => {
    const prev = get().state
    if (!prev || get().runId !== runId) {
      // 尚无完整 state 时先占位 phase
      set({
        runId,
        sessionId: sessionId ?? get().sessionId,
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
        },
        viewStatus: null
      })
      return
    }
    set({
      sessionId: sessionId ?? get().sessionId,
      state: {
        ...prev,
        phase: {
          current: phase,
          // phase 事件只带裸名；完整 label 由先到达的 workflow_state 维护
          label: prev.phase?.label ?? phase,
          entered_at: prev.phase?.current === phase
            ? prev.phase.entered_at
            : new Date().toISOString()
        },
        run: { ...prev.run, updated_at: new Date().toISOString() }
      }
    })
  },

  applyTasks: (runId, tasks, sessionId) => {
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
      sessionId: sessionId ?? get().sessionId,
      state: { ...prev, tasks: list, stats }
    })
  },

  appendLog: (runId, message, sessionId) => {
    if (get().runId && get().runId !== runId) return
    const logs = [...get().logs, message].slice(-MAX_LOGS)
    set({
      runId: get().runId ?? runId,
      sessionId: sessionId ?? get().sessionId,
      logs
    })
  },

  handleAskUser: (req, sessionId) => {
    set({
      pendingAskUser: req,
      runId: req.runId,
      sessionId: sessionId ?? get().sessionId
    })
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

  loadStateFromDisk: async (workspaceRoot, sessionId) => {
    if (!workspaceRoot || !sessionId) {
      set({ ...EMPTY_SLICE })
      return
    }
    try {
      const raw = await window.api.invoke('compose:get-state', { workspaceRoot })
      const view = parseComposeStateView(raw)
      if (!view) {
        set({ ...EMPTY_SLICE })
        return
      }
      // 无归属或归属不匹配：不显示（旧 state.json 无 session_id 亦清空）
      if (view.run.session_id !== sessionId) {
        set({ ...EMPTY_SLICE })
        return
      }

      let viewStatus: ComposeViewStatus = null
      if (view.run.status === 'running') {
        // 校验主进程 activeRuns：查无则标为已中断，可关闭
        try {
          const live = await window.api.invoke('compose:status', { runId: view.run.id })
          if (!live || live.status !== 'running') {
            viewStatus = 'interrupted'
          }
        } catch {
          viewStatus = 'interrupted'
        }
      }

      set({
        runId: view.run.id,
        sessionId,
        state: view,
        logs: [],
        pendingAskUser: null,
        isSubmittingAskUser: false,
        viewStatus
      })
    } catch {
      set({ ...EMPTY_SLICE })
    }
  },

  clear: () => {
    set({ ...EMPTY_SLICE })
  },

  dismiss: () => {
    set({ ...EMPTY_SLICE })
  }
}))

/** 测试重置 */
export function resetComposeStoreForTests(): void {
  useComposeStore.setState({ ...EMPTY_SLICE })
}
