import type { SessionDetail } from '../../../../shared/session/types'
import { mergeFocusedSessionMessages } from '../../../lib/focusedSessionRecovery'
import type { ChatState } from '../types'
import { commitMessageList } from './commitMessages'
import { restoreSessionMessages } from './restoreMessages'
import { upsertSessionSummary } from './sessionSummary'

/**
 * 焦点会话对账所需的最小 store API。
 * getState 必须传函数而非快照：对账跨 await，快照会读到陈旧 state。
 */
export interface ChatStoreApi {
  getState: () => ChatState
  setState: (patch: Partial<ChatState> | ((s: ChatState) => Partial<ChatState>)) => void
}

/**
 * 轮次终态回 SessionStore 按 id 对账焦点会话消息：
 * 已持久化消息优先，正在生成的实时消息仍被保留。
 */
export async function reconcileFocusedSession(api: ChatStoreApi, sessionId: string): Promise<void> {
  const detail: SessionDetail = await window.api.invoke('load-session', { sessionId })
  if (api.getState().currentSessionId !== sessionId) return

  const restored = restoreSessionMessages(detail.messages)
  api.setState(state => {
    if (state.currentSessionId !== sessionId) return state
    const messages = mergeFocusedSessionMessages(
      restored,
      state.messages,
      state.currentGeneratingMessageId,
      null
    )
    return {
      ...commitMessageList(state, { nextMessages: messages, skipWindowTrim: true }),
      sessions: upsertSessionSummary(state.sessions, detail)
    }
  })
}
