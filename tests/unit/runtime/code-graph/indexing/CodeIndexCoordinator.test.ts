import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CodeIndexCoordinator,
  CodeIndexWorkerRunError,
  STRUCTURAL_RESOLVER_SIGNATURE,
  TREE_SITTER_PARSER_SIGNATURE,
  type CodeGraphMetadata,
  type CodeGraphStateReader,
  type CodeGraphStateReaderProvider,
  type CodeIndexCoverage,
  type CodeIndexWorkerPort,
  type CodeIndexWorkerRunOptions,
  type CodeIndexWorkerRunRequest,
  type CodeIndexWorkerRunResult,
  type CodeIndexWorkerWorkspace
} from '@runtime/code-graph'

const EMPTY_COVERAGE: CodeIndexCoverage = {
  eligibleFiles: 0,
  indexedFiles: 0,
  parseFailures: 0,
  unsupportedFiles: 0,
  oversizedFiles: 0,
  unresolvedRelations: 0
}

class FakeStateReader implements CodeGraphStateReader {
  constructor(
    private readonly metadata: CodeGraphMetadata,
    private readonly coverage: CodeIndexCoverage = EMPTY_COVERAGE
  ) {}

  async getMetadata(): Promise<CodeGraphMetadata> {
    return this.metadata
  }

  async nextGeneration(): Promise<number> {
    return (this.metadata.activeGeneration ?? 0) + 1
  }

  async getCoverage(): Promise<CodeIndexCoverage> {
    return this.coverage
  }
}

class MutableStateProvider implements CodeGraphStateReaderProvider {
  constructor(private reader: CodeGraphStateReader | null) {}

  setReader(reader: CodeGraphStateReader): void {
    this.reader = reader
  }

  async getStateReader(): Promise<CodeGraphStateReader | null> {
    return this.reader
  }
}

class DeferredWorker implements CodeIndexWorkerPort {
  readonly runCalls: CodeIndexWorkerRunRequest[] = []
  readonly cancelled: string[] = []
  disposeCalls = 0
  private active: {
    readonly request: CodeIndexWorkerRunRequest
    readonly options: CodeIndexWorkerRunOptions
    readonly resolve: (result: CodeIndexWorkerRunResult) => void
    readonly reject: (error: CodeIndexWorkerRunError) => void
  } | null = null
  private terminalListener: ((failure: ConstructorParameters<typeof CodeIndexWorkerRunError>[0]) => void) | null = null

  run(
    request: CodeIndexWorkerRunRequest,
    options: CodeIndexWorkerRunOptions = {}
  ): Promise<CodeIndexWorkerRunResult> {
    this.runCalls.push(request)
    return new Promise((resolveRun, rejectRun) => {
      this.active = {
        request,
        options,
        resolve: resolveRun,
        reject: rejectRun
      }
    })
  }

  emitProgress(completed: number, total: number): void {
    this.active?.options.onProgress?.({ completed, total })
  }

  complete(coverage: CodeIndexCoverage = EMPTY_COVERAGE): void {
    const active = this.takeActive()
    active.resolve(successResult(active.request, coverage))
  }

  fail(
    code: ConstructorParameters<typeof CodeIndexWorkerRunError>[0]['code'],
    message: string,
    committedMetadata: CodeGraphMetadata | null = null
  ): void {
    const active = this.takeActive()
    active.reject(new CodeIndexWorkerRunError({ code, message }, committedMetadata))
  }

  async cancel(operationId: string): Promise<void> {
    this.cancelled.push(operationId)
    if (this.active?.request.operation.operationId !== operationId) return
    const active = this.takeActive()
    active.reject(new CodeIndexWorkerRunError({
      code: 'build_cancelled',
      message: 'cancelled'
    }, null))
  }

  async dispose(): Promise<void> {
    this.disposeCalls += 1
    if (this.active) {
      const active = this.takeActive()
      active.reject(new CodeIndexWorkerRunError({
        code: 'build_cancelled',
        message: 'disposed'
      }, null))
    }
  }

  onTerminalFailure(
    listener: (failure: ConstructorParameters<typeof CodeIndexWorkerRunError>[0]) => void
  ): () => void {
    this.terminalListener = listener
    return () => {
      if (this.terminalListener === listener) this.terminalListener = null
    }
  }

  emitTerminalFailure(message: string): void {
    const active = this.active
    this.terminalListener?.({ code: 'worker_crash', message })
    if (active && this.active === active) {
      this.active = null
      active.reject(new CodeIndexWorkerRunError({ code: 'worker_crash', message }, null))
    }
  }

  private takeActive() {
    const active = this.active
    if (!active) throw new Error('没有运行中的 Worker 请求')
    this.active = null
    return active
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('CodeIndexCoordinator Worker lifecycle', () => {
  it('打开 workspace 不启 Worker，构建后只接受 Worker 提交结果', async () => {
    const worker = new DeferredWorker()
    const createWorker = vi.fn(() => worker)
    const coordinator = new CodeIndexCoordinator({
      createWorker,
      generateOperationId: () => 'operation-1'
    })
    await coordinator.openWorkspace(
      workspace('workspace-a'),
      stateProvider(new FakeStateReader(metadata('workspace-a')))
    )
    expect(createWorker).not.toHaveBeenCalled()
    expect(coordinator.getSnapshot()).toMatchObject({
      status: 'idle',
      workerState: 'stopped'
    })

    const rebuild = coordinator.rebuild()
    await vi.waitFor(() => expect(worker.runCalls).toHaveLength(1))
    worker.emitProgress(1, 2)
    expect(coordinator.getSnapshot()).toMatchObject({
      status: 'building',
      workerState: 'running',
      progress: { completed: 1, total: 2 }
    })
    const coverage = { ...EMPTY_COVERAGE, eligibleFiles: 2, indexedFiles: 2 }
    worker.complete(coverage)
    await expect(rebuild).resolves.toBe(true)

    const snapshot = coordinator.getSnapshot()
    expect(snapshot).toMatchObject({
      status: 'ready',
      activeGeneration: 1,
      revision: 1,
      coverage,
      workerState: 'idle'
    })
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.coverage)).toBe(true)
  })

  it('重复构建请求复用同一 in-flight operation', async () => {
    const worker = new DeferredWorker()
    const coordinator = new CodeIndexCoordinator({
      createWorker: () => worker,
      generateOperationId: () => 'operation-dedup'
    })
    await coordinator.openWorkspace(workspace('workspace-a'), stateProvider(null))

    const first = coordinator.rebuild()
    const second = coordinator.rebuild()
    expect(second).toBe(first)
    await vi.waitFor(() => expect(worker.runCalls).toHaveLength(1))
    worker.complete()
    await expect(first).resolves.toBe(true)
  })

  it('空闲超时释放 Worker，查询端保留且新构建能冷启', async () => {
    vi.useFakeTimers()
    const workers = [new DeferredWorker(), new DeferredWorker()]
    const createWorker = vi.fn(() => {
      const next = workers.shift()
      if (!next) throw new Error('缺少 fake Worker')
      return next
    })
    const reader = new FakeStateReader(metadata('workspace-a', 1, 1))
    const coordinator = new CodeIndexCoordinator({
      createWorker,
      idleTimeoutMs: 100,
      generateOperationId: () => `operation-${createWorker.mock.calls.length + 1}`
    })
    await coordinator.openWorkspace(workspace('workspace-a'), stateProvider(reader))

    const first = coordinator.rebuild()
    await vi.advanceTimersByTimeAsync(0)
    const firstWorker = createWorker.mock.results[0]?.value
    if (!(firstWorker instanceof DeferredWorker)) throw new Error('未创建首个 Worker')
    firstWorker.complete()
    await first
    expect(await reader.getMetadata()).toMatchObject({ revision: 1 })

    await vi.advanceTimersByTimeAsync(100)
    expect(firstWorker.disposeCalls).toBe(1)
    expect(coordinator.getSnapshot().workerState).toBe('stopped')

    const second = coordinator.rebuild()
    await vi.advanceTimersByTimeAsync(0)
    const secondWorker = createWorker.mock.results[1]?.value
    if (!(secondWorker instanceof DeferredWorker)) throw new Error('未创建第二个 Worker')
    secondWorker.complete()
    await expect(second).resolves.toBe(true)
    expect(createWorker).toHaveBeenCalledTimes(2)
    expect(coordinator.getSnapshot()).toMatchObject({
      status: 'ready',
      activeGeneration: 3,
      revision: 3
    })
  })

  it('取消会结束 building 且不推进 revision', async () => {
    const worker = new DeferredWorker()
    const coordinator = new CodeIndexCoordinator({
      createWorker: () => worker,
      generateOperationId: () => 'operation-cancel'
    })
    await coordinator.openWorkspace(workspace('workspace-a'), stateProvider(null))
    const rebuild = coordinator.rebuild()
    await vi.waitFor(() => expect(worker.runCalls).toHaveLength(1))

    await expect(coordinator.cancelCurrentOperation()).resolves.toBe(true)
    await expect(rebuild).resolves.toBe(false)
    expect(worker.cancelled).toEqual(['operation-cancel'])
    expect(coordinator.getSnapshot()).toMatchObject({
      status: 'idle',
      revision: 0,
      progress: null,
      workerState: 'idle'
    })
  })

  it('Worker terminal failure 保留 last-good 并允许后续显式重启', async () => {
    const firstWorker = new DeferredWorker()
    const secondWorker = new DeferredWorker()
    const workers = [firstWorker, secondWorker]
    const coordinator = new CodeIndexCoordinator({
      createWorker: () => {
        const next = workers.shift()
        if (!next) throw new Error('缺少 fake Worker')
        return next
      }
    })
    await coordinator.openWorkspace(
      workspace('workspace-a'),
      stateProvider(new FakeStateReader(metadata('workspace-a', 2, 4)))
    )
    const failed = coordinator.rebuild()
    await vi.waitFor(() => expect(firstWorker.runCalls).toHaveLength(1))
    firstWorker.emitTerminalFailure('worker exited')
    await expect(failed).resolves.toBe(false)
    expect(coordinator.getSnapshot()).toMatchObject({
      status: 'degraded',
      activeGeneration: 2,
      revision: 4,
      workerState: 'failed',
      failure: { code: 'worker_crash' }
    })

    const retry = coordinator.rebuild()
    await vi.waitFor(() => expect(secondWorker.runCalls).toHaveLength(1))
    secondWorker.complete()
    await expect(retry).resolves.toBe(true)
  })

  it('Worker 提交后立即崩溃仍从只读状态恢复且下次基线正确', async () => {
    const firstWorker = new DeferredWorker()
    const secondWorker = new DeferredWorker()
    const workers = [firstWorker, secondWorker]
    const provider = new MutableStateProvider(null)
    let operationSequence = 0
    const coordinator = new CodeIndexCoordinator({
      createWorker: () => {
        const next = workers.shift()
        if (!next) throw new Error('缺少 fake Worker')
        return next
      },
      generateOperationId: () => `operation-${++operationSequence}`
    })
    await coordinator.openWorkspace(workspace('workspace-a'), provider)
    const failed = coordinator.rebuild()
    await vi.waitFor(() => expect(firstWorker.runCalls).toHaveLength(1))

    provider.setReader(new FakeStateReader(metadata('workspace-a', 1, 1)))
    firstWorker.emitTerminalFailure('worker exited after commit')
    await expect(failed).resolves.toBe(false)
    await vi.waitFor(() => expect(coordinator.getSnapshot()).toMatchObject({
      status: 'degraded',
      activeGeneration: 1,
      revision: 1,
      workerState: 'failed',
      failure: { code: 'worker_crash' }
    }))

    const retry = coordinator.rebuild()
    await vi.waitFor(() => expect(secondWorker.runCalls).toHaveLength(1))
    expect(secondWorker.runCalls[0]?.operation).toMatchObject({
      generation: 2,
      baseGeneration: 1,
      baseRevision: 1
    })
    secondWorker.complete()
    await expect(retry).resolves.toBe(true)
  })

  it('取消与提交竞态不会丢失已生效的 generation', async () => {
    const worker = new DeferredWorker()
    const provider = new MutableStateProvider(null)
    const coordinator = new CodeIndexCoordinator({
      createWorker: () => worker,
      generateOperationId: () => 'operation-cancelled-after-commit'
    })
    await coordinator.openWorkspace(workspace('workspace-a'), provider)
    const rebuild = coordinator.rebuild()
    await vi.waitFor(() => expect(worker.runCalls).toHaveLength(1))

    provider.setReader(new FakeStateReader(metadata('workspace-a', 1, 1)))
    await expect(coordinator.cancelCurrentOperation()).resolves.toBe(true)
    await expect(rebuild).resolves.toBe(false)
    expect(coordinator.getSnapshot()).toMatchObject({
      status: 'ready',
      activeGeneration: 1,
      revision: 1,
      failure: null,
      workerState: 'idle'
    })
  })

  it('空闲 Worker 崩溃会立即更新唯一状态投影', async () => {
    const worker = new DeferredWorker()
    const coordinator = new CodeIndexCoordinator({ createWorker: () => worker })
    await coordinator.openWorkspace(
      workspace('workspace-a'),
      stateProvider(new FakeStateReader(metadata('workspace-a', 2, 4)))
    )
    const rebuild = coordinator.rebuild()
    await vi.waitFor(() => expect(worker.runCalls).toHaveLength(1))
    worker.complete()
    await rebuild

    worker.emitTerminalFailure('idle worker exited')
    expect(coordinator.getSnapshot()).toMatchObject({
      status: 'degraded',
      workerState: 'failed',
      failure: { code: 'worker_crash', message: 'idle worker exited' }
    })
  })

  it('workspace 切换会取消旧 Worker，旧结果不污染新状态', async () => {
    const worker = new DeferredWorker()
    const coordinator = new CodeIndexCoordinator({
      createWorker: () => worker,
      generateOperationId: () => 'operation-a'
    })
    await coordinator.openWorkspace(workspace('workspace-a'), stateProvider(null))
    const stale = coordinator.rebuild()
    await vi.waitFor(() => expect(worker.runCalls).toHaveLength(1))

    await coordinator.openWorkspace(
      workspace('workspace-b'),
      stateProvider(new FakeStateReader(metadata('workspace-b', 5, 9)))
    )
    await expect(stale).resolves.toBe(false)
    expect(worker.cancelled).toEqual(['operation-a'])
    expect(worker.disposeCalls).toBe(1)
    expect(coordinator.getSnapshot()).toMatchObject({
      workspaceIdentity: 'workspace-b',
      activeGeneration: 5,
      revision: 9,
      status: 'ready',
      workerState: 'stopped'
    })
  })

  it('Worker 未装配时显式 unavailable，不在主线程兜底', async () => {
    const coordinator = new CodeIndexCoordinator()
    await coordinator.openWorkspace(workspace('workspace-a'), stateProvider(null))
    await expect(coordinator.rebuild()).resolves.toBe(false)
    expect(coordinator.getSnapshot()).toMatchObject({
      status: 'unavailable',
      workerState: 'failed',
      failure: { code: 'worker_missing' }
    })
  })

  it('已提交后 coverage 失败仍保留新 generation 与 revision', async () => {
    const worker = new DeferredWorker()
    const coordinator = new CodeIndexCoordinator({ createWorker: () => worker })
    await coordinator.openWorkspace(workspace('workspace-a'), stateProvider(null))
    const rebuild = coordinator.rebuild()
    await vi.waitFor(() => expect(worker.runCalls).toHaveLength(1))
    worker.fail(
      'storage_read_failed',
      'coverage failed',
      metadata('workspace-a', 1, 1)
    )

    await expect(rebuild).resolves.toBe(false)
    expect(coordinator.getSnapshot()).toMatchObject({
      status: 'degraded',
      activeGeneration: 1,
      revision: 1,
      failure: { code: 'storage_read_failed' }
    })
  })
})

function workspace(workspaceIdentity: string): CodeIndexWorkerWorkspace {
  return {
    workspaceIdentity,
    workspaceRoot: resolve(`tmp/${workspaceIdentity}`),
    dbPath: resolve(`tmp/${workspaceIdentity}/index.db`),
    parserSignature: TREE_SITTER_PARSER_SIGNATURE,
    resolverSignature: STRUCTURAL_RESOLVER_SIGNATURE,
    coreWasmPath: resolve('node_modules/web-tree-sitter/web-tree-sitter.wasm'),
    grammarWasmPaths: {
      javascript: resolve('node_modules/@vscode/tree-sitter-wasm/wasm/tree-sitter-javascript.wasm'),
      typescript: resolve('node_modules/@vscode/tree-sitter-wasm/wasm/tree-sitter-typescript.wasm'),
      tsx: resolve('node_modules/@vscode/tree-sitter-wasm/wasm/tree-sitter-tsx.wasm'),
      python: resolve('node_modules/@vscode/tree-sitter-wasm/wasm/tree-sitter-python.wasm')
    }
  }
}

function stateProvider(reader: CodeGraphStateReader | null): CodeGraphStateReaderProvider {
  return {
    getStateReader: async () => reader
  }
}

function metadata(
  workspaceIdentity: string,
  activeGeneration: number | null = null,
  revision = 0
): CodeGraphMetadata {
  return {
    schemaVersion: 1,
    workspaceIdentity,
    activeGeneration,
    revision,
    parserSignature: TREE_SITTER_PARSER_SIGNATURE,
    resolverSignature: STRUCTURAL_RESOLVER_SIGNATURE,
    lastCompletedAt: activeGeneration === null ? null : 100,
    lastAccessed: 100
  }
}

function successResult(
  request: CodeIndexWorkerRunRequest,
  coverage: CodeIndexCoverage
): CodeIndexWorkerRunResult {
  return {
    operation: request.operation,
    metadata: metadata(
      request.operation.workspaceIdentity,
      request.operation.generation,
      request.operation.baseRevision + 1
    ),
    coverage,
    durationMs: 10
  }
}
