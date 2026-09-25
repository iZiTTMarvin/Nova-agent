import { LEARNING_MAX_REFERENCES, LEARNING_MAX_TEXT_LENGTH } from './limits'

export type KnowledgeClaim =
  | { readonly kind: 'source_fact'; readonly text: string; readonly sourceIds: readonly string[] }
  | {
      readonly kind: 'inference'
      readonly text: string
      readonly sourceIds: readonly string[]
      readonly uncertainty: string
    }
  | { readonly kind: 'general_explanation'; readonly text: string }
  | { readonly kind: 'unverified'; readonly question: string; readonly missingEvidence: string }

function readNonEmptyString(value: unknown, field: string, maxLen: number): string {
  if (typeof value !== 'string') throw new Error(`${field} 无效`)
  const trimmed = value.trim()
  if (!trimmed) throw new Error(`${field} 无效`)
  if (trimmed.length > maxLen) throw new Error(`${field} 过长`)
  return trimmed
}

function readSourceIds(value: unknown): readonly string[] {
  if (!Array.isArray(value)) throw new Error('sourceIds 必须是数组')
  if (value.length > LEARNING_MAX_REFERENCES) throw new Error('sourceIds 过多')
  return value.map((item, index) => readNonEmptyString(item, `sourceIds[${index}]`, 128))
}

export function parseKnowledgeClaim(raw: unknown): KnowledgeClaim {
  if (!raw || typeof raw !== 'object') throw new Error('KnowledgeClaim 无效')
  const row = raw as Record<string, unknown>
  const kind = row.kind
  if (kind === 'source_fact') {
    return {
      kind: 'source_fact',
      text: readNonEmptyString(row.text, 'text', LEARNING_MAX_TEXT_LENGTH),
      sourceIds: readSourceIds(row.sourceIds)
    }
  }
  if (kind === 'inference') {
    return {
      kind: 'inference',
      text: readNonEmptyString(row.text, 'text', LEARNING_MAX_TEXT_LENGTH),
      sourceIds: readSourceIds(row.sourceIds),
      uncertainty: readNonEmptyString(row.uncertainty, 'uncertainty', LEARNING_MAX_TEXT_LENGTH)
    }
  }
  if (kind === 'general_explanation') {
    return {
      kind: 'general_explanation',
      text: readNonEmptyString(row.text, 'text', LEARNING_MAX_TEXT_LENGTH)
    }
  }
  if (kind === 'unverified') {
    return {
      kind: 'unverified',
      question: readNonEmptyString(row.question, 'question', LEARNING_MAX_TEXT_LENGTH),
      missingEvidence: readNonEmptyString(row.missingEvidence, 'missingEvidence', LEARNING_MAX_TEXT_LENGTH)
    }
  }
  throw new Error('KnowledgeClaim kind 无效')
}

export function parseKnowledgeClaims(raw: unknown): readonly KnowledgeClaim[] {
  if (!Array.isArray(raw)) throw new Error('claims 必须是数组')
  return raw.map((item, index) => {
    try {
      return parseKnowledgeClaim(item)
    } catch (e) {
      throw new Error(`claims[${index}]: ${e instanceof Error ? e.message : String(e)}`)
    }
  })
}
