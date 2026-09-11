import { createHash } from 'crypto'
import type { UsageSource } from '../../shared/model/types'
import { estimateTextTokens } from '../../shared/model/tokenEstimate'
import { estimateImageBlockBudgetTokens } from './imageTokens'

export const REQUEST_ESTIMATOR_VERSION = 4

/** 最终协议投影的无正文计量；前缀链用于验证纯追加。 */
export interface RequestBudgetMeasurement {
  routeId: string
  tokenizerId: 'unknown'
  contextWindow: number
  envelopeHash: string
  prefixHashes: string[]
  serializedBytes: number
  /** 文本 token 估算与视觉预留之和；不等于传输字节数。 */
  budgetUnits?: number
}

export interface RequestBudgetAnchor {
  estimatorVersion: 1 | 2 | 3 | 4
  revision: number
  routeId: string
  envelopeHash: string
  messageCount: number
  prefixHash: string
  serializedBytes: number
  budgetUnits?: number
  inputTokens: number
  source: UsageSource
}

const hash = (value: string): string => createHash('sha256').update(value).digest('hex')

export function parseRequestBudgetAnchor(value: unknown): RequestBudgetAnchor | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const a = value as Partial<RequestBudgetAnchor>
  const sha = (v: unknown): boolean => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)
  const integer = (v: unknown): boolean => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
  if ((a.estimatorVersion !== 1 && a.estimatorVersion !== 2 && a.estimatorVersion !== 3 && a.estimatorVersion !== 4) ||
      (a.budgetUnits !== undefined && !integer(a.budgetUnits)) ||
      (a.estimatorVersion !== 1 && !integer(a.budgetUnits)) ||
      !integer(a.revision) || !integer(a.messageCount) || !a.messageCount ||
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
  const serialized = JSON.stringify(body)
  const serializedBytes = Buffer.byteLength(serialized, 'utf8')
  let budgetUnits = estimateTextTokens(serialized)
  // 图片块按模型族规则替换 URL 文本的虚高估算；无可靠规则的模型维持原口径（保守高估方向）。
  const wireModel = typeof body.model === 'string' ? body.model : undefined
  for (const message of body.messages) {
    if (!message || typeof message !== 'object' || !Array.isArray(message.content)) continue
    for (const block of message.content) {
      if (block?.type !== 'image_url' || typeof block.image_url?.url !== 'string') continue
      const imageTokens = estimateImageBlockBudgetTokens(wireModel, block.image_url.url)
      if (imageTokens === null) continue
      budgetUnits += imageTokens - estimateTextTokens(JSON.stringify(block.image_url.url))
    }
  }
  return { routeId, tokenizerId: 'unknown', contextWindow,
    envelopeHash: hash(JSON.stringify({ ...body, messages: null })), prefixHashes,
    serializedBytes, budgetUnits }
}
