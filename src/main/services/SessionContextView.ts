import { app } from 'electron'
import { calculateContextBreakdown } from '../../runtime/agent'
import { buildConversationContext, type SessionData, type SessionStore } from '../../runtime/sessions'
import { restoreFromLedger } from '../../runtime/sessions/contextSnapshot'
import { loadModelConfig } from '../../runtime/model/config'
import { resolveCacheProfile } from '../../runtime/model/cacheProfile'
import { resolveContextWindow } from '../../shared/config/types'
import type { ContextBreakdown } from '../../shared/agent/contextBreakdown'

/** 从持久化历史及压缩账本重建显示投影，不创建 Agent 或改写会话。 */
export function buildSessionContextBreakdown(session: SessionData, store: SessionStore): ContextBreakdown {
  const config = loadModelConfig(app.getPath('userData'))
  const profile = resolveCacheProfile(config?.baseUrl ?? '', config?.modelId ?? '', {
    cacheProfile: config?.cacheProfile, cacheStrategy: config?.cacheStrategy
  })
  const options = { reasoningReplay: profile.reasoningReplay, currentProviderId: profile.id }
  const ledger = store.loadContextSnapshot(session.id)
  const restored = ledger?.entries.length
    ? restoreFromLedger(session, ledger, session.frozenSystemPrompt ?? '', options)
    : null
  const messages = restored && restored.kind !== 'invalid'
    ? restored.messages
    : buildConversationContext(session, session.mode, options)
  const system = messages.find(message => message.role === 'system')
  const { payload } = calculateContextBreakdown({
    session: system && typeof system.content === 'string' ? { ...session, frozenSystemPrompt: system.content } : session,
    runtimeMessages: messages.filter(message => message.role !== 'system'),
    toolDefinitions: [],
    contextLimit: resolveContextWindow(config?.modelId ?? '', config?.contextWindow)
  })
  return payload
}
