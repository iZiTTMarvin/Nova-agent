import { create } from 'zustand'
import type { LearningSurfaceProjection } from '../../../shared/learning/surface'
import type { LearningAction, LearningCommandReceipt } from '../../../shared/learning/command'
import type { LearningCommandRejection } from './learningCopy'

interface SessionDrafts {
  message: string
  answers: Record<string, string>
}

export interface LearningStoreState {
  sessionId: string | null
  status: 'idle' | 'loading' | 'ready' | 'error'
  error: string | null
  projection: LearningSurfaceProjection | null
  commandPending: boolean
  /** 最近一次被拒的命令回执；由本 store 独占写入，横幅文案由 learningCopy 映射。 */
  commandError: LearningCommandRejection | null
  drafts: Record<string, SessionDrafts>
  setDraft: (sessionId: string, checkpointId: string | null, text: string) => void
  pruneDrafts: (sessionIds: readonly string[]) => void
  refresh: (sessionId: string) => Promise<void>
  sendCommand: (input: { sessionId: string; action: LearningAction }) => Promise<LearningCommandReceipt | null>
  clearForSession: (sessionId: string | null) => void
}

export const useLearningStore = create<LearningStoreState>((set, get) => {
  let epoch = 0
  let refreshRequest = 0
  const commands = new Set<string>()
  const isCurrent = (sessionId: string, generation: number) => get().sessionId === sessionId && epoch === generation

  return {
    sessionId: null, status: 'idle', error: null, projection: null,
    commandPending: false, commandError: null, drafts: {},

    setDraft(sessionId, checkpointId, text) {
      const previous = get().drafts[sessionId] ?? { message: '', answers: {} }
      const next = checkpointId === null
        ? { ...previous, message: text }
        : { ...previous, answers: { ...previous.answers, [checkpointId]: text } }
      set({ drafts: { ...get().drafts, [sessionId]: next } })
    },

    pruneDrafts(sessionIds) {
      const retained = new Set(sessionIds)
      const drafts = get().drafts
      if (Object.keys(drafts).some(id => !retained.has(id))) {
        set({ drafts: Object.fromEntries(Object.entries(drafts).filter(([id]) => retained.has(id))) })
      }
    },

    clearForSession(sessionId) {
      if (get().sessionId === sessionId) return
      epoch++
      refreshRequest++
      set({ sessionId, status: 'idle', error: null, projection: null,
        commandPending: sessionId !== null && commands.has(sessionId), commandError: null })
    },

    async refresh(sessionId) {
      if (get().sessionId === null) get().clearForSession(sessionId)
      if (get().sessionId !== sessionId) return
      const generation = epoch
      const request = ++refreshRequest
      if (!get().projection) set({ status: 'loading', error: null })
      try {
        const projection = await window.api.invoke('learning:get-surface', { sessionId })
        if (!isCurrent(sessionId, generation) || request !== refreshRequest || projection.sessionId !== sessionId) return
        const previous = get().projection
        if (previous && projection.projectionRevision < previous.projectionRevision) return
        set({ status: 'ready', error: null, projection })
      } catch (error) {
        if (isCurrent(sessionId, generation) && request === refreshRequest) {
          set({ status: 'error', error: error instanceof Error ? error.message : String(error) })
        }
      }
    },

    async sendCommand({ sessionId, action }) {
      if (get().sessionId !== sessionId || commands.has(sessionId)) return null
      const generation = epoch
      commands.add(sessionId)
      set({ commandPending: true, commandError: null })
      try {
        if (!get().projection) await get().refresh(sessionId)
        if (!isCurrent(sessionId, generation)) return null
        const projection = get().projection
        if (!projection) throw new Error('学习状态尚未加载，请重试')
        const receipt = await window.api.invoke('learning:command', {
          sessionId,
          command: { commandId: crypto.randomUUID(), sessionId,
            expectedClearGeneration: projection.clearGeneration,
            expectedCursorVersion: projection.cursorVersion, action }
        })
        if (isCurrent(sessionId, generation)) {
          set({ commandError: receipt.ok ? null : receipt })
        }
        return receipt
      } catch (error) {
        if (isCurrent(sessionId, generation)) {
          // 传输层异常没有回执 code；按 invalid 透出原始信息，横幅直接显示 message
          set({ commandError: { ok: false, code: 'invalid', message: error instanceof Error ? error.message : String(error) } })
        }
        return null
      } finally {
        commands.delete(sessionId)
        // 旧回合可以结束，但不能把当前表面重新绑定到旧会话。
        if (get().sessionId === sessionId) {
          set({ commandPending: false })
          void get().refresh(sessionId)
        }
      }
    }
  }
})
