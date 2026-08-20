export type CodeIndexStatus =
  | 'idle'
  | 'building'
  | 'ready'
  | 'updating'
  | 'degraded'
  | 'unavailable'

export type CodeIndexWorkerState = 'stopped' | 'running' | 'idle' | 'failed'

export interface CodeIndexCoverage {
  readonly eligibleFiles: number
  readonly indexedFiles: number
  readonly parseFailures: number
  readonly unsupportedFiles: number
  readonly oversizedFiles: number
  readonly unresolvedRelations: number
}

export interface CodeIndexProgress {
  readonly completed: number
  readonly total: number
}

export const CODE_INDEX_FAILURE_CODES = Object.freeze([
  'worker_missing',
  'grammar_missing',
  'db_corrupt',
  'parser_failure',
  'resolver_timeout',
  'build_cancelled',
  'stale_result_rejected',
  'bulk_change_rebuild',
  'worker_crash',
  'watcher_failed',
  'storage_open_failed',
  'storage_commit_failed',
  'storage_read_failed',
  'fence_release_failed'
] as const)

export type CodeIndexFailureCode = (typeof CODE_INDEX_FAILURE_CODES)[number]

export interface CodeIndexFailure {
  readonly code: CodeIndexFailureCode
  readonly message: string
}

export const EMPTY_CODE_INDEX_COVERAGE: CodeIndexCoverage = Object.freeze({
  eligibleFiles: 0,
  indexedFiles: 0,
  parseFailures: 0,
  unsupportedFiles: 0,
  oversizedFiles: 0,
  unresolvedRelations: 0
})

/** Main 投影的工作区级索引快照；Renderer 只能消费，不得回写领域状态。 */
export interface CodeIndexStatusDto {
  readonly workspaceRoot: string | null
  readonly sequence: number
  readonly enabled: boolean
  readonly status: CodeIndexStatus
  readonly activeGeneration: number | null
  readonly revision: number
  readonly coverage: CodeIndexCoverage
  readonly progress: CodeIndexProgress | null
  readonly lastCompletedAt: number | null
  readonly failure: CodeIndexFailure | null
  readonly workerState: CodeIndexWorkerState
  readonly databaseBytes: number
}
