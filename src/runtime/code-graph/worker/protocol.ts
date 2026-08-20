import type {
  CodeGraphMetadata
} from '../graph/CodeGraphRepository'
import {
  CODE_INDEX_FAILURE_CODES,
  type CodeIndexCoverage,
  type CodeIndexFailure,
  type CodeIndexFailureCode,
  type CodeIndexOperation,
  type CodeIndexProgress
} from '../types'

export const CODE_INDEX_WORKER_IDLE_TIMEOUT_MS = 60_000
export const CODE_INDEX_WORKER_CANCEL_GRACE_MS = 5_000

export interface CodeIndexWorkerGrammarPaths {
  readonly javascript: string
  readonly typescript: string
  readonly tsx: string
  readonly python: string
}

export interface CodeIndexWorkerWorkspace {
  readonly workspaceIdentity: string
  readonly workspaceRoot: string
  readonly dbPath: string
  readonly parserSignature: string
  readonly resolverSignature: string
  readonly coreWasmPath: string
  readonly grammarWasmPaths: CodeIndexWorkerGrammarPaths
}

export interface CodeIndexWorkerRunRequest {
  readonly operation: CodeIndexOperation
  readonly workspace: CodeIndexWorkerWorkspace
}

export interface CodeIndexWorkerRunResult {
  readonly operation: CodeIndexOperation
  readonly metadata: CodeGraphMetadata
  readonly coverage: CodeIndexCoverage
  readonly durationMs: number
}

export interface CodeIndexWorkerRunOptions {
  readonly onProgress?: (progress: CodeIndexProgress) => void
}

/** Coordinator 只依赖这个运行端口，Worker 传输状态不暴露为索引真源。 */
export interface CodeIndexWorkerPort {
  run(
    request: CodeIndexWorkerRunRequest,
    options?: CodeIndexWorkerRunOptions
  ): Promise<CodeIndexWorkerRunResult>
  /** 只有当该 operation 已终止或 Worker 已被强制结束时才能 resolve。 */
  cancel(operationId: string): Promise<void>
  dispose(): Promise<void>
  onTerminalFailure(listener: (failure: CodeIndexFailure) => void): () => void
}

export class CodeIndexWorkerRunError extends Error {
  constructor(
    readonly failure: CodeIndexFailure,
    readonly committedMetadata: CodeGraphMetadata | null
  ) {
    super(failure.message)
    this.name = 'CodeIndexWorkerRunError'
  }
}

export class CodeIndexWorkerMissingError extends Error {
  readonly failure: CodeIndexFailure

  constructor(message: string) {
    super(message)
    this.name = 'CodeIndexWorkerMissingError'
    this.failure = Object.freeze({ code: 'worker_missing', message })
  }
}

export interface CodeIndexWorkerStartMessage {
  readonly kind: 'run'
  readonly requestId: number
  readonly request: CodeIndexWorkerRunRequest
}

export interface CodeIndexWorkerCancelMessage {
  readonly kind: 'cancel'
  readonly requestId: number
  readonly operationId: string
}

export type CodeIndexHostToWorkerMessage =
  | CodeIndexWorkerStartMessage
  | CodeIndexWorkerCancelMessage

export interface CodeIndexWorkerProgressMessage {
  readonly kind: 'progress'
  readonly requestId: number
  readonly operationId: string
  readonly progress: CodeIndexProgress
}

export interface CodeIndexWorkerResultMessage {
  readonly kind: 'result'
  readonly requestId: number
  readonly result: CodeIndexWorkerRunResult
}

export interface CodeIndexWorkerFailureMessage {
  readonly kind: 'failure'
  readonly requestId: number
  readonly operationId: string
  readonly failure: CodeIndexFailure
  readonly committedMetadata: CodeGraphMetadata | null
}

export type CodeIndexWorkerToHostMessage =
  | CodeIndexWorkerProgressMessage
  | CodeIndexWorkerResultMessage
  | CodeIndexWorkerFailureMessage

export function parseCodeIndexHostMessage(
  value: unknown
): CodeIndexHostToWorkerMessage | null {
  if (!isRecord(value)) return null
  const kind = Reflect.get(value, 'kind')
  const requestId = readPositiveInteger(value, 'requestId')
  if (requestId === null) return null
  if (kind === 'cancel') {
    const operationId = readNonEmptyString(value, 'operationId')
    return operationId === null
      ? null
      : Object.freeze({ kind, requestId, operationId })
  }
  if (kind !== 'run') return null
  const request = parseRunRequest(Reflect.get(value, 'request'))
  return request === null ? null : Object.freeze({ kind, requestId, request })
}

export function parseCodeIndexWorkerMessage(
  value: unknown
): CodeIndexWorkerToHostMessage | null {
  if (!isRecord(value)) return null
  const kind = Reflect.get(value, 'kind')
  const requestId = readPositiveInteger(value, 'requestId')
  if (requestId === null) return null
  if (kind === 'progress') {
    const operationId = readNonEmptyString(value, 'operationId')
    const progress = parseProgress(Reflect.get(value, 'progress'))
    return operationId === null || progress === null
      ? null
      : Object.freeze({ kind, requestId, operationId, progress })
  }
  if (kind === 'result') {
    const result = parseRunResult(Reflect.get(value, 'result'))
    return result === null ? null : Object.freeze({ kind, requestId, result })
  }
  if (kind !== 'failure') return null
  const operationId = readNonEmptyString(value, 'operationId')
  const failure = parseFailure(Reflect.get(value, 'failure'))
  const committedValue = Reflect.get(value, 'committedMetadata')
  const committedMetadata = committedValue === null
    ? null
    : parseMetadata(committedValue)
  if (
    operationId === null || failure === null ||
    (committedValue !== null && committedMetadata === null)
  ) return null
  return Object.freeze({
    kind,
    requestId,
    operationId,
    failure,
    committedMetadata
  })
}

function parseRunRequest(value: unknown): CodeIndexWorkerRunRequest | null {
  if (!isRecord(value)) return null
  const operation = parseOperation(Reflect.get(value, 'operation'))
  const workspace = parseWorkspace(Reflect.get(value, 'workspace'))
  if (operation === null || workspace === null) return null
  if (operation.workspaceIdentity !== workspace.workspaceIdentity) return null
  return Object.freeze({ operation, workspace })
}

function parseRunResult(value: unknown): CodeIndexWorkerRunResult | null {
  if (!isRecord(value)) return null
  const operation = parseOperation(Reflect.get(value, 'operation'))
  const metadata = parseMetadata(Reflect.get(value, 'metadata'))
  const coverage = parseCoverage(Reflect.get(value, 'coverage'))
  const durationMs = readNonNegativeNumber(value, 'durationMs')
  if (operation === null || metadata === null || coverage === null || durationMs === null) {
    return null
  }
  return Object.freeze({ operation, metadata, coverage, durationMs })
}

function parseWorkspace(value: unknown): CodeIndexWorkerWorkspace | null {
  if (!isRecord(value)) return null
  const workspaceIdentity = readNonEmptyString(value, 'workspaceIdentity')
  const workspaceRoot = readNonEmptyString(value, 'workspaceRoot')
  const dbPath = readNonEmptyString(value, 'dbPath')
  const parserSignature = readNonEmptyString(value, 'parserSignature')
  const resolverSignature = readNonEmptyString(value, 'resolverSignature')
  const coreWasmPath = readNonEmptyString(value, 'coreWasmPath')
  const grammarWasmPaths = parseGrammarPaths(Reflect.get(value, 'grammarWasmPaths'))
  if (
    workspaceIdentity === null || workspaceRoot === null || dbPath === null ||
    parserSignature === null || resolverSignature === null || coreWasmPath === null ||
    grammarWasmPaths === null
  ) return null
  return Object.freeze({
    workspaceIdentity,
    workspaceRoot,
    dbPath,
    parserSignature,
    resolverSignature,
    coreWasmPath,
    grammarWasmPaths
  })
}

function parseGrammarPaths(value: unknown): CodeIndexWorkerGrammarPaths | null {
  if (!isRecord(value)) return null
  const javascript = readNonEmptyString(value, 'javascript')
  const typescript = readNonEmptyString(value, 'typescript')
  const tsx = readNonEmptyString(value, 'tsx')
  const python = readNonEmptyString(value, 'python')
  if (javascript === null || typescript === null || tsx === null || python === null) {
    return null
  }
  return Object.freeze({ javascript, typescript, tsx, python })
}

function parseOperation(value: unknown): CodeIndexOperation | null {
  if (!isRecord(value)) return null
  const operationId = readNonEmptyString(value, 'operationId')
  const kind = Reflect.get(value, 'kind')
  const workspaceIdentity = readNonEmptyString(value, 'workspaceIdentity')
  const generation = readPositiveInteger(value, 'generation')
  const baseGenerationValue = Reflect.get(value, 'baseGeneration')
  const baseGeneration = baseGenerationValue === null
    ? null
    : readPositiveInteger(value, 'baseGeneration')
  const baseRevision = readNonNegativeInteger(value, 'baseRevision')
  if (
    operationId === null ||
    (kind !== 'full-rebuild' && kind !== 'incremental-update') ||
    workspaceIdentity === null || generation === null ||
    (baseGenerationValue !== null && baseGeneration === null) ||
    baseRevision === null
  ) return null
  return Object.freeze({
    operationId,
    kind,
    workspaceIdentity,
    generation,
    baseGeneration,
    baseRevision
  })
}

function parseMetadata(value: unknown): CodeGraphMetadata | null {
  if (!isRecord(value)) return null
  const schemaVersion = readPositiveInteger(value, 'schemaVersion')
  const workspaceIdentity = readNonEmptyString(value, 'workspaceIdentity')
  const activeValue = Reflect.get(value, 'activeGeneration')
  const activeGeneration = activeValue === null
    ? null
    : readPositiveInteger(value, 'activeGeneration')
  const revision = readNonNegativeInteger(value, 'revision')
  const parserSignature = readNonEmptyString(value, 'parserSignature')
  const resolverSignature = readNonEmptyString(value, 'resolverSignature')
  const completedValue = Reflect.get(value, 'lastCompletedAt')
  const lastCompletedAt = completedValue === null
    ? null
    : readNonNegativeNumber(value, 'lastCompletedAt')
  const lastAccessed = readNonNegativeNumber(value, 'lastAccessed')
  if (
    schemaVersion === null || workspaceIdentity === null ||
    (activeValue !== null && activeGeneration === null) || revision === null ||
    parserSignature === null || resolverSignature === null ||
    (completedValue !== null && lastCompletedAt === null) || lastAccessed === null
  ) return null
  return Object.freeze({
    schemaVersion,
    workspaceIdentity,
    activeGeneration,
    revision,
    parserSignature,
    resolverSignature,
    lastCompletedAt,
    lastAccessed
  })
}

function parseCoverage(value: unknown): CodeIndexCoverage | null {
  if (!isRecord(value)) return null
  const eligibleFiles = readNonNegativeInteger(value, 'eligibleFiles')
  const indexedFiles = readNonNegativeInteger(value, 'indexedFiles')
  const parseFailures = readNonNegativeInteger(value, 'parseFailures')
  const unsupportedFiles = readNonNegativeInteger(value, 'unsupportedFiles')
  const oversizedFiles = readNonNegativeInteger(value, 'oversizedFiles')
  const unresolvedRelations = readNonNegativeInteger(value, 'unresolvedRelations')
  if (
    eligibleFiles === null || indexedFiles === null || parseFailures === null ||
    unsupportedFiles === null || oversizedFiles === null || unresolvedRelations === null
  ) return null
  return Object.freeze({
    eligibleFiles,
    indexedFiles,
    parseFailures,
    unsupportedFiles,
    oversizedFiles,
    unresolvedRelations
  })
}

function parseProgress(value: unknown): CodeIndexProgress | null {
  if (!isRecord(value)) return null
  const completed = readNonNegativeInteger(value, 'completed')
  const total = readNonNegativeInteger(value, 'total')
  if (completed === null || total === null || completed > total) return null
  return Object.freeze({ completed, total })
}

function parseFailure(value: unknown): CodeIndexFailure | null {
  if (!isRecord(value)) return null
  const code = Reflect.get(value, 'code')
  const message = Reflect.get(value, 'message')
  if (!isFailureCode(code) || typeof message !== 'string' || message.length === 0) return null
  return Object.freeze({ code, message })
}

function isFailureCode(value: unknown): value is CodeIndexFailureCode {
  return typeof value === 'string' && CODE_INDEX_FAILURE_CODE_SET.has(value)
}

function readNonEmptyString(record: object, key: string): string | null {
  const value = Reflect.get(record, key)
  return typeof value === 'string' && value.length > 0 ? value : null
}

function readPositiveInteger(record: object, key: string): number | null {
  const value = Reflect.get(record, key)
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null
}

function readNonNegativeInteger(record: object, key: string): number | null {
  const value = Reflect.get(record, key)
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null
}

function readNonNegativeNumber(record: object, key: string): number | null {
  const value = Reflect.get(record, key)
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function isRecord(value: unknown): value is object {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const CODE_INDEX_FAILURE_CODE_SET: ReadonlySet<string> = new Set(
  CODE_INDEX_FAILURE_CODES
)
