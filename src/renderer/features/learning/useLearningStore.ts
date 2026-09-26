import { create } from 'zustand'
import type { LearningSurfaceProjection, LearningDevLinkReference } from '../../../shared/learning/surface'
import type { LearningAction, LearningCommandReceipt } from '../../../shared/learning/command'
import type { KnowledgeNodeMaterialView } from '../../../shared/learning/knowledgeProjection'

export interface LearningMaterialState {
  readonly nodeId: string
  readonly status: 'loading' | 'ready' | 'error'
  readonly material: KnowledgeNodeMaterialView | null
  readonly error: string | null
}

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
  commandError: string | null
  material: LearningMaterialState | null
  drafts: Record<string, SessionDrafts>
  setDraft: (sessionId: string, checkpointId: string | null, text: string) => void
  pruneDrafts: (sessionIds: readonly string[]) => void
  refresh: (sessionId: string) => Promise<void>
  openNodeMaterial: (sessionId: string, nodeId: string) => Promise<void>
  closeMaterial: () => void
  sendCommand: (input: { sessionId: string; action: LearningAction; devReference?: LearningDevLinkReference }) => Promise<LearningCommandReceipt | null>
  clearForSession: (sessionId: string | null) => void
}

export const useLearningStore = create<LearningStoreState>((set, get) => {
  let epoch = 0
  let refreshRequest = 0
  let materialRequest = 0
  const commands = new Set<string>()
  const isCurrent = (sessionId: string, generation: number) => get().sessionId === sessionId && epoch === generation

  return {
    sessionId: null, status: 'idle', error: null, projection: null,
    commandPending: false, commandError: null, material: null, drafts: {},

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
      materialRequest++
      set({ sessionId, status: 'idle', error: null, projection: null, material: null,
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

    async openNodeMaterial(sessionId, nodeId) {
      if (get().sessionId !== sessionId) return
      const generation = epoch
      const request = ++materialRequest
      set({ material: { nodeId, status: 'loading', material: null, error: null } })
      try {
        const result = await window.api.invoke('learning:get-node-material', { sessionId, nodeId })
        if (!isCurrent(sessionId, generation) || request !== materialRequest) return
        set({ material: result.ok
          ? { nodeId, status: 'ready', material: result.material, error: null }
          : { nodeId, status: 'error', material: null, error: result.message } })
      } catch (error) {
        if (isCurrent(sessionId, generation) && request === materialRequest) {
          set({ material: { nodeId, status: 'error', material: null, error: error instanceof Error ? error.message : String(error) } })
        }
      }
    },

    closeMaterial() {
      materialRequest++
      set({ material: null })
    },

    async sendCommand({ sessionId, action, devReference }) {
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
            expectedCursorVersion: projection.cursorVersion, action },
          ...(devReference ? { devReference } : {})
        })
        if (isCurrent(sessionId, generation)) {
          set({ commandError: receipt.ok ? null : receipt.message })
        }
        return receipt
      } catch (error) {
        if (isCurrent(sessionId, generation)) {
          set({ commandError: error instanceof Error ? error.message : String(error) })
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
