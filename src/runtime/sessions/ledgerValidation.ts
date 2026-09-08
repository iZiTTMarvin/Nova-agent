import { buildConversationContext, type BuildConversationContextOptions } from './conversationContext'
import { getSessionActiveMessages } from './tree'
import type { CompactionLedger, SessionData } from './types'
import { extractTextFromSerializableContent } from './types'
import type { ChatMessage, MessageOrigin } from '../model/types'

/**
 * 仅允许折叠已归档的相同前缀，并留一个可恢复的尾部坐标。
 * `visible` 必须是运行时可见消息（已去掉 system 与 internal），索引口径与返回值一致。
 */
export function durableCompactionPrefixLength(session: SessionData, visible: readonly ChatMessage[], projection: BuildConversationContextOptions): number {
  const archived = buildConversationContext(session, session.mode, projection)
  const sameOrigin = (a: ChatMessage, b: ChatMessage): boolean => Boolean(a.origin && b.origin && a.origin.messageId === b.origin.messageId && a.origin.step === b.origin.step)
  const start = archived.findIndex(message => visible[0] && sameOrigin(message, visible[0]))
  if (start < 0) return 0
  const fact = (message: ChatMessage): string => JSON.stringify({ role: message.role, content: message.content,
    toolCalls: message.toolCalls, toolCallId: message.toolCallId, origin: message.origin, reasoningContent: message.reasoningContent })
  // 子轮新生成的完整 thinking 只在归档投影比对失败时才需要，全量回放按需构建一次。
  let fullCache: ChatMessage[] | null = null
  const matchesArchive = (index: number, message: ChatMessage): boolean => {
    if (fact(message) === fact(archived[index])) return true
    fullCache ??= buildConversationContext(session, session.mode, { resolveImageUrl: projection.resolveImageUrl, reasoningReplay: 'all-history' })
    const replayed = fullCache[index]
    return replayed !== undefined && fact(message) === fact(replayed)
  }
  let count = 0
  while (count < visible.length && start + count < archived.length && visible[count].origin &&
    matchesArchive(start + count, visible[count])) count++
  // 不匹配的 user 投影可以保留；无归档坐标的草稿须连同前一条归档消息保留。
  while (count > 0 && (!visible[count] || !archived[start + count] || !sameOrigin(visible[count], archived[start + count]))) count--
  return count
}

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
