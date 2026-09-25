import { LEARNING_MAX_REFERENCES, LEARNING_MAX_TEXT_LENGTH } from './limits'

/** 停点创建时冻结的核对判据；持久化后不可修改。 */
export interface FrozenCheckpointRubric {
  readonly targetClaim: string
  readonly knowledgeRevision: string | null
  readonly verificationMethod: string
  readonly criteria: string
  readonly equivalenceHints?: string
}

export interface LearningFactReference {
  readonly receiptId: string
  readonly claim: string
}

export type LearningAssessVerdict = 'understanding_observed' | 'needs_clarification' | 'inconclusive'

/** learning_assess 工具载荷；帮助程度由服务端从 help 事件推导。 */
export interface LearningAssessSubmission {
  readonly attemptId: string
  readonly checkpointId: string
  readonly verdict: LearningAssessVerdict
  readonly summary: string
  readonly userQuote: string
  readonly factReferences: readonly LearningFactReference[]
}

function readBounded(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string') {
    throw new Error(`learning: ${field} 必须是字符串`)
  }
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > max) {
    throw new Error(`learning: ${field} 长度无效`)
  }
  return trimmed
}

export function parseFrozenCheckpointRubric(raw: unknown): FrozenCheckpointRubric {
  if (!raw || typeof raw !== 'object') {
    throw new Error('learning: rubric 必须是对象')
  }
  const value = raw as Record<string, unknown>
  const knowledgeRevision =
    value.knowledgeRevision === null
      ? null
      : typeof value.knowledgeRevision === 'string'
        ? value.knowledgeRevision.trim() || null
        : null
  const equivalenceHints =
    typeof value.equivalenceHints === 'string' && value.equivalenceHints.trim()
      ? value.equivalenceHints.trim()
      : undefined
  return {
    targetClaim: readBounded(value.targetClaim, 'targetClaim', LEARNING_MAX_TEXT_LENGTH),
    knowledgeRevision,
    verificationMethod: readBounded(value.verificationMethod, 'verificationMethod', LEARNING_MAX_TEXT_LENGTH),
    criteria: readBounded(value.criteria, 'criteria', LEARNING_MAX_TEXT_LENGTH),
    ...(equivalenceHints ? { equivalenceHints } : {})
  }
}

function parseFactReferences(raw: unknown): readonly LearningFactReference[] {
  if (!Array.isArray(raw)) {
    throw new Error('learning: factReferences 必须是数组')
  }
  if (raw.length > LEARNING_MAX_REFERENCES) {
    throw new Error('learning: factReferences 超出上限')
  }
  return raw.map((item, index) => {
    if (!item || typeof item !== 'object') {
      throw new Error(`learning: factReferences[${index}] 无效`)
    }
    const row = item as Record<string, unknown>
    return {
      receiptId: readBounded(row.receiptId, 'receiptId', 128),
      claim: readBounded(row.claim, 'claim', LEARNING_MAX_TEXT_LENGTH)
    }
  })
}

export function parseLearningAssessSubmission(raw: unknown): LearningAssessSubmission {
  if (!raw || typeof raw !== 'object') {
    throw new Error('learning: assess 载荷必须是对象')
  }
  const value = raw as Record<string, unknown>
  const verdict = value.verdict
  if (
    verdict !== 'understanding_observed' &&
    verdict !== 'needs_clarification' &&
    verdict !== 'inconclusive'
  ) {
    throw new Error('learning: verdict 无效')
  }
  return {
    attemptId: readBounded(value.attemptId, 'attemptId', 128),
    checkpointId: readBounded(value.checkpointId, 'checkpointId', 128),
    verdict,
    summary: readBounded(value.summary, 'summary', LEARNING_MAX_TEXT_LENGTH),
    userQuote: readBounded(value.userQuote, 'userQuote', LEARNING_MAX_TEXT_LENGTH),
    factReferences: parseFactReferences(value.factReferences ?? [])
  }
}
