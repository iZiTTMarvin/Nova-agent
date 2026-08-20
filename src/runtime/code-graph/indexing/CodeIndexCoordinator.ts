import { randomUUID } from 'node:crypto'
import type { CodeGraphMetadata, CodeGraphStateReader } from '../graph/CodeGraphRepository'
import {
  EMPTY_CODE_INDEX_COVERAGE,
  type CodeIndexFailure,
  type CodeIndexOperation,
  type CodeIndexProgress,
  type CodeIndexSnapshot,
  type CodeIndexWorkerState
} from '../types'
import {
  CODE_INDEX_WORKER_IDLE_TIMEOUT_MS,
  CodeIndexWorkerMissingError,
  CodeIndexWorkerRunError,
  type CodeIndexWorkerPort,
  type CodeIndexWorkerRunResult,
  type CodeIndexWorkerWorkspace
} from '../worker/protocol'

export type CodeIndexSnapshotListener = (snapshot: CodeIndexSnapshot) => void
export type CodeIndexWorkerFactory = () => CodeIndexWorkerPort

/** 只读连接按需重取，以读取 Worker 首次建库或终止前的已提交状态。 */
export interface CodeGraphStateReaderProvider {
  getStateReader(): Promise<CodeGraphStateReader | null>
}

export interface CodeIndexCoordinatorOptions {
  readonly generateOperationId?: () => string
  readonly createWorker?: CodeIndexWorkerFactory
  readonly idleTimeoutMs?: number
}

interface WorkspaceContext {
  readonly epoch: number
  readonly workspace: CodeIndexWorkerWorkspace
  readonly stateReaderProvider: CodeGraphStateReaderProvider
}

/** 索引生命周期与可变状态的唯一 Owner；所有写入工作只通过 Worker 端口调度。 */
export class CodeIndexCoordinator {
  private workspace: CodeIndexWorkerWorkspace | null = null
  private stateReaderProvider: CodeGraphStateReaderProvider | null = null
  private worker: CodeIndexWorkerPort | null = null
  private activeOperation: CodeIndexOperation | null = null
  private activeRun: Promise<boolean> | null = null
  private workspaceEpoch = 0
  private nextGenerationFloor = 1
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private readonly listeners = new Set<CodeIndexSnapshotListener>()
  private readonly generateOperationId: () => string
  private readonly createWorker: CodeIndexWorkerFactory | null
  private readonly idleTimeoutMs: number
  private snapshot = createSnapshot({})

  constructor(options: CodeIndexCoordinatorOptions = {}) {
    this.generateOperationId = options.generateOperationId ?? randomUUID
    this.createWorker = options.createWorker ?? null
    this.idleTimeoutMs = options.idleTimeoutMs ?? CODE_INDEX_WORKER_IDLE_TIMEOUT_MS
    if (!Number.isFinite(this.idleTimeoutMs) || this.idleTimeoutMs < 0) {
      throw new Error('Code Index Worker 空闲阈值必须是非负数')
    }
  }

  getSnapshot(): CodeIndexSnapshot {
    return this.snapshot
  }

  subscribe(listener: CodeIndexSnapshotListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async openWorkspace(
    workspace: CodeIndexWorkerWorkspace,
    stateReaderProvider: CodeGraphStateReaderProvider
  ): Promise<CodeIndexSnapshot> {
    assertWorkspace(workspace)
    const epoch = ++this.workspaceEpoch
    this.workspace = null
    this.stateReaderProvider = null
    this.nextGenerationFloor = 1
    this.publish(createSnapshot({}))
    await this.shutdownWorker()
    if (epoch !== this.workspaceEpoch) return this.snapshot

    this.workspace = Object.freeze({
      ...workspace,
      grammarWasmPaths: Object.freeze({ ...workspace.grammarWasmPaths })
    })
    this.stateReaderProvider = stateReaderProvider
    this.publish(createSnapshot({ workspaceIdentity: workspace.workspaceIdentity }))

    try {
      const stateReader = await stateReaderProvider.getStateReader()
      if (stateReader === null) return this.snapshot
      const metadata = await stateReader.getMetadata()
      if (!this.matchesWorkspace(epoch, workspace.workspaceIdentity, stateReaderProvider)) {
        return this.snapshot
      }
      assertMetadataIdentity(metadata, workspace.workspaceIdentity)
      const coverage = await stateReader.getCoverage(metadata.activeGeneration)
      if (!this.matchesWorkspace(epoch, workspace.workspaceIdentity, stateReaderProvider)) {
        return this.snapshot
      }
      this.publish(snapshotFromMetadata(metadata, coverage, 'stopped'))
      return this.snapshot
    } catch (error) {
      if (!this.matchesWorkspace(epoch, workspace.workspaceIdentity, stateReaderProvider)) {
        return this.snapshot
      }
      this.publish(createSnapshot({
        workspaceIdentity: workspace.workspaceIdentity,
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
    ) return
    this.workspaceEpoch += 1
    this.workspace = null
    this.stateReaderProvider = null
    this.nextGenerationFloor = 1
    this.publish(createSnapshot({}))
    await this.shutdownWorker()
  }

  rebuild(): Promise<boolean> {
    if (this.activeRun) return this.activeRun
    const run = this.performFullRebuild()
    this.activeRun = run
    run.then(
      () => this.clearActiveRun(run),
      () => this.clearActiveRun(run)
    )
    return run
  }

  async cancelCurrentOperation(): Promise<boolean> {
    const operation = this.activeOperation
    const worker = this.worker
    if (!operation || !worker) return false
    const context = this.requireWorkspace()
    this.activeOperation = null
    this.publish(createSnapshot({
      ...this.snapshot,
      status: this.snapshot.activeGeneration === null ? 'idle' : 'ready',
      progress: null,
      failure: null,
      workerState: 'running'
    }))
    try {
      await worker.cancel(operation.operationId)
      if (this.worker === worker && this.activeOperation === null) {
        this.publish(createSnapshot({ ...this.snapshot, workerState: 'idle' }))
        this.scheduleIdleDispose(worker)
      }
      const workerFailure = this.worker === worker ? null : this.snapshot.failure
      await this.reconcileCommittedOperation(
        context,
        operation,
        workerFailure,
        this.worker === worker ? 'idle' : 'failed'
      )
      return true
    } catch (error) {
      const failure = failureFromError('worker_crash', error)
      if (this.worker === worker) {
        this.worker = null
        this.publish(createSnapshot({
          ...this.snapshot,
          status: this.snapshot.activeGeneration === null ? 'unavailable' : 'degraded',
          progress: null,
          failure,
          workerState: 'failed'
        }))
        void worker.dispose().catch(() => undefined)
      }
      await this.reconcileCommittedOperation(
        context,
        operation,
        this.snapshot.failure ?? failure,
        'failed'
      )
      return false
    }
  }

  private async performFullRebuild(): Promise<boolean> {
    const context = this.requireWorkspace()
    this.clearIdleTimer()
    let nextGeneration: number
    try {
      const storedState = await this.readStoredState(context)
      if (!this.matchesContext(context)) return false
      if (storedState !== null) this.adoptStoredState(storedState, this.currentWorkerState())
      const storedNext = storedState?.nextGeneration ?? 1
      nextGeneration = Math.max(
        storedNext,
        (this.snapshot.activeGeneration ?? 0) + 1,
        this.nextGenerationFloor
      )
    } catch (error) {
      if (this.matchesContext(context)) {
        this.publish(createSnapshot({
          ...this.snapshot,
          status: this.snapshot.activeGeneration === null ? 'unavailable' : 'degraded',
          failure: failureFromError('storage_read_failed', error)
        }))
      }
      return false
    }

    this.nextGenerationFloor = nextGeneration + 1
    const operation = freezeOperation({
      operationId: this.generateOperationId(),
      kind: 'full-rebuild',
      workspaceIdentity: context.workspace.workspaceIdentity,
      generation: nextGeneration,
      baseGeneration: this.snapshot.activeGeneration,
      baseRevision: this.snapshot.revision
    })
    this.activeOperation = operation
    this.publish(createSnapshot({
      ...this.snapshot,
      status: this.snapshot.activeGeneration === null ? 'building' : 'updating',
      progress: { completed: 0, total: 0 },
      failure: null,
      workerState: 'running'
    }))

    let worker: CodeIndexWorkerPort
    try {
      worker = this.ensureWorker()
    } catch (error) {
      this.failCurrentOperation(operation, workerFailureDetails(error), 'failed')
      return false
    }

    try {
      const result = await worker.run({ operation, workspace: context.workspace }, {
        onProgress: (progress) => this.reportProgress(operation, progress)
      })
      if (!this.isCurrentOperation(operation) || !this.matchesContext(context)) return false
      assertWorkerResult(result, operation)
      this.activeOperation = null
      this.publish(snapshotFromMetadata(result.metadata, result.coverage, 'idle'))
      this.scheduleIdleDispose(worker)
      return true
    } catch (error) {
      if (!this.isCurrentOperation(operation) || !this.matchesContext(context)) return false
      const details = workerFailureDetails(error)
      const terminal = details.failure.code === 'worker_crash' ||
        details.failure.code === 'worker_missing'
      this.failCurrentOperation(operation, details, terminal ? 'failed' : 'idle')
      if (terminal && this.worker === worker) {
        this.worker = null
        void worker.dispose().catch(() => undefined)
      } else if (!terminal) {
        this.scheduleIdleDispose(worker)
      }
      await this.reconcileCommittedOperation(
        context,
        operation,
        details.failure,
        terminal ? 'failed' : 'idle'
      )
      return false
    }
  }

  private reportProgress(operation: CodeIndexOperation, progress: CodeIndexProgress): void {
    if (!this.isCurrentOperation(operation)) return
    assertProgress(progress)
    if (
      this.snapshot.progress?.completed === progress.completed &&
      this.snapshot.progress.total === progress.total
    ) return
    this.publish(createSnapshot({ ...this.snapshot, progress }))
  }

  private failCurrentOperation(
    operation: CodeIndexOperation,
    details: WorkerFailureDetails,
    workerState: CodeIndexWorkerState
  ): void {
    if (!this.isCurrentOperation(operation)) return
    const committedMetadata = details.committedMetadata &&
      isCommittedMetadata(details.committedMetadata, operation)
      ? details.committedMetadata
      : null
    const failure: CodeIndexFailure = details.committedMetadata && committedMetadata === null
      ? Object.freeze({
        code: 'worker_crash',
        message: 'Code Index Worker 返回了不一致的已提交状态'
      })
      : details.failure
    this.activeOperation = null
    if (committedMetadata) {
      this.publish(createSnapshot({
        ...snapshotFromMetadata(committedMetadata, this.snapshot.coverage, workerState),
        status: 'degraded',
        failure
      }))
      return
    }
    this.publish(createSnapshot({
      ...this.snapshot,
      status: this.snapshot.activeGeneration === null ? 'unavailable' : 'degraded',
      progress: null,
      failure,
      workerState
    }))
  }

  private async readStoredState(
    context: WorkspaceContext
  ): Promise<StoredCodeGraphState | null> {
    const stateReader = await context.stateReaderProvider.getStateReader()
    if (stateReader === null) return null
    const metadata = await stateReader.getMetadata()
    assertMetadataIdentity(metadata, context.workspace.workspaceIdentity)
    const coverage = await stateReader.getCoverage(metadata.activeGeneration)
    const nextGeneration = await stateReader.nextGeneration()
    return Object.freeze({ metadata, coverage, nextGeneration })
  }

  private adoptStoredState(
    storedState: StoredCodeGraphState,
    workerState: CodeIndexWorkerState
  ): void {
    const { metadata, coverage, nextGeneration } = storedState
    this.nextGenerationFloor = Math.max(this.nextGenerationFloor, nextGeneration)
    if (metadata.revision < this.snapshot.revision) return
    if (
      metadata.revision === this.snapshot.revision &&
      metadata.activeGeneration !== this.snapshot.activeGeneration
    ) {
      throw new Error('Code Graph 持久化状态与 Coordinator revision 冲突')
    }
    this.publish(snapshotFromMetadata(metadata, coverage, workerState))
  }

  private async reconcileCommittedOperation(
    context: WorkspaceContext,
    operation: CodeIndexOperation,
    failure: CodeIndexFailure | null,
    workerState: CodeIndexWorkerState
  ): Promise<void> {
    try {
      const storedState = await this.readStoredState(context)
      if (
        storedState === null ||
        !this.matchesContext(context) ||
        this.activeOperation !== null ||
        // 只有精确命中本次 operation 的提交才能修正内存投影。
        !isCommittedMetadata(storedState.metadata, operation) ||
        storedState.metadata.revision < this.snapshot.revision
      ) return

      this.nextGenerationFloor = Math.max(
        this.nextGenerationFloor,
        storedState.nextGeneration,
        operation.generation + 1
      )
      const committed = snapshotFromMetadata(
        storedState.metadata,
        storedState.coverage,
        workerState === 'idle' ? this.currentWorkerState() : workerState
      )
      this.publish(createSnapshot({
        ...committed,
        status: failure === null ? committed.status : 'degraded',
        failure
      }))
    } catch (error) {
      if (
        failure !== null ||
        !this.matchesContext(context) ||
        this.activeOperation !== null
      ) return
      this.publish(createSnapshot({
        ...this.snapshot,
        status: this.snapshot.activeGeneration === null ? 'unavailable' : 'degraded',
        progress: null,
        failure: failureFromError('storage_read_failed', error),
        workerState: workerState === 'idle' ? this.currentWorkerState() : workerState
      }))
    }
  }

  private currentWorkerState(): CodeIndexWorkerState {
    if (this.worker !== null) return this.activeOperation === null ? 'idle' : 'running'
    return this.snapshot.workerState === 'failed' ? 'failed' : 'stopped'
  }

  private ensureWorker(): CodeIndexWorkerPort {
    if (this.worker) return this.worker
    if (!this.createWorker) throw new CodeIndexWorkerMissingError('Code Index Worker 未装配')
    const worker = this.createWorker()
    this.worker = worker
    worker.onTerminalFailure((failure) => this.handleWorkerTerminalFailure(worker, failure))
    if (this.worker !== worker) {
      throw new CodeIndexWorkerRunError({
        code: 'worker_crash',
        message: 'Code Index Worker 在装配期间已退出'
      }, null)
    }
    return worker
  }

  private handleWorkerTerminalFailure(
    worker: CodeIndexWorkerPort,
    failure: CodeIndexFailure
  ): void {
    if (this.worker !== worker) return
    const context = this.currentWorkspaceContext()
    this.worker = null
    this.clearIdleTimer()
    const operation = this.activeOperation
    if (operation) {
      this.failCurrentOperation(operation, { failure, committedMetadata: null }, 'failed')
      if (context) {
        void this.reconcileCommittedOperation(
          context,
          operation,
          failure,
          'failed'
        )
      }
      return
    }
    this.publish(createSnapshot({
      ...this.snapshot,
      status: this.snapshot.activeGeneration === null ? 'unavailable' : 'degraded',
      progress: null,
      failure,
      workerState: 'failed'
    }))
  }

  private scheduleIdleDispose(worker: CodeIndexWorkerPort): void {
    this.clearIdleTimer()
    const epoch = this.workspaceEpoch
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      if (
        this.worker !== worker || this.activeOperation !== null ||
        this.workspaceEpoch !== epoch
      ) return
      this.worker = null
      this.publish(createSnapshot({ ...this.snapshot, workerState: 'stopped' }))
      void worker.dispose().catch(() => undefined)
    }, this.idleTimeoutMs)
  }

  private async shutdownWorker(): Promise<void> {
    this.clearIdleTimer()
    const worker = this.worker
    const operation = this.activeOperation
    this.worker = null
    this.activeOperation = null
    if (!worker) return
    if (operation) {
      try {
        await worker.cancel(operation.operationId)
      } catch {
        // dispose 是最终清理边界，cancel 失败不能阻断 workspace 切换。
      }
    }
    await worker.dispose()
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
  }

  private clearActiveRun(run: Promise<boolean>): void {
    if (this.activeRun === run) this.activeRun = null
  }

  private requireWorkspace(): WorkspaceContext {
    const context = this.currentWorkspaceContext()
    if (!context) {
      throw new Error('Code Graph 尚未绑定 workspace')
    }
    return context
  }

  private currentWorkspaceContext(): WorkspaceContext | null {
    if (!this.workspace || !this.stateReaderProvider || this.snapshot.workspaceIdentity === null) {
      return null
    }
    return {
      epoch: this.workspaceEpoch,
      workspace: this.workspace,
      stateReaderProvider: this.stateReaderProvider
    }
  }

  private matchesContext(context: WorkspaceContext): boolean {
    return this.matchesWorkspace(
      context.epoch,
      context.workspace.workspaceIdentity,
      context.stateReaderProvider
    ) && this.workspace === context.workspace
  }

  private matchesWorkspace(
    epoch: number,
    workspaceIdentity: string,
    stateReaderProvider: CodeGraphStateReaderProvider
  ): boolean {
    return this.workspaceEpoch === epoch &&
      this.snapshot.workspaceIdentity === workspaceIdentity &&
      this.stateReaderProvider === stateReaderProvider
  }

  private isCurrentOperation(operation: CodeIndexOperation): boolean {
    return this.activeOperation?.operationId === operation.operationId &&
      this.activeOperation.workspaceIdentity === operation.workspaceIdentity &&
      this.activeOperation.generation === operation.generation &&
      this.snapshot.workspaceIdentity === operation.workspaceIdentity
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

interface WorkerFailureDetails {
  readonly failure: CodeIndexFailure
  readonly committedMetadata: CodeGraphMetadata | null
}

interface StoredCodeGraphState {
  readonly metadata: CodeGraphMetadata
  readonly coverage: CodeIndexSnapshot['coverage']
  readonly nextGeneration: number
}

function snapshotFromMetadata(
  metadata: CodeGraphMetadata,
  coverage: CodeIndexSnapshot['coverage'],
  workerState: CodeIndexWorkerState
): CodeIndexSnapshot {
  return createSnapshot({
    workspaceIdentity: metadata.workspaceIdentity,
    activeGeneration: metadata.activeGeneration,
    revision: metadata.revision,
    status: metadata.activeGeneration === null ? 'idle' : 'ready',
    coverage,
    lastCompletedAt: metadata.lastCompletedAt,
    workerState
  })
}

function createSnapshot(input: Partial<CodeIndexSnapshot>): CodeIndexSnapshot {
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
    failure,
    workerState: input.workerState ?? 'stopped'
  })
}

function workerFailureDetails(error: unknown): WorkerFailureDetails {
  if (error instanceof CodeIndexWorkerRunError) {
    return Object.freeze({ failure: error.failure, committedMetadata: error.committedMetadata })
  }
  if (error instanceof CodeIndexWorkerMissingError) {
    return Object.freeze({ failure: error.failure, committedMetadata: null })
  }
  return Object.freeze({
    failure: failureFromError('worker_crash', error),
    committedMetadata: null
  })
}

function assertWorkerResult(
  result: CodeIndexWorkerRunResult,
  operation: CodeIndexOperation
): void {
  if (
    result.operation.operationId !== operation.operationId ||
    result.operation.workspaceIdentity !== operation.workspaceIdentity ||
    result.operation.generation !== operation.generation
  ) throw new Error('Code Index Worker 返回了 stale operation')
  assertCommittedMetadata(result.metadata, operation)
}

function assertCommittedMetadata(
  metadata: CodeGraphMetadata,
  operation: CodeIndexOperation
): void {
  if (!isCommittedMetadata(metadata, operation)) {
    throw new Error('Code Index Worker 返回了不一致的提交结果')
  }
}

function isCommittedMetadata(
  metadata: CodeGraphMetadata,
  operation: CodeIndexOperation
): boolean {
  return metadata.workspaceIdentity === operation.workspaceIdentity &&
    metadata.activeGeneration === operation.generation &&
    metadata.revision === operation.baseRevision + 1
}

function assertMetadataIdentity(metadata: CodeGraphMetadata, expected: string): void {
  if (metadata.workspaceIdentity !== expected) {
    throw new Error('Code Graph 状态读取器返回了其他 workspace')
  }
}

function assertProgress(progress: CodeIndexProgress): void {
  if (
    !Number.isInteger(progress.completed) || !Number.isInteger(progress.total) ||
    progress.completed < 0 || progress.total < 0 || progress.completed > progress.total
  ) throw new Error('Code Graph progress 无效')
}

function assertWorkspace(workspace: CodeIndexWorkerWorkspace): void {
  if (!workspace.workspaceIdentity || !workspace.workspaceRoot || !workspace.dbPath) {
    throw new Error('Code Graph workspace 契约不完整')
  }
}

function freezeOperation(operation: CodeIndexOperation): CodeIndexOperation {
  return Object.freeze({ ...operation })
}

function failureFromError(code: CodeIndexFailure['code'], error: unknown): CodeIndexFailure {
  return Object.freeze({
    code,
    message: error instanceof Error ? error.message : String(error)
  })
}
