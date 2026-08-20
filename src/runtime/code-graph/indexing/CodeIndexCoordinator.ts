import { randomUUID } from 'node:crypto'
import type {
  CodeGraphGenerationInput,
  CodeGraphIncrementalUpdate,
  CodeGraphMetadata,
  CodeGraphRepository
} from '../graph/CodeGraphRepository'
import {
  CODE_INDEX_FAILURE_CODES,
  EMPTY_CODE_INDEX_COVERAGE,
  type CodeIndexFailure,
  type CodeIndexFailureCode,
  type CodeIndexOperation,
  type CodeIndexProgress,
  type CodeIndexSnapshot
} from '../types'

export type CodeIndexSnapshotListener = (snapshot: CodeIndexSnapshot) => void

export interface CodeIndexCoordinatorOptions {
  readonly generateOperationId?: () => string
}

/** 索引生命周期与可变状态的唯一 Owner；查询端不得写入这里的状态。 */
export class CodeIndexCoordinator {
  private repository: CodeGraphRepository | null = null
  private activeOperation: CodeIndexOperation | null = null
  private workspaceEpoch = 0
  private nextGenerationFloor = 1
  /** 串行签发 fence，避免并发 rebuild 让旧 operation 覆盖新 operation。 */
  private operationClaimQueue: Promise<void> = Promise.resolve()
  private readonly listeners = new Set<CodeIndexSnapshotListener>()
  private readonly generateOperationId: () => string
  private snapshot = createSnapshot({})

  constructor(options: CodeIndexCoordinatorOptions = {}) {
    this.generateOperationId = options.generateOperationId ?? randomUUID
  }

  getSnapshot(): CodeIndexSnapshot {
    return this.snapshot
  }

  subscribe(listener: CodeIndexSnapshotListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async openWorkspace(
    workspaceIdentity: string,
    repository: CodeGraphRepository
  ): Promise<CodeIndexSnapshot> {
    assertNonEmpty(workspaceIdentity, 'workspaceIdentity')
    const previousRepository = this.repository
    const previousOperation = this.activeOperation
    const epoch = ++this.workspaceEpoch
    this.repository = repository
    this.activeOperation = null
    this.nextGenerationFloor = 1
    this.publish(createSnapshot({ workspaceIdentity }))

    try {
      if (previousRepository && previousOperation) {
        await previousRepository.releaseOperation(previousOperation)
      }
      const metadata = await repository.getMetadata()
      if (!this.matchesWorkspace(epoch, workspaceIdentity, repository)) return this.snapshot
      assertMetadataIdentity(metadata, workspaceIdentity)
      const coverage = await repository.getCoverage(metadata.activeGeneration)
      if (!this.matchesWorkspace(epoch, workspaceIdentity, repository)) return this.snapshot
      this.publish(snapshotFromMetadata(metadata, coverage))
      return this.snapshot
    } catch (error) {
      if (!this.matchesWorkspace(epoch, workspaceIdentity, repository)) return this.snapshot
      this.publish(createSnapshot({
        workspaceIdentity,
        status: 'unavailable',
        failure: failureFromError('storage_open_failed', error)
      }))
      throw error
    }
  }

  async closeWorkspace(workspaceIdentity?: string): Promise<void> {
    if (
      workspaceIdentity !== undefined &&
      this.snapshot.workspaceIdentity !== workspaceIdentity
    ) {
      return
    }
    const repository = this.repository
    const operation = this.activeOperation
    this.workspaceEpoch += 1
    this.repository = null
    this.activeOperation = null
    this.nextGenerationFloor = 1
    this.publish(createSnapshot({}))
    // Repository 连接由 composition host 持有；Coordinator 只释放写 fence。
    if (repository && operation) await repository.releaseOperation(operation)
  }

  async beginFullRebuild(): Promise<CodeIndexOperation> {
    const requestedContext = this.requireWorkspace()
    return this.enqueueOperationClaim(async () => {
      this.assertWorkspaceContext(requestedContext)
      const context = requestedContext
      const storedNextGeneration = await context.repository.nextGeneration()
      this.assertWorkspaceContext(context)
      const generation = Math.max(
        storedNextGeneration,
        (this.snapshot.activeGeneration ?? 0) + 1,
        this.nextGenerationFloor
      )
      this.nextGenerationFloor = generation + 1

      const operation = freezeOperation({
        operationId: this.generateOperationId(),
        kind: 'full-rebuild',
        workspaceIdentity: context.workspaceIdentity,
        generation,
        baseGeneration: this.snapshot.activeGeneration,
        baseRevision: this.snapshot.revision
      })
      await context.repository.claimOperation(operation)
      if (!this.matchesWorkspace(
        context.epoch,
        context.workspaceIdentity,
        context.repository
      )) {
        await context.repository.releaseOperation(operation)
        throw new Error('Code Graph workspace 已切换')
      }
      this.activeOperation = operation
      this.publish(createSnapshot({
        ...this.snapshot,
        status: this.snapshot.activeGeneration === null ? 'building' : 'updating',
        progress: { completed: 0, total: 0 },
        failure: null
      }))
      return operation
    })
  }

  async beginIncrementalUpdate(): Promise<CodeIndexOperation> {
    const requestedContext = this.requireWorkspace()
    return this.enqueueOperationClaim(async () => {
      this.assertWorkspaceContext(requestedContext)
      const context = requestedContext
      if (this.snapshot.activeGeneration === null) {
        throw new Error('没有 active generation，不能执行增量更新')
      }

      const operation = freezeOperation({
        operationId: this.generateOperationId(),
        kind: 'incremental-update',
        workspaceIdentity: context.workspaceIdentity,
        generation: this.snapshot.activeGeneration,
        baseGeneration: this.snapshot.activeGeneration,
        baseRevision: this.snapshot.revision
      })
      await context.repository.claimOperation(operation)
      if (!this.matchesWorkspace(
        context.epoch,
        context.workspaceIdentity,
        context.repository
      )) {
        await context.repository.releaseOperation(operation)
        throw new Error('Code Graph workspace 已切换')
      }
      this.activeOperation = operation
      this.publish(createSnapshot({
        ...this.snapshot,
        status: 'updating',
        progress: null,
        failure: null
      }))
      return operation
    })
  }

  reportProgress(operation: CodeIndexOperation, progress: CodeIndexProgress): boolean {
    if (!this.isCurrentOperation(operation)) return false
    assertProgress(progress)
    if (
      this.snapshot.progress?.completed === progress.completed &&
      this.snapshot.progress.total === progress.total
    ) {
      return true
    }
    this.publish(createSnapshot({ ...this.snapshot, progress }))
    return true
  }

  async commitFullRebuild(
    operation: CodeIndexOperation,
    generation: CodeGraphGenerationInput,
    completedAt: number
  ): Promise<boolean> {
    if (!this.isCurrentOperation(operation) || operation.kind !== 'full-rebuild') {
      return false
    }
    assertGenerationMatchesOperation(generation, operation)
    const repository = this.requireRepositoryFor(operation)

    try {
      await repository.stageGeneration(generation)
      if (!this.isCurrentOperation(operation)) return false
      const metadata = await repository.activateGeneration({
        operationId: operation.operationId,
        workspaceIdentity: operation.workspaceIdentity,
        generation: operation.generation,
        expectedActiveGeneration: operation.baseGeneration,
        expectedRevision: operation.baseRevision,
        completedAt
      })
      if (!this.isCurrentOperation(operation)) return false
      assertCommittedMetadata(metadata, operation)
      this.publishCommittedMetadata(metadata)
      const coverage = await repository.getCoverage(metadata.activeGeneration)
      if (!this.isCurrentOperation(operation)) return false
      this.finishOperation(metadata, coverage)
      return true
    } catch (error) {
      const failure = await releaseAfterFailure(repository, operation, error)
      this.failIfCurrent(
        operation,
        failureFromError(this.commitFailureCode(operation), failure)
      )
      throw failure
    }
  }

  async commitIncrementalUpdate(
    operation: CodeIndexOperation,
    update: CodeGraphIncrementalUpdate
  ): Promise<boolean> {
    if (!this.isCurrentOperation(operation) || operation.kind !== 'incremental-update') {
      return false
    }
    assertIncrementalMatchesOperation(update, operation)
    const repository = this.requireRepositoryFor(operation)

    try {
      const metadata = await repository.applyIncrementalUpdate(update)
      if (!this.isCurrentOperation(operation)) return false
      assertCommittedMetadata(metadata, operation)
      this.publishCommittedMetadata(metadata)
      const coverage = await repository.getCoverage(metadata.activeGeneration)
      if (!this.isCurrentOperation(operation)) return false
      this.finishOperation(metadata, coverage)
      return true
    } catch (error) {
      const failure = await releaseAfterFailure(repository, operation, error)
      this.failIfCurrent(
        operation,
        failureFromError(this.commitFailureCode(operation), failure)
      )
      throw failure
    }
  }

  async failOperation(
    operation: CodeIndexOperation,
    failure: CodeIndexFailure
  ): Promise<boolean> {
    if (!this.isCurrentOperation(operation)) return false
    this.failIfCurrent(operation, failure)
    const repository = this.requireRepositoryFor(operation)
    await repository.releaseOperation(operation)
    return true
  }

  async cancelOperation(operation: CodeIndexOperation): Promise<boolean> {
    if (!this.isCurrentOperation(operation)) return false
    const repository = this.requireRepositoryFor(operation)
    this.activeOperation = null
    try {
      await repository.releaseOperation(operation)
    } catch (error) {
      this.publish(createSnapshot({
        ...this.snapshot,
        status: this.snapshot.activeGeneration === null ? 'unavailable' : 'degraded',
        progress: null,
        failure: failureFromError('fence_release_failed', error)
      }))
      throw error
    }
    this.publish(createSnapshot({
      ...this.snapshot,
      status: this.snapshot.activeGeneration === null ? 'idle' : 'ready',
      progress: null,
      failure: null
    }))
    return true
  }

  async workerFailed(
    operation: CodeIndexOperation,
    failure: unknown
  ): Promise<boolean> {
    return this.failOperation(
      operation,
      normalizeCodeIndexFailure(failure, 'worker_crash')
    )
  }

  private publishCommittedMetadata(metadata: CodeGraphMetadata): void {
    this.publish(createSnapshot({
      ...snapshotFromMetadata(metadata, this.snapshot.coverage),
      status: 'updating'
    }))
  }

  private commitFailureCode(operation: CodeIndexOperation): CodeIndexFailureCode {
    return this.snapshot.activeGeneration === operation.generation &&
      this.snapshot.revision === operation.baseRevision + 1
      ? 'storage_read_failed'
      : 'storage_commit_failed'
  }

  private finishOperation(
    metadata: CodeGraphMetadata,
    coverage: CodeIndexSnapshot['coverage']
  ): void {
    assertMetadataIdentity(metadata, this.snapshot.workspaceIdentity)
    this.activeOperation = null
    this.publish(snapshotFromMetadata(metadata, coverage))
  }

  private failIfCurrent(
    operation: CodeIndexOperation,
    failure: CodeIndexFailure
  ): void {
    if (!this.isCurrentOperation(operation)) return
    this.activeOperation = null
    this.publish(createSnapshot({
      ...this.snapshot,
      status: this.snapshot.activeGeneration === null ? 'unavailable' : 'degraded',
      progress: null,
      failure
    }))
  }

  private isCurrentOperation(operation: CodeIndexOperation): boolean {
    return this.activeOperation?.operationId === operation.operationId &&
      this.activeOperation.workspaceIdentity === operation.workspaceIdentity &&
      this.activeOperation.generation === operation.generation &&
      this.snapshot.workspaceIdentity === operation.workspaceIdentity
  }

  private requireRepositoryFor(operation: CodeIndexOperation): CodeGraphRepository {
    if (
      !this.repository ||
      this.snapshot.workspaceIdentity !== operation.workspaceIdentity
    ) {
      throw new Error('Code Graph operation workspace 已失效')
    }
    return this.repository
  }

  private requireWorkspace(): {
    readonly epoch: number
    readonly workspaceIdentity: string
    readonly repository: CodeGraphRepository
  } {
    if (!this.repository || this.snapshot.workspaceIdentity === null) {
      throw new Error('Code Graph 尚未绑定 workspace')
    }
    return {
      epoch: this.workspaceEpoch,
      workspaceIdentity: this.snapshot.workspaceIdentity,
      repository: this.repository
    }
  }

  private matchesWorkspace(
    epoch: number,
    workspaceIdentity: string,
    repository: CodeGraphRepository
  ): boolean {
    return this.workspaceEpoch === epoch &&
      this.snapshot.workspaceIdentity === workspaceIdentity &&
      this.repository === repository
  }

  private assertWorkspaceContext(context: {
    readonly epoch: number
    readonly workspaceIdentity: string
    readonly repository: CodeGraphRepository
  }): void {
    if (!this.matchesWorkspace(
      context.epoch,
      context.workspaceIdentity,
      context.repository
    )) {
      throw new Error('Code Graph workspace 已切换')
    }
  }

  private enqueueOperationClaim<T>(work: () => Promise<T>): Promise<T> {
    const result = this.operationClaimQueue.then(work, work)
    this.operationClaimQueue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  private publish(snapshot: CodeIndexSnapshot): void {
    this.snapshot = snapshot
    for (const listener of this.listeners) {
      try {
        listener(snapshot)
      } catch {
        // 一个状态观察者不能阻断 Coordinator 生命周期。
      }
    }
  }
}

function snapshotFromMetadata(
  metadata: CodeGraphMetadata,
  coverage: CodeIndexSnapshot['coverage']
): CodeIndexSnapshot {
  return createSnapshot({
    workspaceIdentity: metadata.workspaceIdentity,
    activeGeneration: metadata.activeGeneration,
    revision: metadata.revision,
    status: metadata.activeGeneration === null ? 'idle' : 'ready',
    coverage,
    lastCompletedAt: metadata.lastCompletedAt
  })
}

function createSnapshot(
  input: Partial<CodeIndexSnapshot>
): CodeIndexSnapshot {
  const coverage = input.coverage ?? EMPTY_CODE_INDEX_COVERAGE
  const progress = input.progress === undefined || input.progress === null
    ? null
    : Object.freeze({ ...input.progress })
  const failure = input.failure === undefined || input.failure === null
    ? null
    : Object.freeze({ ...input.failure })
  return Object.freeze({
    workspaceIdentity: input.workspaceIdentity ?? null,
    activeGeneration: input.activeGeneration ?? null,
    revision: input.revision ?? 0,
    status: input.status ?? 'idle',
    coverage: Object.freeze({ ...coverage }),
    progress,
    lastCompletedAt: input.lastCompletedAt ?? null,
    failure
  })
}

function freezeOperation(operation: CodeIndexOperation): CodeIndexOperation {
  return Object.freeze({ ...operation })
}

function assertMetadataIdentity(
  metadata: CodeGraphMetadata,
  expectedIdentity: string | null
): void {
  if (metadata.workspaceIdentity !== expectedIdentity) {
    throw new Error('Code Graph repository 返回了其他 workspace 的状态')
  }
}

function assertGenerationMatchesOperation(
  generation: CodeGraphGenerationInput,
  operation: CodeIndexOperation
): void {
  if (
    generation.operationId !== operation.operationId ||
    generation.generation !== operation.generation
  ) {
    throw new Error('Code Graph generation 与 operation 不匹配')
  }
}

function assertIncrementalMatchesOperation(
  update: CodeGraphIncrementalUpdate,
  operation: CodeIndexOperation
): void {
  if (
    update.operationId !== operation.operationId ||
    update.workspaceIdentity !== operation.workspaceIdentity ||
    update.generation !== operation.generation ||
    update.expectedRevision !== operation.baseRevision
  ) {
    throw new Error('Code Graph 增量更新与 operation 不匹配')
  }
}

function assertCommittedMetadata(
  metadata: CodeGraphMetadata,
  operation: CodeIndexOperation
): void {
  if (
    metadata.workspaceIdentity !== operation.workspaceIdentity ||
    metadata.activeGeneration !== operation.generation ||
    metadata.revision !== operation.baseRevision + 1
  ) {
    throw new Error('Code Graph repository 返回了不一致的提交结果')
  }
}

function assertProgress(progress: CodeIndexProgress): void {
  if (
    !Number.isInteger(progress.completed) ||
    !Number.isInteger(progress.total) ||
    progress.completed < 0 ||
    progress.total < 0 ||
    progress.completed > progress.total
  ) {
    throw new Error('Code Graph progress 无效')
  }
}

function assertNonEmpty(value: string, field: string): void {
  if (value.length === 0) throw new Error(`Code Graph 字段 ${field} 不能为空`)
}

function failureFromError(
  code: CodeIndexFailureCode,
  error: unknown
): CodeIndexFailure {
  return Object.freeze({
    code,
    message: error instanceof Error ? error.message : String(error)
  })
}

function normalizeCodeIndexFailure(
  value: unknown,
  fallbackCode: CodeIndexFailureCode
): CodeIndexFailure {
  if (isRecord(value)) {
    const code = Reflect.get(value, 'code')
    const message = Reflect.get(value, 'message')
    if (isCodeIndexFailureCode(code) && typeof message === 'string') {
      return Object.freeze({ code, message })
    }
    if (typeof message === 'string') {
      return Object.freeze({ code: fallbackCode, message })
    }
  }
  return Object.freeze({
    code: fallbackCode,
    message: value instanceof Error ? value.message : String(value)
  })
}

function isCodeIndexFailureCode(value: unknown): value is CodeIndexFailureCode {
  return typeof value === 'string' && CODE_INDEX_FAILURE_CODE_SET.has(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

const CODE_INDEX_FAILURE_CODE_SET: ReadonlySet<string> = new Set(
  CODE_INDEX_FAILURE_CODES
)

async function releaseAfterFailure(
  repository: CodeGraphRepository,
  operation: CodeIndexOperation,
  originalError: unknown
): Promise<unknown> {
  try {
    await repository.releaseOperation(operation)
    return originalError
  } catch (releaseError) {
    return new AggregateError(
      [originalError, releaseError],
      'Code Graph operation 失败且 write fence 无法释放'
    )
  }
}
