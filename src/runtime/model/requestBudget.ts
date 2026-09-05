import { createHash } from 'crypto'
import type { UsageSource } from '../../shared/model/types'

export const REQUEST_ESTIMATOR_VERSION = 1

/** 最终协议投影的无正文计量；前缀链用于验证纯追加。 */
export interface RequestBudgetMeasurement {
  routeId: string
  tokenizerId: 'unknown'
  contextWindow: number
  envelopeHash: string
  prefixHashes: string[]
  serializedBytes: number
}

export interface RequestBudgetAnchor {
  estimatorVersion: 1
  revision: number
  routeId: string
  envelopeHash: string
  messageCount: number
  prefixHash: string
  serializedBytes: number
  inputTokens: number
  source: UsageSource
}

const hash = (value: string): string => createHash('sha256').update(value).digest('hex')

export function parseRequestBudgetAnchor(value: unknown): RequestBudgetAnchor | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const a = value as Partial<RequestBudgetAnchor>
  const sha = (v: unknown): boolean => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)
  const integer = (v: unknown): boolean => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
  if (a.estimatorVersion !== 1 || !integer(a.revision) || !integer(a.messageCount) || !a.messageCount ||
      !integer(a.serializedBytes) || !integer(a.inputTokens) || !a.inputTokens ||
      typeof a.routeId !== 'string' || !a.routeId || !sha(a.envelopeHash) || !sha(a.prefixHash) ||
      !a.source || a.source.purpose !== 'main' || a.source.routeId !== a.routeId ||
      typeof a.source.logicalRequestId !== 'string' || !a.source.logicalRequestId ||
      typeof a.source.physicalAttemptId !== 'string' || !a.source.physicalAttemptId) return null
  return a as RequestBudgetAnchor
}

export function measureRequestBudget(body: Record<string, unknown>, routeId: string, contextWindow: number): RequestBudgetMeasurement {
  if (!Array.isArray(body.messages)) throw new Error('Request messages must be an array')
  let prefix = ''
  const prefixHashes = body.messages.map((message: unknown) => {
    prefix = hash(prefix + JSON.stringify(message))
    return prefix
  })
  return { routeId, tokenizerId: 'unknown', contextWindow,
    envelopeHash: hash(JSON.stringify({ ...body, messages: null })), prefixHashes,
    serializedBytes: Buffer.byteLength(JSON.stringify(body), 'utf8') }
}
