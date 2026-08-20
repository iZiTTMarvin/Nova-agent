import { createHash } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import * as path from 'node:path'
import {
  CODE_INDEX_MAX_SOURCE_BYTES,
  FileDiscoveryCancelledError,
  discoverCodeFiles,
  inspectCodeFile,
  type DiscoveredCodeFile
} from '../indexing/FileDiscovery'
import {
  planCodeGraphDrift
} from '../indexing/CodeGraphDrift'
import {
  planWorkspaceChanges,
  shouldUseFullRebuild
} from '../indexing/ChangePlanner'
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
import { CODE_GRAPH_SCHEMA_VERSION } from '../graph/schema/CodeGraphMigrations'
import type {
  CodeGraphFileInput,
  CodeGraphFileMetadataUpdate,
  CodeGraphFileRecord,
  CodeGraphGenerationInput,
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

export async function runCodeIndexWork(
  request: CodeIndexWorkerRunRequest,
  options: CodeIndexBuildRunnerOptions = {}
): Promise<CodeIndexWorkerRunResult> {
  switch (request.operation.kind) {
    case 'full-rebuild':
      return runFullCodeIndexBuild(request, options)
    case 'incremental-update':
      return runIncrementalCodeIndexBuild(request, options)
    case 'touch-access':
      return runCodeIndexTouchAccess(request, options)
  }
}

export async function runCodeIndexTouchAccess(
  request: CodeIndexWorkerRunRequest,
  options: CodeIndexBuildRunnerOptions = {}
): Promise<CodeIndexWorkerRunResult> {
  assertRunRequest(request)
  if (request.operation.kind !== 'touch-access' || request.accessedAt === undefined) {
    throw new CodeIndexWorkerBuildError('storage_commit_failed', 'Worker 访问时间请求不完整')
  }
  const now = options.now ?? Date.now
  const startedAt = now()
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

  try {
    await repository.touchAccess(request.accessedAt)
    const metadata = await repository.getMetadata()
    const coverage = await repository.getCoverage(metadata.activeGeneration)
    await repository.close()
    return Object.freeze({
      operation: request.operation,
      outcome: 'unchanged',
      rebuildReason: null,
      metadata,
      coverage,
      durationMs: Math.max(0, now() - startedAt)
    })
  } catch (error) {
    try {
      await repository.close()
    } catch (closeError) {
      throw buildError(
        'fence_release_failed',
        '代码索引访问时间写入失败后无法关闭连接',
        new AggregateError([error, closeError])
      )
    }
    throw buildError('storage_commit_failed', '代码索引访问时间无法更新', error)
  }
}

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
    const resolvedGeneration = await runBuildPhase(
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
    const configFileMetadata = await scheduler.map(
      discovery.configFiles,
      (configPath) => readConfigFileMetadata(
        request.workspace.workspaceRoot,
        configPath
      ),
      cancellation
    )
    const generation: CodeGraphGenerationInput = Object.freeze({
      ...resolvedGeneration,
      configFileMetadata: Object.freeze(configFileMetadata)
    })
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
        outcome: 'committed',
        rebuildReason: null,
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

export async function runIncrementalCodeIndexBuild(
  request: CodeIndexWorkerRunRequest,
  options: CodeIndexBuildRunnerOptions = {}
): Promise<CodeIndexWorkerRunResult> {
  assertRunRequest(request)
  if (request.operation.kind !== 'incremental-update') {
    throw new CodeIndexWorkerBuildError('parser_failure', 'Worker 当前请求不是 incremental update')
  }
  const now = options.now ?? Date.now
  const startedAt = now()
  const cancellation: CodeIndexWorkCancellation = {
    abortSignal: options.abortSignal,
    isAborted: options.isAborted
  }
  throwIfCodeIndexBuildCancelled(cancellation)

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
    result = await planAndCommitIncremental(
      request,
      repository,
      cancellation,
      options,
      startedAt,
      now
    )
  } catch (error) {
    try {
      await repository.close()
    } catch (closeError) {
      throw buildError(
        'fence_release_failed',
        '代码索引增量失败后无法关闭写连接',
        new AggregateError([error, closeError])
      )
    }
    throw normalizeBuildError(error, null)
  }
  try {
    await repository.close()
  } catch (error) {
    throw buildError('storage_read_failed', '代码索引写连接关闭失败', error, result.metadata)
  }
  return result
}

async function planAndCommitIncremental(
  request: CodeIndexWorkerRunRequest,
  repository: BetterSqliteCodeGraph,
  cancellation: CodeIndexWorkCancellation,
  options: CodeIndexBuildRunnerOptions,
  startedAt: number,
  now: () => number
): Promise<CodeIndexWorkerRunResult> {
  const operation = request.operation
  const metadata = await repository.getMetadata()
  assertIncrementalBaseline(metadata, request)
  const coverage = await repository.getCoverage(metadata.activeGeneration)
  if (
    metadata.schemaVersion !== CODE_GRAPH_SCHEMA_VERSION ||
    metadata.parserSignature !== request.workspace.parserSignature ||
    metadata.resolverSignature !== request.workspace.resolverSignature
  ) {
    return noCommitResult(request, metadata, coverage, startedAt, now, 'incompatible-index')
  }

  const indexedFiles = await repository.listActiveFiles()
  if (request.changeBatch !== null) {
    const initialPlan = planWorkspaceChanges(request.changeBatch ?? [], indexedFiles.length)
    if (initialPlan.kind === 'full-rebuild') {
      return noCommitResult(request, metadata, coverage, startedAt, now, 'bulk-change')
    }
  }

  const discovery = await runBuildPhase(
    () => discoverCodeFiles({
      workspaceRoot: request.workspace.workspaceRoot,
      abortSignal: options.abortSignal
    }),
    'parser_failure',
    '代码索引 drift 发现失败'
  )
  const scheduler = new CodeIndexWorkScheduler({ cpuCount: options.cpuCount })
  const configFileMetadata = await scheduler.map(
    discovery.configFiles,
    (configPath) => readConfigFileMetadata(request.workspace.workspaceRoot, configPath),
    cancellation
  )
  const indexedConfigFiles = await repository.listActiveConfigFiles()
  if (!sameConfigFiles(configFileMetadata, indexedConfigFiles)) {
    return noCommitResult(request, metadata, coverage, startedAt, now, 'incompatible-index')
  }

  const drift = await planCodeGraphDrift(
    discovery.files,
    indexedFiles,
    (filePath) => readWorkspaceContentHash(request.workspace.workspaceRoot, filePath)
  )
  const graphChangeCount = drift.changedFiles.length + drift.removedPaths.length
  if (shouldUseFullRebuild(graphChangeCount, indexedFiles.length)) {
    return noCommitResult(request, metadata, coverage, startedAt, now, 'bulk-change')
  }
  if (graphChangeCount === 0 && drift.metadataUpdates.length === 0) {
    return noCommitResult(request, metadata, coverage, startedAt, now, null)
  }

  const incremental = await buildIncrementalUpdate(
    request,
    repository,
    discovery.files,
    discovery.configFiles,
    indexedFiles,
    drift.changedFiles,
    drift.removedPaths,
    drift.metadataUpdates,
    scheduler,
    cancellation,
    now
  )
  if (incremental === null) {
    return noCommitResult(request, metadata, coverage, startedAt, now, 'bulk-change')
  }

  let claimed = false
  try {
    await repository.claimOperation(operation)
    claimed = true
    throwIfCodeIndexBuildCancelled(cancellation)
    const committedMetadata = await repository.applyIncrementalUpdate(incremental)
    claimed = false
    let committedCoverage: CodeIndexWorkerRunResult['coverage']
    try {
      committedCoverage = await repository.getCoverage(committedMetadata.activeGeneration)
    } catch (error) {
      throw buildError(
        'storage_read_failed',
        '代码索引增量已提交，但 coverage 读取失败',
        error,
        committedMetadata
      )
    }
    return Object.freeze({
      operation,
      outcome: 'committed',
      rebuildReason: null,
      metadata: committedMetadata,
      coverage: committedCoverage,
      durationMs: Math.max(0, now() - startedAt)
    })
  } catch (error) {
    if (claimed) {
      try {
        await repository.releaseOperation(operation)
      } catch (releaseError) {
        throw buildError(
          'fence_release_failed',
          '代码索引增量失败后无法释放写入 fence',
          new AggregateError([error, releaseError])
        )
      }
    }
    throw error
  }
}

async function buildIncrementalUpdate(
  request: CodeIndexWorkerRunRequest,
  repository: BetterSqliteCodeGraph,
  discoveredFiles: readonly DiscoveredCodeFile[],
  configFiles: readonly string[],
  indexedFiles: readonly CodeGraphFileRecord[],
  changedFiles: readonly DiscoveredCodeFile[],
  removedPaths: readonly string[],
  metadataUpdates: readonly CodeGraphFileMetadataUpdate[],
  scheduler: CodeIndexWorkScheduler,
  cancellation: CodeIndexWorkCancellation,
  now: () => number
): Promise<import('../graph/CodeGraphRepository').CodeGraphIncrementalUpdate | null> {
  const discoveredByPath = new Map(discoveredFiles.map((file) => [file.path, file]))
  const indexedByPath = new Map(indexedFiles.map((file) => [file.path, file]))
  const relations = await repository.listActiveFileRelations()
  const sourcePaths = new Set(changedFiles.map((file) => file.path))
  const invalidatedTargets = new Set([...sourcePaths, ...removedPaths])

  let expanded = true
  while (expanded) {
    expanded = false
    for (const relation of relations) {
      if (!invalidatedTargets.has(relation.targetPath)) continue
      if (sourcePaths.has(relation.sourcePath)) continue
      sourcePaths.add(relation.sourcePath)
      invalidatedTargets.add(relation.sourcePath)
      expanded = true
    }
  }

  if (changedFiles.some((file) => !indexedByPath.has(file.path))) {
    for (const unresolved of await repository.listActiveUnresolvedModules()) {
      sourcePaths.add(unresolved.filePath)
    }
  }
  for (const removed of removedPaths) sourcePaths.delete(removed)
  if (shouldUseFullRebuild(sourcePaths.size + removedPaths.length, indexedFiles.length)) {
    return null
  }

  const parser = await createParser(request)
  const parsedByPath = new Map<string, ParsedSourceFile>()
  const additionalByPath = new Map<string, CodeGraphFileInput>()
  const parsePaths = async (paths: readonly string[]): Promise<void> => {
    const outcomes = await scheduler.map(paths, async (filePath) => {
      const discovered = discoveredByPath.get(filePath) ?? await inspectCodeFile({
        workspaceRoot: request.workspace.workspaceRoot,
        path: filePath
      })
      if (!discovered) return null
      return buildFile(request.workspace.workspaceRoot, discovered, parser, cancellation)
    }, cancellation)
    for (let index = 0; index < paths.length; index += 1) {
      const filePath = paths[index]
      const outcome = outcomes[index]
      if (!filePath || !outcome) continue
      if (outcome.kind === 'parsed') parsedByPath.set(filePath, outcome.file)
      else additionalByPath.set(filePath, outcome.file)
    }
  }

  await parsePaths([...sourcePaths].sort((left, right) => left.localeCompare(right, 'en')))
  const resolver = new StructuralCodeGraphResolver()
  let resolved: CodeGraphGenerationInput | null = null
  while (true) {
    throwIfCodeIndexBuildCancelled(cancellation)
    resolved = await resolver.resolve({
      workspaceRoot: request.workspace.workspaceRoot,
      operationId: request.operation.operationId,
      generation: request.operation.generation,
      parserSignature: parser.signature,
      stagedAt: now(),
      parsedFiles: [...parsedByPath.values()],
      additionalFiles: buildIncrementalCatalog(
        discoveredFiles,
        indexedByPath,
        parsedByPath,
        additionalByPath
      ),
      configFiles,
      mtimeMsByPath: new Map(discoveredFiles.map((file) => [file.path, file.mtimeMs]))
    }, {
      throwIfCancelled: () => throwIfCodeIndexBuildCancelled(cancellation)
    })
    const dependencyPaths = resolved.fileEdges
      .filter((edge) => parsedByPath.has(edge.sourcePath))
      .map((edge) => edge.targetPath)
      .filter((filePath) =>
        discoveredByPath.get(filePath)?.status === 'eligible' &&
        !parsedByPath.has(filePath) && !additionalByPath.has(filePath)
      )
    const nextPaths = [...new Set(dependencyPaths)]
      .sort((left, right) => left.localeCompare(right, 'en'))
    if (nextPaths.length === 0) break
    if (shouldUseFullRebuild(parsedByPath.size + nextPaths.length, indexedFiles.length)) {
      return null
    }
    await parsePaths(nextPaths)
  }
  if (!resolved) throw new Error('增量 resolver 未产生结果')

  const replacedPaths = sourcePaths
  return Object.freeze({
    operationId: request.operation.operationId,
    workspaceIdentity: request.operation.workspaceIdentity,
    generation: request.operation.generation,
    expectedRevision: request.operation.baseRevision,
    completedAt: now(),
    removedPaths: Object.freeze([...removedPaths]),
    metadataUpdates: Object.freeze(metadataUpdates.filter((update) =>
      !replacedPaths.has(update.path) && !removedPaths.includes(update.path)
    )),
    files: Object.freeze(resolved.files.filter((file) => replacedPaths.has(file.path))),
    symbols: Object.freeze(resolved.symbols.filter((symbol) =>
      replacedPaths.has(symbol.filePath)
    )),
    fileEdges: Object.freeze(resolved.fileEdges.filter((edge) =>
      replacedPaths.has(edge.sourcePath)
    )),
    symbolEdges: Object.freeze(resolved.symbolEdges.filter((edge) =>
      replacedPaths.has(edge.sourceFile)
    )),
    unresolvedRelations: Object.freeze(resolved.unresolvedRelations.filter((relation) =>
      replacedPaths.has(relation.filePath)
    ))
  })
}

function buildIncrementalCatalog(
  discoveredFiles: readonly DiscoveredCodeFile[],
  indexedByPath: ReadonlyMap<string, CodeGraphFileRecord>,
  parsedByPath: ReadonlyMap<string, ParsedSourceFile>,
  additionalByPath: ReadonlyMap<string, CodeGraphFileInput>
): readonly CodeGraphFileInput[] {
  const files: CodeGraphFileInput[] = []
  for (const discovered of discoveredFiles) {
    if (parsedByPath.has(discovered.path)) continue
    const additional = additionalByPath.get(discovered.path)
    if (additional) {
      files.push(additional)
      continue
    }
    const indexed = indexedByPath.get(discovered.path)
    if (indexed) {
      files.push(indexed)
      continue
    }
    files.push(skippedFile(discovered))
  }
  return Object.freeze(files)
}

function noCommitResult(
  request: CodeIndexWorkerRunRequest,
  metadata: CodeGraphMetadata,
  coverage: CodeIndexWorkerRunResult['coverage'],
  startedAt: number,
  now: () => number,
  rebuildReason: CodeIndexWorkerRunResult['rebuildReason']
): CodeIndexWorkerRunResult {
  return Object.freeze({
    operation: request.operation,
    outcome: rebuildReason === null ? 'unchanged' : 'rebuild-required',
    rebuildReason,
    metadata,
    coverage,
    durationMs: Math.max(0, now() - startedAt)
  })
}

function sameConfigFiles(
  current: readonly NonNullable<CodeGraphGenerationInput['configFileMetadata']>[number][],
  indexed: readonly import('../graph/CodeGraphRepository').CodeGraphConfigFileRecord[]
): boolean {
  if (current.length !== indexed.length) return false
  const indexedByPath = new Map(indexed.map((file) => [file.path, file]))
  return current.every((file) => indexedByPath.get(file.path)?.contentHash === file.contentHash)
}

async function readWorkspaceContentHash(
  workspaceRoot: string,
  filePath: string
): Promise<string> {
  const source = await readWorkspaceFile(workspaceRoot, filePath)
  return createHash('sha256').update(source.content).digest('hex')
}

function assertIncrementalBaseline(
  metadata: CodeGraphMetadata,
  request: CodeIndexWorkerRunRequest
): void {
  if (
    metadata.workspaceIdentity !== request.operation.workspaceIdentity ||
    metadata.activeGeneration === null ||
    metadata.activeGeneration !== request.operation.generation ||
    request.operation.baseGeneration !== metadata.activeGeneration ||
    metadata.revision !== request.operation.baseRevision
  ) {
    throw new CodeIndexWorkerBuildError(
      'stale_result_rejected',
      '增量 operation 基线已失效'
    )
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
  return (await readWorkspaceFile(workspaceRoot, relativePath)).content.toString('utf8')
}

async function readConfigFileMetadata(
  workspaceRoot: string,
  relativePath: string
): Promise<NonNullable<CodeGraphGenerationInput['configFileMetadata']>[number]> {
  const snapshot = await readWorkspaceFile(workspaceRoot, relativePath)
  return Object.freeze({
    path: relativePath,
    contentHash: createHash('sha256').update(snapshot.content).digest('hex'),
    sizeBytes: snapshot.content.length,
    mtimeMs: snapshot.mtimeMs
  })
}

async function readWorkspaceFile(
  workspaceRoot: string,
  relativePath: string
): Promise<{ readonly content: Buffer; readonly mtimeMs: number }> {
  const root = await realpath(path.resolve(workspaceRoot))
  const target = await realpath(path.resolve(root, ...relativePath.split('/')))
  const relative = path.relative(root, target)
  // 读取前再做 realpath fence，避免发现后 symlink/junction 被替换。
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('源文件真实路径越出 workspace')
  }
  const [content, fileStat] = await Promise.all([readFile(target), stat(target)])
  return Object.freeze({ content, mtimeMs: fileStat.mtimeMs })
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
  if (request.operation.kind === 'full-rebuild') {
    if (request.changeBatch !== undefined || request.accessedAt !== undefined) {
      throw new CodeIndexWorkerBuildError('parser_failure', 'full rebuild 请求包含多余字段')
    }
  } else if (request.operation.kind === 'touch-access') {
    if (
      request.operation.baseGeneration === null ||
      request.operation.generation !== request.operation.baseGeneration ||
      request.changeBatch !== undefined ||
      request.accessedAt === undefined ||
      !Number.isFinite(request.accessedAt) || request.accessedAt < 0
    ) {
      throw new CodeIndexWorkerBuildError('storage_commit_failed', '访问时间请求契约不完整')
    }
  } else if (
    request.operation.baseGeneration === null ||
    request.operation.generation !== request.operation.baseGeneration ||
    request.changeBatch === undefined ||
    request.accessedAt !== undefined
  ) {
    throw new CodeIndexWorkerBuildError('parser_failure', 'incremental update 契约不完整')
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
