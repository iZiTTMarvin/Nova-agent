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
      const reversedIds = [...messageIds].reverse()
      // 同一轮仍走 diffSlice 的缓存与 generation fence；并发拉取本页消息 diff，避免逐条串行 IPC 阻塞会话打开后响应。
      await Promise.all(
        reversedIds.map(async (messageId) => {
          if (!active || useChatStore.getState().currentSessionId !== sessionId) return
          await useChatStore.getState().loadMessageDiffs(sessionId, messageId)
        })
      )
      if (!active || useChatStore.getState().currentSessionId !== sessionId) return
      const state = useChatStore.getState()
      const failed = reversedIds.filter(
        messageId => !state.messageDiffs[messageId] && !state.loadingDiffs.has(messageId)
      )
      setFailedIds(failed)
    })()
    return () => { active = false }
  }, [messageIds, sessionId, retry])

  const turns = useMemo(() => buildStatusDiffTurns(messages, sessionId, caches, placeholders), [messages, sessionId, caches, placeholders])
  return { turns, failedIds, retryLoad: () => setRetry(value => value + 1) }
}
