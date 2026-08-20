import { create } from 'zustand'
import type { CodeIndexStatusDto } from '../../shared/code-index'

const NO_WORKSPACE_KEY = '\0'

export interface CodeIndexUiState {
  currentWorkspaceRoot: string | null
  snapshotsByWorkspaceRoot: Record<string, CodeIndexStatusDto>
  errorsByWorkspaceRoot: Record<string, string | null>
  refreshRequestIdByWorkspaceRoot: Record<string, number>
  syncWorkspace: (
    workspaceRoot: string | null,
    options?: {
      readonly resetForSessionChange?: boolean
      readonly refreshStatus?: boolean
    }
  ) => void
  refreshStatus: () => Promise<void>
  handleStatusEvent: (snapshot: CodeIndexStatusDto) => void
}

export const useCodeIndexStore = create<CodeIndexUiState>((set, get) => ({
  currentWorkspaceRoot: null,
  snapshotsByWorkspaceRoot: {},
  errorsByWorkspaceRoot: {},
  refreshRequestIdByWorkspaceRoot: {},

  syncWorkspace: (workspaceRoot, options) => {
    const key = workspaceKey(workspaceRoot)
    set((state) => {
      if (!options?.resetForSessionChange) {
        return { currentWorkspaceRoot: workspaceRoot }
      }

      const previous = state.snapshotsByWorkspaceRoot[key]
      return {
        currentWorkspaceRoot: workspaceRoot,
        snapshotsByWorkspaceRoot: previous
          ? {
              ...state.snapshotsByWorkspaceRoot,
              [key]: { ...previous, enabled: false }
            }
          : state.snapshotsByWorkspaceRoot,
        errorsByWorkspaceRoot: {
          ...state.errorsByWorkspaceRoot,
          [key]: null
        }
      }
    })
    if (options?.refreshStatus !== false) {
      void get().refreshStatus()
    }
  },

  refreshStatus: async () => {
    const requestedRoot = get().currentWorkspaceRoot
    const requestedKey = workspaceKey(requestedRoot)
    const requestId = (get().refreshRequestIdByWorkspaceRoot[requestedKey] ?? 0) + 1
    set((state) => ({
      refreshRequestIdByWorkspaceRoot: {
        ...state.refreshRequestIdByWorkspaceRoot,
        [requestedKey]: requestId
      }
    }))
    try {
      const snapshot = await window.api.invoke('codeindex:get-status')
      set((state) => {
        // pull 返回没有事件顺序保证；同工作区只接受最后一次拉取结果。
        if (state.refreshRequestIdByWorkspaceRoot[requestedKey] !== requestId) {
          return state
        }
        const key = workspaceKey(snapshot.workspaceRoot)
        const previous = state.snapshotsByWorkspaceRoot[key]
        const snapshotsByWorkspaceRoot = previous && previous.sequence > snapshot.sequence
          ? state.snapshotsByWorkspaceRoot
          : { ...state.snapshotsByWorkspaceRoot, [key]: snapshot }
        return {
          snapshotsByWorkspaceRoot,
          errorsByWorkspaceRoot: {
            ...state.errorsByWorkspaceRoot,
            [requestedKey]: null,
            [key]: null
          }
        }
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : '读取代码索引状态失败'
      set((state) => {
        if (state.refreshRequestIdByWorkspaceRoot[requestedKey] !== requestId) {
          return state
        }
        return {
          errorsByWorkspaceRoot: {
            ...state.errorsByWorkspaceRoot,
            [requestedKey]: message
          }
        }
      })
    }
  },

  handleStatusEvent: (snapshot) => {
    const key = workspaceKey(snapshot.workspaceRoot)
    set((state) => {
      // 事件只有在 snapshot-first 确认当前会话已启用后才可更新该工作区投影。
      const previous = state.snapshotsByWorkspaceRoot[key]
      if (previous?.enabled !== true) return state
      if (previous && snapshot.sequence <= previous.sequence) return state
      return {
        snapshotsByWorkspaceRoot: {
          ...state.snapshotsByWorkspaceRoot,
          [key]: snapshot
        },
        errorsByWorkspaceRoot: {
          ...state.errorsByWorkspaceRoot,
          [key]: null
        }
      }
    })
  }
}))

export function selectCurrentCodeIndexStatus(
  state: CodeIndexUiState
): CodeIndexStatusDto | null {
  return state.snapshotsByWorkspaceRoot[workspaceKey(state.currentWorkspaceRoot)] ?? null
}

export function selectCurrentCodeIndexError(state: CodeIndexUiState): string | null {
  return state.errorsByWorkspaceRoot[workspaceKey(state.currentWorkspaceRoot)] ?? null
}

export function resetCodeIndexStoreForTests(): void {
  useCodeIndexStore.setState({
    currentWorkspaceRoot: null,
    snapshotsByWorkspaceRoot: {},
    errorsByWorkspaceRoot: {},
    refreshRequestIdByWorkspaceRoot: {}
  })
}

function workspaceKey(workspaceRoot: string | null): string {
  return workspaceRoot ?? NO_WORKSPACE_KEY
}
