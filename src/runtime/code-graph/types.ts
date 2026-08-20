export type CodeIndexStatus =
  | 'idle'
  | 'building'
  | 'ready'
  | 'updating'
  | 'degraded'
  | 'unavailable'

export type CodeEvidenceConfidence = 'confirmed' | 'probable' | 'heuristic'

export type CodeGraphLanguage =
  | 'typescript'
  | 'tsx'
  | 'javascript'
  | 'jsx'
  | 'mjs'
  | 'cjs'
  | 'python'
  | 'unsupported'

export type CodeFileParseStatus =
  | 'parsed'
  | 'failed'
  | 'unsupported'
  | 'skipped_too_large'

export type CodeSymbolKind =
  | 'module'
  | 'class'
  | 'interface'
  | 'function'
  | 'method'
  | 'constructor'
  | 'property'
  | 'variable'
  | 'constant'
  | 'type'
  | 'enum'
  | 'enum_member'

export type CodeFileEdgeKind = 'imports' | 're_exports' | 'test_of'

export type CodeSymbolEdgeKind =
  | 'calls'
  | 'references'
  | 'extends'
  | 'implements'
  | 'overrides'

export type CodeRelationResolver =
  | 'structural'
  | 'relative-path'
  | 'tsconfig-paths'
  | 'index-re-export'
  | 'python-import'
  | 'test-convention'

export type CodeUnresolvedRelationKind = CodeFileEdgeKind | CodeSymbolEdgeKind

export type CodeUnresolvedReason =
  | 'external_module'
  | 'no_matching_file'
  | 'ambiguous_module'
  | 'export_not_found'
  | 'ambiguous_export'
  | 'dynamic_dispatch'
  | 'same_file_target_ambiguous'
  | 'reexport_depth_exceeded'
  | 'shadowed_import_binding'
  | 'unsupported_project_reference'
  | 'unsupported_conditional_export'

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

export interface CodeIndexSnapshot {
  readonly workspaceIdentity: string | null
  readonly activeGeneration: number | null
  readonly revision: number
  readonly status: CodeIndexStatus
  readonly coverage: CodeIndexCoverage
  readonly progress: CodeIndexProgress | null
  readonly lastCompletedAt: number | null
  readonly failure: CodeIndexFailure | null
}

export type CodeIndexOperationKind = 'full-rebuild' | 'incremental-update'

export interface CodeIndexOperation {
  readonly operationId: string
  readonly kind: CodeIndexOperationKind
  readonly workspaceIdentity: string
  readonly generation: number
  readonly baseGeneration: number | null
  readonly baseRevision: number
}

export const EMPTY_CODE_INDEX_COVERAGE: CodeIndexCoverage = Object.freeze({
  eligibleFiles: 0,
  indexedFiles: 0,
  parseFailures: 0,
  unsupportedFiles: 0,
  oversizedFiles: 0,
  unresolvedRelations: 0
})
