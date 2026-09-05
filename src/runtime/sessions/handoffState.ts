import type { HandoffFact, StructuredHandoff } from './types'

export function parseStructuredHandoff(value: unknown): StructuredHandoff | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const doc = value as Record<string, unknown>
  const sections = ['goal', 'nextActions', 'keyContext', 'progress', 'decisions'] as const
  if (doc.schemaVersion !== 1 || sections.some(key => typeof doc[key] !== 'string' || !doc[key].trim()) || !Array.isArray(doc.facts)) return null
  const facts: HandoffFact[] = []
  const ids = new Set<string>()
  for (const raw of doc.facts) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const fact = raw as Record<string, unknown>
    const origin = fact.origin
    if (!origin || typeof origin !== 'object' || Array.isArray(origin)) return null
    const coordinate = origin as Record<string, unknown>
    if (typeof coordinate.messageId !== 'string' || !coordinate.messageId || !Number.isSafeInteger(coordinate.step) || Number(coordinate.step) < 0) return null
    if (typeof fact.id !== 'string' || !fact.id || ids.has(fact.id) ||
      typeof fact.owner !== 'string' || !fact.owner || typeof fact.value !== 'string' || !fact.value.trim() ||
      typeof fact.quote !== 'string' || !fact.quote.trim() || typeof fact.required !== 'boolean') return null
    const category = fact.category
    if (category !== 'task' && category !== 'constraint' && category !== 'decision' && category !== 'failure' && category !== 'todo') return null
    ids.add(fact.id)
    facts.push({ id: fact.id, owner: fact.owner, value: fact.value, quote: fact.quote, required: fact.required,
      category, origin: { messageId: coordinate.messageId, step: Number(coordinate.step) } })
  }
  return { schemaVersion: 1, goal: String(doc.goal), nextActions: String(doc.nextActions), keyContext: String(doc.keyContext),
    progress: String(doc.progress), decisions: String(doc.decisions), facts }
}

export function renderStructuredHandoff(doc: StructuredHandoff): string {
  return [`## 目标\n${doc.goal}`, `## 下一步\n${doc.nextActions}`, `## 关键上下文\n${doc.keyContext}`,
    `## 进展\n${doc.progress}`, `## 关键决策\n${doc.decisions}`,
    ...doc.facts.map(fact => `[${fact.id}; ${fact.category}; ${fact.owner}; #${fact.origin.messageId}:${fact.origin.step}] ${fact.value}`)].join('\n\n')
}
