export type GrepOutputMode = 'content' | 'files_with_matches' | 'count'

export type TruncationStage = 'match_count' | 'byte_size' | 'line_length'

export interface TruncationMeta {
  truncatedAt: TruncationStage
  shown: number
  total?: number
  limit: number
}

export interface TruncationResult {
  output: string
  truncated: boolean
  meta?: TruncationMeta
}

export interface GrepInput {
  pattern: string
  path?: string
  output_mode?: GrepOutputMode
  glob?: string
  '-A'?: number
  '-B'?: number
  '-C'?: number
  head_limit?: number
  offset?: number
  multiline?: boolean
  type?: string
}

export interface GrepToolOptions {
  maxResultSizeChars?: number
}
