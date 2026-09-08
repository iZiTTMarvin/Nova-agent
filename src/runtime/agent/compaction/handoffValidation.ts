import { createHash } from 'crypto'
import { extractTextFromContent, type ChatMessage } from '../../model/types'
import { parseStructuredHandoff, type HandoffFact, type StructuredHandoff } from '../../sessions'

function parseCandidate(text: string): StructuredHandoff | null {
  const trimmed = text.trim()
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(trimmed)
  try { return parseStructuredHandoff(JSON.parse(fenced ? fenced[1] : trimmed)) } catch { return null }
}

/** 必需原句由程序填入；模型提供的事实仍须逐项核验，不覆盖冲突字段。 */
export function completeHandoff(text: string, messages: readonly ChatMessage[], required: readonly HandoffFact[], previous: readonly HandoffFact[]): StructuredHandoff | null {
  const candidate = parseCandidate(text)
  if (!candidate) return null
  const ids = new Set(candidate.facts.map(fact => fact.id))
  candidate.facts.push(...required.filter(fact => !ids.has(fact.id)))
  return validateHandoff(JSON.stringify(candidate), messages, required, previous)
}

/** 原始用户约束逐句保留；模型不能自行缩减必需集合。 */
export function collectRequiredFacts(messages: readonly ChatMessage[], previous: readonly HandoffFact[]): HandoffFact[] {
  const facts = new Map(previous.filter(fact => fact.required).map(fact => [fact.id, fact]))
  const task = messages.find(message => message.role === 'user' && !message.internal && !message.contextInstruction)
  for (const message of messages) {
    if (message.role !== 'user' || message.internal || message.contextInstruction || !message.origin) continue
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
  const doc = parseCandidate(text)
  if (!doc) return null
  const same = (a: HandoffFact, b: HandoffFact): boolean => a.id === b.id && a.category === b.category && a.owner === b.owner && a.value === b.value && a.quote === b.quote && a.required === b.required && a.origin.messageId === b.origin.messageId && a.origin.step === b.origin.step
  if (required.some(fact => !doc.facts.some(candidate => same(candidate, fact)))) return null
  for (const fact of doc.facts) {
    if (previous.some(old => same(old, fact))) continue
    const source = messages.find(message => message.origin?.messageId === fact.origin.messageId && message.origin.step === fact.origin.step && message.role === 'user' && !message.internal && !message.contextInstruction)
    if (!source || fact.owner !== fact.origin.messageId || fact.value !== fact.quote || !extractTextFromContent(source.content).includes(fact.quote)) return null
  }
  return doc
}
