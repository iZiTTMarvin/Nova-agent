import type { ModelClient } from '../../../model/ModelClient'
import type { JsonValue } from '../../../../shared/tools/types'

export const MAX_EXTRACTION_FIELDS = 16
export const MAX_EXTRACTION_PAGE_CHARS = 200_000
export const EXTRACTION_TIMEOUT_MS = 30_000

export type ExtractItemType = 'text' | 'number' | 'date'

export interface FieldSpec {
  type: 'text' | 'number' | 'date' | 'time' | 'datetime' | 'duration' | 'list'
  integer?: true
  unit?: string
  items?: ExtractItemType
  instructions?: string
}

export type SourceEvidence = {
  /** 1-based line in the normalized Markdown/plain-text page, not the original HTML. */
  line: number
  text: string
}

export type FieldResult =
  | { status: 'extracted'; value: JsonValue; confidence: number; evidence?: SourceEvidence }
  | {
      status: 'uncertain'
      guess: JsonValue
      confidence?: number
      evidence?: SourceEvidence
      notFound?: true
    }
  | { status: 'null' }

export type ExtractionProviderName = 'clairic' | 'current-model'

export type PageExtraction =
  | { provider: ExtractionProviderName; fields: Record<string, FieldResult>; cut: boolean }
  | { provider: ExtractionProviderName; error: string }

export interface ExtractionProviderResponse {
  answers: Record<string, unknown>
  truncated?: boolean
}

export interface ExtractionRequest {
  page: string
  fields: Record<string, FieldSpec>
  referenceDate: string
  signal: AbortSignal
}

/** A real seam: Clairic and the current chat model share validation, citation and cache logic. */
export interface FieldExtractionProvider {
  readonly name: ExtractionProviderName
  readonly cacheKey: string
  readonly maxEstimatedTokens?: number
  extract(request: ExtractionRequest): Promise<ExtractionProviderResponse>
}

export interface FieldExtractionContext {
  modelClient?: ModelClient
  contextWindow?: number
  runId?: string
  sessionId?: string
  env?: Record<string, string | undefined>
}
