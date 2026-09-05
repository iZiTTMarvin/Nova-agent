import { createHash } from 'crypto'
import { extractTextFromContent, type ChatMessage } from '../../model/types'
import { parseStructuredHandoff, type HandoffFact, type StructuredHandoff } from '../../sessions'

/** 原始用户约束逐句保留；模型不能自行缩减必需集合。 */
export function collectRequiredFacts(messages: readonly ChatMessage[], previous: readonly HandoffFact[]): HandoffFact[] {
  const facts = new Map(previous.filter(fact => fact.required).map(fact => [fact.id, fact]))
  const task = messages.find(message => message.role === 'user' && !message.internal)
  for (const message of messages) {
    if (message.role !== 'user' || message.internal || !message.origin) continue
    const sentences = extractTextFromContent(message.content).split(/\n|(?<=[。！？])\s*/u).map(line => line.trim()).filter(Boolean)
    for (const [index, quote] of sentences.entries()) {
      const constraint = /必须|禁止|不得|不要|务必|要求|约束|保留|记住|校验|\b(must|never|required|constraint|remember)\b/i.test(quote)
      if (!constraint && (message !== task || index !== 0)) continue
      const category = constraint ? 'constraint' : 'task'
      const id = createHash('sha256').update(JSON.stringify([message.origin, category, quote])).digest('hex').slice(0, 24)
      facts.set(id, { id, category, owner: message.origin.messageId, value: quote, quote, origin: { ...message.origin }, required: true })
    }
  }
  return [...facts.values()]
}

export function validateHandoff(text: string, messages: readonly ChatMessage[], required: readonly HandoffFact[], previous: readonly HandoffFact[]): StructuredHandoff | null {
  let value: unknown
  try { value = JSON.parse(text) } catch { return null }
  const doc = parseStructuredHandoff(value)
  if (!doc) return null
  const same = (a: HandoffFact, b: HandoffFact): boolean => a.id === b.id && a.category === b.category && a.owner === b.owner && a.value === b.value && a.quote === b.quote && a.required === b.required && a.origin.messageId === b.origin.messageId && a.origin.step === b.origin.step
  if (required.some(fact => !doc.facts.some(candidate => same(candidate, fact)))) return null
  for (const fact of doc.facts) {
    if (previous.some(old => same(old, fact))) continue
    const source = messages.find(message => message.origin?.messageId === fact.origin.messageId && message.origin.step === fact.origin.step && message.role === 'user' && !message.internal)
    if (!source || fact.owner !== fact.origin.messageId || fact.value !== fact.quote || !extractTextFromContent(source.content).includes(fact.quote)) return null
  }
  return doc
}
