import { createHash } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import * as path from 'node:path'
import {
  CODE_INDEX_MAX_SOURCE_BYTES,
  FileDiscoveryCancelledError,
  discoverCodeFiles,
  type DiscoveredCodeFile
} from '../indexing/FileDiscovery'
import {
  TREE_SITTER_PARSER_SIGNATURE,
  createTreeSitterParserRegistry,
  TreeSitterResourceError
} from '../parsing/TreeSitterParser'
import type { ParsedSourceFile } from '../parsing/ParserRegistry'
import {
  STRUCTURAL_RESOLVER_SIGNATURE,
  StructuralCodeGraphResolver
} from '../resolving/Resolver'
import {
  openBetterSqliteCodeGraph,
  type BetterSqliteCodeGraph
} from '../graph/BetterSqliteCodeGraph'
import type {
  CodeGraphFileInput,
  CodeGraphMetadata
} from '../graph/CodeGraphRepository'
import type {
  CodeIndexFailureCode,
  CodeIndexProgress
} from '../types'
import {
  CodeIndexBuildCancelledError,
  CodeIndexWorkScheduler,
  throwIfCodeIndexBuildCancelled,
  type CodeIndexWorkCancellation
} from './CodeIndexWorkScheduler'
import type {
  CodeIndexWorkerRunRequest,
  CodeIndexWorkerRunResult
} from './protocol'

export class CodeIndexWorkerBuildError extends Error {
  constructor(
    readonly code: CodeIndexFailureCode,
    message: string,
    readonly committedMetadata: CodeGraphMetadata | null = null,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = 'CodeIndexWorkerBuildError'
  }
}

export interface CodeIndexBuildRunnerOptions extends CodeIndexWorkCancellation {
  readonly cpuCount?: number
  readonly now?: () => number
  readonly onProgress?: (progress: CodeIndexProgress) => void
}

type FileBuildOutcome =
  | { readonly kind: 'parsed'; readonly file: ParsedSourceFile }
  | { readonly kind: 'additional'; readonly file: CodeGraphFileInput }

/** 从发现到 generation 提交的完整写路径，只能由 Index Worker 调用。 */
export async function runFullCodeIndexBuild(
  request: CodeIndexWorkerRunRequest,
  options: CodeIndexBuildRunnerOptions = {}
): Promise<CodeIndexWorkerRunResult> {
  assertRunRequest(request)
  const now = options.now ?? Date.now
  const startedAt = now()
  const cancellation: CodeIndexWorkCancellation = {
    abortSignal: options.abortSignal,
    isAborted: options.isAborted
  }
  try {
    throwIfCodeIndexBuildCancelled(cancellation)
  } catch (error) {
    throw normalizeBuildError(error, null)
  }

  let repository: BetterSqliteCodeGraph
  try {
    repository = openBetterSqliteCodeGraph({
      dbPath: request.workspace.dbPath,
      workspaceIdentity: request.workspace.workspaceIdentity,
      parserSignature: request.workspace.parserSignature,
      resolverSignature: request.workspace.resolverSignature,
      now
    })
  } catch (error) {
    throw buildError('storage_open_failed', '代码索引数据库无法打开', error)
  }

  let result: CodeIndexWorkerRunResult
  try {
    result = await buildAndCommit(request, repository, cancellation, options, startedAt, now)
  } catch (error) {
    try {
      await repository.close()
    } catch (closeError) {
      throw buildError(
        'fence_release_failed',
        '代码索引失败后无法关闭写连接',
        new AggregateError([error, closeError])
      )
    }
    throw error
  }
  try {
    await repository.close()
  } catch (error) {
    throw buildError(
      'storage_read_failed',
      '代码索引已提交，但写连接关闭失败',
      error,
      result.metadata
    )
  }
  return result
}

async function buildAndCommit(
  request: CodeIndexWorkerRunRequest,
  repository: BetterSqliteCodeGraph,
  cancellation: CodeIndexWorkCancellation,
  options: CodeIndexBuildRunnerOptions,
  startedAt: number,
  now: () => number
): Promise<CodeIndexWorkerRunResult> {
  const operation = request.operation
  let claimed = false
  let staged = false
  let committedMetadata: CodeGraphMetadata | null = null
  try {
    try {
      await repository.claimOperation(operation)
      claimed = true
    } catch (error) {
      throw buildError('storage_commit_failed', '代码索引写入 fence 无法签发', error)
    }

    const parser = await createParser(request)
    const resolver = new StructuralCodeGraphResolver()
    if (resolver.signature !== request.workspace.resolverSignature) {
      throw new CodeIndexWorkerBuildError(
        'parser_failure',
        '代码索引 resolver signature 与 Worker 资源不一致'
      )
    }
    throwIfCodeIndexBuildCancelled(cancellation)

    const discovery = await runBuildPhase(
      () => discoverCodeFiles({
        workspaceRoot: request.workspace.workspaceRoot,
        abortSignal: options.abortSignal
      }),
      'parser_failure',
      '代码文件发现失败'
    )
    reportProgress(options.onProgress, { completed: 0, total: discovery.files.length })

    const scheduler = new CodeIndexWorkScheduler({ cpuCount: options.cpuCount })
    let completed = 0
    const outcomes = await scheduler.map(
      discovery.files,
      async (file) => {
        const outcome = await buildFile(
          request.workspace.workspaceRoot,
          file,
          parser,
          cancellation
        )
        completed += 1
        reportProgress(options.onProgress, {
          completed,
          total: discovery.files.length
        })
        return outcome
      },
      cancellation
    )
    throwIfCodeIndexBuildCancelled(cancellation)

    const parsedFiles = outcomes.flatMap((outcome) =>
      outcome.kind === 'parsed' ? [outcome.file] : []
    )
    const additionalFiles = outcomes.flatMap((outcome) =>
      outcome.kind === 'additional' ? [outcome.file] : []
    )
    const generation = await runBuildPhase(
      () => resolver.resolve(
        {
          workspaceRoot: request.workspace.workspaceRoot,
          operationId: operation.operationId,
          generation: operation.generation,
          parserSignature: parser.signature,
          stagedAt: now(),
          parsedFiles,
          additionalFiles,
          configFiles: discovery.configFiles,
          mtimeMsByPath: new Map(discovery.files.map((file) => [file.path, file.mtimeMs]))
        },
        {
          throwIfCancelled: () => throwIfCodeIndexBuildCancelled(cancellation)
        }
      ),
      'parser_failure',
      '代码关系解析失败'
    )
    throwIfCodeIndexBuildCancelled(cancellation)

    try {
      await repository.stageGeneration(generation)
      staged = true
      throwIfCodeIndexBuildCancelled(cancellation)
      committedMetadata = await repository.activateGeneration({
        operationId: operation.operationId,
        workspaceIdentity: operation.workspaceIdentity,
        generation: operation.generation,
        expectedActiveGeneration: operation.baseGeneration,
        expectedRevision: operation.baseRevision,
        completedAt: now()
      })
      claimed = false
    } catch (error) {
      if (error instanceof CodeIndexBuildCancelledError) throw error
      throw buildError('storage_commit_failed', '代码索引 generation 提交失败', error)
    }

    try {
      const coverage = await repository.getCoverage(committedMetadata.activeGeneration)
      return Object.freeze({
        operation,
        metadata: committedMetadata,
        coverage,
        durationMs: Math.max(0, now() - startedAt)
      })
    } catch (error) {
      throw buildError(
        'storage_read_failed',
        '代码索引已提交，但 coverage 读取失败',
        error,
        committedMetadata
      )
    }
  } catch (error) {
    const cleanupError = await cleanupFailedBuild(
      repository,
      operation,
      claimed,
      staged,
      committedMetadata
    )
    if (cleanupError) {
      throw buildError(
        'fence_release_failed',
        '代码索引失败后无法释放写入 fence',
        new AggregateError([error, cleanupError])
      )
    }
    throw normalizeBuildError(error, committedMetadata)
  }
}

async function createParser(request: CodeIndexWorkerRunRequest) {
  try {
    const parser = await createTreeSitterParserRegistry({
      coreWasmPath: request.workspace.coreWasmPath,
      grammarWasmPaths: request.workspace.grammarWasmPaths
    })
    if (parser.signature !== request.workspace.parserSignature) {
      throw new Error('parser signature 不一致')
    }
    return parser
  } catch (error) {
    if (error instanceof TreeSitterResourceError) {
      throw buildError('grammar_missing', error.message, error)
    }
    throw normalizeBuildError(error, null)
  }
}

async function buildFile(
  workspaceRoot: string,
  file: DiscoveredCodeFile,
  parser: Awaited<ReturnType<typeof createTreeSitterParserRegistry>>,
  cancellation: CodeIndexWorkCancellation
): Promise<FileBuildOutcome> {
  throwIfCodeIndexBuildCancelled(cancellation)
  if (file.status !== 'eligible') {
    return { kind: 'additional', file: skippedFile(file) }
  }
  if (file.language === 'unsupported') {
    throw new Error(`eligible 文件不能使用 unsupported 语言：${file.path}`)
  }

  let source: string
  try {
    source = await readWorkspaceSource(workspaceRoot, file.path)
  } catch {
    return { kind: 'additional', file: failedFile(file, null) }
  }
  throwIfCodeIndexBuildCancelled(cancellation)
  if (Buffer.byteLength(source, 'utf8') > CODE_INDEX_MAX_SOURCE_BYTES) {
    return {
      kind: 'additional',
      file: skippedFile({
        ...file,
        sizeBytes: Buffer.byteLength(source, 'utf8'),
        status: 'skipped_too_large'
      })
    }
  }
  try {
    return {
      kind: 'parsed',
      file: await parser.parse({ path: file.path, language: file.language, source })
    }
  } catch (error) {
    if (error instanceof TreeSitterResourceError) throw error
    if (error instanceof CodeIndexBuildCancelledError) throw error
    return { kind: 'additional', file: failedFile(file, source) }
  }
}

async function readWorkspaceSource(workspaceRoot: string, relativePath: string): Promise<string> {
  const root = await realpath(path.resolve(workspaceRoot))
  const target = await realpath(path.resolve(root, ...relativePath.split('/')))
  const relative = path.relative(root, target)
  // 读取前再做 realpath fence，避免发现后 symlink/junction 被替换。
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('源文件真实路径越出 workspace')
  }
  return (await readFile(target)).toString('utf8')
}

function skippedFile(file: DiscoveredCodeFile): CodeGraphFileInput {
  return Object.freeze({
    path: file.path,
    language: file.language,
    contentHash: metadataHash(file),
    sizeBytes: file.sizeBytes,
    mtimeMs: file.mtimeMs,
    lineCount: 0,
    parseStatus: file.status === 'unsupported' ? 'unsupported' : 'skipped_too_large'
  })
}

function failedFile(file: DiscoveredCodeFile, source: string | null): CodeGraphFileInput {
  return Object.freeze({
    path: file.path,
    language: file.language,
    contentHash: source === null
      ? metadataHash(file)
      : createHash('sha256').update(source).digest('hex'),
    sizeBytes: source === null ? file.sizeBytes : Buffer.byteLength(source, 'utf8'),
    mtimeMs: file.mtimeMs,
    lineCount: source === null ? 0 : source.split('\n').length,
    parseStatus: 'failed'
  })
}

function metadataHash(file: DiscoveredCodeFile): string {
  return createHash('sha256')
    .update(`unread:${file.status}:${file.sizeBytes}:${file.mtimeMs}`)
    .digest('hex')
}

async function cleanupFailedBuild(
  repository: BetterSqliteCodeGraph,
  operation: CodeIndexWorkerRunRequest['operation'],
  claimed: boolean,
  staged: boolean,
  committedMetadata: CodeGraphMetadata | null
): Promise<unknown | null> {
  const errors: unknown[] = []
  if (claimed) {
    try {
      await repository.releaseOperation(operation)
    } catch (error) {
      errors.push(error)
    }
  }
  if (staged && committedMetadata === null) {
    try {
      await repository.deleteGeneration(operation.generation)
    } catch (error) {
      errors.push(error)
    }
  }
  return errors.length === 0 ? null : new AggregateError(errors)
}

async function runBuildPhase<T>(
  work: () => Promise<T>,
  code: CodeIndexFailureCode,
  message: string
): Promise<T> {
  try {
    return await work()
  } catch (error) {
    if (
      error instanceof CodeIndexWorkerBuildError ||
      error instanceof CodeIndexBuildCancelledError ||
      error instanceof TreeSitterResourceError
    ) throw error
    if (error instanceof FileDiscoveryCancelledError) {
      throw new CodeIndexBuildCancelledError()
    }
    throw buildError(code, message, error)
  }
}

function normalizeBuildError(
  error: unknown,
  committedMetadata: CodeGraphMetadata | null
): CodeIndexWorkerBuildError {
  if (error instanceof CodeIndexWorkerBuildError) return error
  if (error instanceof CodeIndexBuildCancelledError) {
    return buildError('build_cancelled', error.message, error, committedMetadata)
  }
  if (error instanceof FileDiscoveryCancelledError) {
    return buildError('build_cancelled', error.message, error, committedMetadata)
  }
  if (error instanceof TreeSitterResourceError) {
    return buildError('grammar_missing', error.message, error, committedMetadata)
  }
  return buildError('parser_failure', errorMessage(error), error, committedMetadata)
}

function buildError(
  code: CodeIndexFailureCode,
  message: string,
  cause?: unknown,
  committedMetadata: CodeGraphMetadata | null = null
): CodeIndexWorkerBuildError {
  return new CodeIndexWorkerBuildError(
    code,
    cause === undefined ? message : `${message}：${errorMessage(cause)}`,
    committedMetadata,
    cause === undefined ? undefined : { cause }
  )
}

function reportProgress(
  listener: CodeIndexBuildRunnerOptions['onProgress'],
  progress: CodeIndexProgress
): void {
  try {
    listener?.(Object.freeze(progress))
  } catch {
    // 进度观察者不能中断索引事务。
  }
}

function assertRunRequest(request: CodeIndexWorkerRunRequest): void {
  if (request.operation.kind !== 'full-rebuild') {
    throw new CodeIndexWorkerBuildError('parser_failure', 'Worker 当前请求不是 full rebuild')
  }
  if (request.operation.workspaceIdentity !== request.workspace.workspaceIdentity) {
    throw new CodeIndexWorkerBuildError('stale_result_rejected', 'Worker workspace identity 不匹配')
  }
  for (const [field, value] of Object.entries({
    workspaceRoot: request.workspace.workspaceRoot,
    dbPath: request.workspace.dbPath,
    coreWasmPath: request.workspace.coreWasmPath,
    ...request.workspace.grammarWasmPaths
  })) {
    if (!path.isAbsolute(value)) {
      throw new CodeIndexWorkerBuildError('worker_missing', `Worker 资源路径 ${field} 必须是绝对路径`)
    }
  }
  if (request.workspace.resolverSignature !== STRUCTURAL_RESOLVER_SIGNATURE) {
    throw new CodeIndexWorkerBuildError('parser_failure', 'Worker resolver signature 不受支持')
  }
  if (request.workspace.parserSignature !== TREE_SITTER_PARSER_SIGNATURE) {
    throw new CodeIndexWorkerBuildError('parser_failure', 'Worker parser signature 不受支持')
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
