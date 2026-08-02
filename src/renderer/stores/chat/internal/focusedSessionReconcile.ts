import type { Session, SessionDetail } from '../../../../shared/session/types'
import { mergeFocusedSessionMessages } from '../../../lib/focusedSessionRecovery'
import { commitMessageList } from './commitMessages'
import { restoreSessionMessages } from './restoreMessages'
import type { ChatStoreApi } from './storeApi'

function upsertSessionSummary(sessions: Session[], detail: SessionDetail): Session[] {
  const base = {
    id: detail.id,
    workspaceRoot: detail.workspaceRoot,
    mode: detail.mode,
    createdAt: detail.createdAt,
    updatedAt: detail.updatedAt,
    messageCount: detail.messageCount
  }
  const nextSummary: Session = detail.kind === 'subagent'
    ? { ...base, kind: 'subagent', subagent: detail.subagent }
    : { ...base, kind: 'primary' }
  return [nextSummary, ...sessions.filter(session => session.id !== detail.id)]
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
      currentSubagentTask: detail.kind === 'subagent' ? detail.subagentTask ?? null : null,
      sessions: upsertSessionSummary(state.sessions, detail)
    }
  })
}
