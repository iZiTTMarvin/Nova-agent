import { create } from 'zustand'
import type { PermissionDecision } from '../../shared/permissions/types'
import type { PendingPermissionRequest } from './types'
import type { AskQuestionRequest, AskQuestionAnswer } from '../../shared/askQuestion/types'

export interface AgentState {
  pendingPermissionRequest: PendingPermissionRequest | null
  isSubmittingPermission: boolean
  permissionError: string | null
  pendingAskQuestion: AskQuestionRequest | null
  isSubmittingAskQuestion: boolean
  askQuestionError: string | null
  cancelExecution: (runId?: string) => Promise<void>
  handlePermissionRequest: (request: PendingPermissionRequest) => void
  respondPermissionRequest: (decision: PermissionDecision) => Promise<void>
  handleAskQuestionRequest: (request: AskQuestionRequest) => void
  respondAskQuestion: (answers: AskQuestionAnswer[]) => Promise<void>
  dismissAskQuestion: () => Promise<void>
  resetAgentRuntime: () => void
}

function newCommandId(): string {
  return `cmd_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
}

function sameInteraction(
  a: PendingPermissionRequest | AskQuestionRequest | null,
  b: PendingPermissionRequest | AskQuestionRequest
): boolean {
  return a?.requestId === b.requestId && a.runId === b.runId && a.interactionId === b.interactionId
}

async function refreshRequestSnapshot(sessionId: string | undefined): Promise<void> {
  if (!sessionId) return
  const { useRunStore } = await import('./useRunStore')
  await useRunStore.getState().pullSnapshot(sessionId)
}

async function submitAskQuestionResponse(
  get: () => AgentState,
  set: (partial: Partial<AgentState>) => void,
  answers: AskQuestionAnswer[]
): Promise<void> {
  const pending = get().pendingAskQuestion
  if (!pending || get().isSubmittingAskQuestion) return
  const fallback = answers.length === 0 ? '跳过提问失败' : '提交答案失败'
  set({ isSubmittingAskQuestion: true, askQuestionError: null })
  try {
    const result = await window.api.invoke('respond-ask-question', {
      requestId: pending.requestId,
      answers,
      commandId: newCommandId(),
      expectedVersion: pending.version,
      interactionId: pending.interactionId ?? pending.requestId
    })
    if (sameInteraction(get().pendingAskQuestion, pending)) {
      set({
        isSubmittingAskQuestion: false,
        askQuestionError: result && !result.ok ? result.message || fallback : null
      })
    }
    await refreshRequestSnapshot(pending.sessionId)
  } catch (err) {
    if (sameInteraction(get().pendingAskQuestion, pending)) {
      set({ isSubmittingAskQuestion: false, askQuestionError: err instanceof Error ? err.message : fallback })
    }
  }
}

export const useAgentStore = create<AgentState>((set, get) => ({
  pendingPermissionRequest: null,
  isSubmittingPermission: false,
  permissionError: null,
  pendingAskQuestion: null,
  isSubmittingAskQuestion: false,
  askQuestionError: null,

  cancelExecution: async targetRunId => {
    try {
      const { useRunStore, selectSessionSnapshot } = await import('./useRunStore')
      const sessionId = useRunStore.getState().selectedSessionId
      let runId = targetRunId ?? selectSessionSnapshot(useRunStore.getState(), sessionId)?.runId
      if (!runId && sessionId) {
        await useRunStore.getState().pullSnapshot(sessionId)
        runId = selectSessionSnapshot(useRunStore.getState(), sessionId)?.runId
      }
      if (!runId) throw new Error('无法取消：当前会话没有可识别的运行')
      useRunStore.getState().beginLocalCancel(runId)
      await window.api.invoke('cancel-execution', { runId })
      // 卡片和运行态只在权威快照确认后清除。
    } catch (err) {
      console.error('取消执行失败:', err)
    }
  },

  handlePermissionRequest: request => {
    const same = sameInteraction(get().pendingPermissionRequest, request)
    set({ pendingPermissionRequest: request, ...(same ? {} : { isSubmittingPermission: false, permissionError: null }) })
  },

  respondPermissionRequest: async decision => {
    const pending = get().pendingPermissionRequest
    if (!pending || get().isSubmittingPermission) return
    set({ isSubmittingPermission: true, permissionError: null })
    try {
      const result = await window.api.invoke('respond-permission', {
        requestId: pending.requestId,
        decision,
        commandId: newCommandId(),
        expectedVersion: pending.version,
        interactionId: pending.interactionId ?? pending.requestId
      })
      if (sameInteraction(get().pendingPermissionRequest, pending)) {
        set({
          isSubmittingPermission: false,
          permissionError: result && !result.ok ? result.message || '提交权限决策失败' : null
        })
      }
      await refreshRequestSnapshot(pending.sessionId)
    } catch (err) {
      if (sameInteraction(get().pendingPermissionRequest, pending)) {
        set({ isSubmittingPermission: false, permissionError: err instanceof Error ? err.message : '提交权限决策失败' })
      }
    }
  },

  handleAskQuestionRequest: request => {
    const same = sameInteraction(get().pendingAskQuestion, request)
    set({ pendingAskQuestion: request, ...(same ? {} : { isSubmittingAskQuestion: false, askQuestionError: null }) })
  },
  respondAskQuestion: answers => submitAskQuestionResponse(get, set, answers),
  dismissAskQuestion: () => submitAskQuestionResponse(get, set, []),
  resetAgentRuntime: () => {
    set({
      pendingPermissionRequest: null, isSubmittingPermission: false, permissionError: null,
      pendingAskQuestion: null, isSubmittingAskQuestion: false, askQuestionError: null
    })
  }
}))

export function resetAgentStoreForTests(): void {
  useAgentStore.getState().resetAgentRuntime()
}
