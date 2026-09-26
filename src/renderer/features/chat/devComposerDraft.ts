import { useCallback, type Dispatch, type SetStateAction } from 'react'
import { create } from 'zustand'

interface DevDraftState {
  drafts: Record<string, string>
  setDraft: (sessionId: string, value: SetStateAction<string>) => void
  retain: (sessionIds: readonly string[]) => void
}

const useDevDraftStore = create<DevDraftState>((set, get) => ({
  drafts: {},
  setDraft(sessionId, value) {
    const current = get().drafts[sessionId] ?? ''
    const text = typeof value === 'function' ? value(current) : value
    set({ drafts: { ...get().drafts, [sessionId]: text } })
  },
  retain(sessionIds) {
    const ids = new Set(sessionIds)
    if (Object.keys(get().drafts).some(id => !ids.has(id))) {
      set({ drafts: Object.fromEntries(Object.entries(get().drafts).filter(([id]) => ids.has(id))) })
    }
  }
}))

export function useDevComposerDraft(sessionId: string | null): readonly [string, Dispatch<SetStateAction<string>>] {
  const text = useDevDraftStore(state => sessionId ? state.drafts[sessionId] ?? '' : '')
  const setText = useCallback<Dispatch<SetStateAction<string>>>(value => {
    if (sessionId) useDevDraftStore.getState().setDraft(sessionId, value)
  }, [sessionId])
  return [text, setText]
}

export function readDevComposerDraft(sessionId: string): string {
  return useDevDraftStore.getState().drafts[sessionId] ?? ''
}

export function retainDevComposerDrafts(sessionIds: readonly string[]): void {
  useDevDraftStore.getState().retain(sessionIds)
}
