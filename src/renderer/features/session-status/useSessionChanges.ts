import { useEffect, useMemo, useState } from 'react'
import { shallow } from 'zustand/shallow'
import { useChatStore } from '../../stores/useChatStore'
import { buildStatusDiffTurns } from './statusModel'

export function useSessionChanges(sessionId: string) {
  const messages = useChatStore(state => state.messages)
  const caches = useChatStore(state => state.messageDiffs)
  const placeholders = useChatStore(state => state.loadingDiffPlaceholders)
  const messageIds = useChatStore(state => state.messages
    .filter(message => message.sessionId === sessionId && message.role === 'assistant' && message.id !== state.currentGeneratingMessageId)
    .map(message => message.id), shallow)
  const [failedIds, setFailedIds] = useState<string[]>([])
  const [retry, setRetry] = useState(0)

  useEffect(() => {
    let active = true
    void (async () => {
      const failed: string[] = []
      // 同一轮仍走 diffSlice 的缓存与 generation fence；按需分页，不把历史折成全仓 diff。
      for (const messageId of [...messageIds].reverse()) {
        if (!active || useChatStore.getState().currentSessionId !== sessionId) break
        await useChatStore.getState().loadMessageDiffs(sessionId, messageId)
        const state = useChatStore.getState()
        if (!active || state.currentSessionId !== sessionId) break
        if (!state.messageDiffs[messageId] && !state.loadingDiffs.has(messageId)) failed.push(messageId)
      }
      if (active) setFailedIds(failed)
    })()
    return () => { active = false }
  }, [messageIds, sessionId, retry])

  const turns = useMemo(() => buildStatusDiffTurns(messages, sessionId, caches, placeholders), [messages, sessionId, caches, placeholders])
  return { turns, failedIds, retryLoad: () => setRetry(value => value + 1) }
}
