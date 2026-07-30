import { SESSION_HISTORY_PAGE_SIZE } from '../../../../shared/session/messagePagination'
import { commitMessageList, restoreSessionMessages } from '../internal'
import type { ChatSliceCreator, PaginationSliceState } from '../types'

let paginationGeneration = 0

export function invalidatePaginationGeneration(): void {
  paginationGeneration += 1
}

function isPaginationRequestCurrent(
  generation: number,
  sessionAtStart: string,
  currentSessionId: string | null
): boolean {
  return generation === paginationGeneration && currentSessionId === sessionAtStart
}

export function initialPaginationState(): Pick<
  PaginationSliceState,
  'hasMoreMessagesAbove' | 'isLoadingOlderMessages' | 'oldestLoadedMessageId' | 'suspendHeadTrim'
> {
  return {
    hasMoreMessagesAbove: false,
    isLoadingOlderMessages: false,
    oldestLoadedMessageId: null,
    suspendHeadTrim: false
  }
}

export const createPaginationSlice: ChatSliceCreator<PaginationSliceState> = (set, get) => ({
  ...initialPaginationState(),

  loadOlderMessages: async () => {
    const {
      currentSessionId,
      oldestLoadedMessageId,
      hasMoreMessagesAbove,
      isLoadingOlderMessages
    } = get()

    if (!currentSessionId || !hasMoreMessagesAbove || isLoadingOlderMessages || !oldestLoadedMessageId) {
      return
    }

    const sessionIdAtStart = currentSessionId
    const generation = paginationGeneration
    set({ isLoadingOlderMessages: true })

    try {
      const result = await window.api.invoke('load-session-messages', {
        sessionId: sessionIdAtStart,
        beforeId: oldestLoadedMessageId,
        limit: SESSION_HISTORY_PAGE_SIZE
      })

      if (!isPaginationRequestCurrent(generation, sessionIdAtStart, get().currentSessionId)) {
        return
      }

      const older = restoreSessionMessages(result.messages)
      if (older.length === 0) {
        set({ hasMoreMessagesAbove: result.hasMore, isLoadingOlderMessages: false })
        return
      }

      set(state => {
        const merged = [...older, ...state.messages]
        return {
          ...commitMessageList(state, { nextMessages: merged, skipWindowTrim: true }),
          hasMoreMessagesAbove: result.hasMore,
          oldestLoadedMessageId: merged[0]?.id ?? null,
          isLoadingOlderMessages: false,
          suspendHeadTrim: true
        }
      })
    } catch (err) {
      console.error('[useChatStore] loadOlderMessages 失败:', err)
      if (isPaginationRequestCurrent(generation, sessionIdAtStart, get().currentSessionId)) {
        set({ isLoadingOlderMessages: false })
      }
    }
  }
})
