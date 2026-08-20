import {
  CODE_INDEX_FAILURE_CODES,
  EMPTY_CODE_INDEX_COVERAGE
} from '../../shared/code-index'
import type {
  CodeIndexCoverage,
  CodeIndexFailure,
  CodeIndexFailureCode,
  CodeIndexProgress,
  CodeIndexStatus,
  CodeIndexWorkerState
} from '../../shared/code-index'

export { CODE_INDEX_FAILURE_CODES, EMPTY_CODE_INDEX_COVERAGE }
export type {
  CodeIndexCoverage,
  CodeIndexFailure,
  CodeIndexFailureCode,
  CodeIndexProgress,
  CodeIndexStatus,
  CodeIndexWorkerState
}

export type CodeContextIntent = 'locate' | 'understand' | 'impact'
export type CodeContextRequestedIntent = CodeContextIntent | 'flow'

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

export interface CodeIndexSnapshot {
  readonly workspaceIdentity: string | null
  readonly activeGeneration: number | null
  readonly revision: number
  readonly status: CodeIndexStatus
  readonly coverage: CodeIndexCoverage
  readonly progress: CodeIndexProgress | null
  readonly lastCompletedAt: number | null
  readonly failure: CodeIndexFailure | null
  readonly workerState: CodeIndexWorkerState
}

export type CodeIndexOperationKind =
  | 'full-rebuild'
  | 'incremental-update'
  | 'touch-access'

export interface CodeIndexOperation {
  readonly operationId: string
  readonly kind: CodeIndexOperationKind
  readonly workspaceIdentity: string
  readonly generation: number
  readonly baseGeneration: number | null
  readonly baseRevision: number
}
