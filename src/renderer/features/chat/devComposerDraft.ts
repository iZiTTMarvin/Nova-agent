import { useCallback, type Dispatch, type SetStateAction } from 'react'
import { create } from 'zustand'
import type { ImageAttachment } from '../../lib/image-attachments'

interface DevDraftState {
  drafts: Record<string, string>
  attachments: Record<string, ImageAttachment[]>
  setDraft: (sessionId: string, value: SetStateAction<string>) => void
  setAttachments: (sessionId: string, value: SetStateAction<ImageAttachment[]>) => void
  retain: (sessionIds: readonly string[]) => void
}

const useDevDraftStore = create<DevDraftState>((set, get) => ({
  drafts: {},
  attachments: {},
  setDraft(sessionId, value) {
    const current = get().drafts[sessionId] ?? ''
    const text = typeof value === 'function' ? value(current) : value
    set({ drafts: { ...get().drafts, [sessionId]: text } })
  },
  setAttachments(sessionId, value) {
    const current = get().attachments[sessionId] ?? EMPTY_ATTACHMENTS
    const attachments = typeof value === 'function' ? value(current) : value
    set({ attachments: { ...get().attachments, [sessionId]: attachments } })
  },
  retain(sessionIds) {
    const ids = new Set(sessionIds)
    if ([...Object.keys(get().drafts), ...Object.keys(get().attachments)].some(id => !ids.has(id))) {
      set({
        drafts: Object.fromEntries(Object.entries(get().drafts).filter(([id]) => ids.has(id))),
        attachments: Object.fromEntries(Object.entries(get().attachments).filter(([id]) => ids.has(id)))
      })
    }
  }
}))

const EMPTY_ATTACHMENTS: ImageAttachment[] = []

export function useDevComposerAttachments(sessionId: string | null): readonly [ImageAttachment[], Dispatch<SetStateAction<ImageAttachment[]>>] {
  const attachments = useDevDraftStore(state => sessionId ? state.attachments[sessionId] ?? EMPTY_ATTACHMENTS : EMPTY_ATTACHMENTS)
  const setAttachments = useCallback<Dispatch<SetStateAction<ImageAttachment[]>>>(value => {
    if (sessionId) useDevDraftStore.getState().setAttachments(sessionId, value)
  }, [sessionId])
  return [attachments, setAttachments]
}

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
