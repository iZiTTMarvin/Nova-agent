import { buildConversationContext } from './conversationContext'
import { getSessionActiveMessages } from './tree'
import type { CompactionLedger, SessionData } from './types'
import { extractTextFromSerializableContent } from './types'
import type { MessageOrigin } from '../model/types'

export type LedgerRestoreKind = 'restored' | 'empty-tail' | 'invalid'

function originMessageId(origin: MessageOrigin | null | undefined): string | null {
  const id = origin?.messageId
  return id ? id : null
}

function originKey(origin: MessageOrigin | null | undefined): string | null {
  const id = originMessageId(origin)
  return id && origin ? `${id}\0${origin.step}` : null
}

/**
 * tailFrom 尚未落盘时按空尾部恢复；已提交条目与状态坐标必须仍在激活路径。
 */
export function classifyLedgerRestore(
  session: SessionData,
  ledger: CompactionLedger
): Exclude<LedgerRestoreKind, never> {
  const activeIds = new Set(getSessionActiveMessages(session).map(m => m.id))
  const allIds = new Set(session.messages.map(m => m.id))
  const activeOriginPositions = new Map<string, { first: number; last: number }>()
  const conversation = buildConversationContext(session, session.mode)
  for (const [index, message] of conversation.entries()) {
    const key = originKey(message.origin)
    if (!key) continue
    const current = activeOriginPositions.get(key)
    activeOriginPositions.set(key, {
      first: current?.first ?? index,
      last: index
    })
  }

  const locate = (
    origin: MessageOrigin | null | undefined
  ): 'ok' | 'missing' | 'off-path' | 'invalid-step' | 'skip' => {
    const id = originMessageId(origin)
    if (!id) return 'skip'
    if (!allIds.has(id)) return 'missing'
    if (!activeIds.has(id)) return 'off-path'
    const key = originKey(origin)
    return key && activeOriginPositions.has(key) ? 'ok' : 'invalid-step'
  }

  let previousEnd = -1
  for (const entry of ledger.entries) {
    if (locate(entry.shadows.from) !== 'ok') return 'invalid'
    if (locate(entry.shadows.to) !== 'ok') return 'invalid'
    const from = activeOriginPositions.get(originKey(entry.shadows.from)!)!
    const to = activeOriginPositions.get(originKey(entry.shadows.to)!)!
    if (from.first > to.last || from.first !== previousEnd + 1) return 'invalid'
    previousEnd = to.last
  }
  if (ledger.state && locate(ledger.state.coversThrough) !== 'ok') return 'invalid'
  if (ledger.state?.taskVerbatim && locate(ledger.state.taskVerbatim.origin) !== 'ok') return 'invalid'
  for (const fact of ledger.state?.handoff?.facts ?? []) {
    if (locate(fact.origin) !== 'ok') return 'invalid'
    const position = activeOriginPositions.get(originKey(fact.origin)!)!
    if (!ledger.entries.some(entry => position.first >= activeOriginPositions.get(originKey(entry.shadows.from)!)!.first && position.last <= activeOriginPositions.get(originKey(entry.shadows.to)!)!.last)) return 'invalid'
    const message = session.messages.find(message => message.role === 'user' && message.id === fact.origin.messageId)
    if (!message || !extractTextFromSerializableContent(message.content).includes(fact.quote) || fact.value !== fact.quote || fact.owner !== fact.origin.messageId) return 'invalid'
  }

  const tailStatus = locate(ledger.tailFrom)
  if (tailStatus === 'off-path' || tailStatus === 'invalid-step') return 'invalid'
  if (tailStatus === 'missing') return 'empty-tail'
  if (tailStatus === 'skip' && previousEnd !== conversation.length - 1) return 'invalid'
  if (tailStatus === 'ok' && activeOriginPositions.get(originKey(ledger.tailFrom)!)!.first !== previousEnd + 1) return 'invalid'
  return 'restored'
}
