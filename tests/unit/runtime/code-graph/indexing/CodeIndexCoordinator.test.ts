import { describe, expect, it, vi } from 'vitest'
import {
  CODE_INDEX_FAILURE_CODES,
  CodeIndexCoordinator
} from '@runtime/code-graph'
import type {
  CodeGraphFileRecord,
  CodeGraphGenerationActivation,
  CodeGraphGenerationInput,
  CodeGraphIncrementalUpdate,
  CodeGraphMetadata,
  CodeGraphRepository,
  CodeIndexCoverage,
  CodeIndexOperation
} from '@runtime/code-graph'

const EMPTY_COVERAGE: CodeIndexCoverage = {
  eligibleFiles: 0,
  indexedFiles: 0,
  parseFailures: 0,
  unsupportedFiles: 0,
  oversizedFiles: 0,
  unresolvedRelations: 0
}

class FakeCodeGraphRepository implements CodeGraphRepository {
  readonly staged: CodeGraphGenerationInput[] = []
  readonly incremental: CodeGraphIncrementalUpdate[] = []
  incrementalCommitGate: Promise<void> | null = null
  activationCommitGate: Promise<void> | null = null
  activationAttempts = 0
  coverageError: Error | null = null
  private next = 1
  private claimedOperation: CodeIndexOperation | null = null

  constructor(
    private metadata: CodeGraphMetadata,
    private coverage: CodeIndexCoverage = EMPTY_COVERAGE
  ) {
    this.next = (metadata.activeGeneration ?? 0) + 1
  }

  async getMetadata(): Promise<CodeGraphMetadata> {
    return this.metadata
  }

  async nextGeneration(): Promise<number> {
    return this.next++
  }

  async claimOperation(operation: CodeIndexOperation): Promise<void> {
    if (
      operation.workspaceIdentity !== this.metadata.workspaceIdentity ||
      operation.baseGeneration !== this.metadata.activeGeneration ||
      operation.baseRevision !== this.metadata.revision
    ) {
      throw new Error('stale operation claim')
    }
    this.claimedOperation = operation
  }

  async releaseOperation(operation: CodeIndexOperation): Promise<void> {
    if (this.claimedOperation?.operationId === operation.operationId) {
      this.claimedOperation = null
    }
  }

  async getCoverage(): Promise<CodeIndexCoverage> {
    if (this.coverageError) throw this.coverageError
    return this.coverage
  }

  async findActiveFile(): Promise<CodeGraphFileRecord | null> {
    return null
  }

  async stageGeneration(input: CodeGraphGenerationInput): Promise<void> {
    if (this.claimedOperation?.operationId !== input.operationId) {
      throw new Error('write fence expired')
    }
    this.staged.push(input)
  }

  async activateGeneration(
    input: CodeGraphGenerationActivation
  ): Promise<CodeGraphMetadata> {
    this.activationAttempts += 1
    await this.activationCommitGate
    if (this.claimedOperation?.operationId !== input.operationId) {
      throw new Error('write fence expired')
    }
    if (
      input.expectedActiveGeneration !== this.metadata.activeGeneration ||
      input.expectedRevision !== this.metadata.revision
    ) {
      throw new Error('stale activation')
    }
    this.metadata = {
      ...this.metadata,
      activeGeneration: input.generation,
      revision: input.expectedRevision + 1,
      lastCompletedAt: input.completedAt
    }
    this.claimedOperation = null
    return this.metadata
  }

  async applyIncrementalUpdate(
    input: CodeGraphIncrementalUpdate
  ): Promise<CodeGraphMetadata> {
    this.incremental.push(input)
    await this.incrementalCommitGate
    if (this.claimedOperation?.operationId !== input.operationId) {
      throw new Error('write fence expired')
    }
    if (
      input.generation !== this.metadata.activeGeneration ||
      input.expectedRevision !== this.metadata.revision
    ) {
      throw new Error('stale incremental update')
    }
    this.metadata = {
      ...this.metadata,
      revision: input.expectedRevision + 1,
      lastCompletedAt: input.completedAt
    }
    this.claimedOperation = null
    return this.metadata
  }

  async deleteGeneration(): Promise<void> {}

  async touchAccess(accessedAt: number): Promise<void> {
    this.metadata = { ...this.metadata, lastAccessed: accessedAt }
  }

  async close(): Promise<void> {}

  setCoverage(coverage: CodeIndexCoverage): void {
    this.coverage = coverage
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
    parserSignature: 'parser-v1',
    resolverSignature: 'resolver-v1',
    lastCompletedAt: activeGeneration === null ? null : 100,
    lastAccessed: 100
  }
}

function generation(operation: CodeIndexOperation): CodeGraphGenerationInput {
  return {
    operationId: operation.operationId,
    generation: operation.generation,
    parserSignature: 'parser-v1',
    resolverSignature: 'resolver-v1',
    stagedAt: 101,
    files: [],
    symbols: [],
    fileEdges: [],
    symbolEdges: [],
    unresolvedRelations: []
  }
}

function incrementalUpdate(
  operation: CodeIndexOperation,
  completedAt: number
): CodeGraphIncrementalUpdate {
  return {
    operationId: operation.operationId,
    workspaceIdentity: operation.workspaceIdentity,
    generation: operation.generation,
    expectedRevision: operation.baseRevision,
    completedAt,
    removedPaths: [],
    files: [],
    symbols: [],
    fileEdges: [],
    symbolEdges: [],
    unresolvedRelations: []
  }
}

describe('CodeIndexCoordinator', () => {
  it('从空索引构建到 ready，并只发布不可变状态投影', async () => {
    const repository = new FakeCodeGraphRepository(metadata('workspace-a'))
    repository.setCoverage({ ...EMPTY_COVERAGE, eligibleFiles: 2, indexedFiles: 2 })
    const coordinator = new CodeIndexCoordinator({
      generateOperationId: () => 'operation-1'
    })
    const listener = vi.fn(() => {
      throw new Error('listener failure')
    })
    coordinator.subscribe(listener)

    await coordinator.openWorkspace('workspace-a', repository)
    const operation = await coordinator.beginFullRebuild()

    expect(coordinator.getSnapshot()).toMatchObject({
      status: 'building',
      activeGeneration: null,
      revision: 0
    })
    expect(coordinator.reportProgress(operation, { completed: 1, total: 2 })).toBe(true)
    await expect(
      coordinator.commitFullRebuild(operation, generation(operation), 200)
    ).resolves.toBe(true)

    const snapshot = coordinator.getSnapshot()
    expect(snapshot).toMatchObject({
      workspaceIdentity: 'workspace-a',
      status: 'ready',
      activeGeneration: 1,
      revision: 1,
      coverage: { eligibleFiles: 2, indexedFiles: 2 },
      progress: null,
      failure: null
    })
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.coverage)).toBe(true)
    expect(listener).toHaveBeenCalled()
  })

  it('对一批增量变更只推进一次 revision', async () => {
    const repository = new FakeCodeGraphRepository(metadata('workspace-a', 3, 7))
    const coordinator = new CodeIndexCoordinator({
      generateOperationId: () => 'incremental-1'
    })
    await coordinator.openWorkspace('workspace-a', repository)

    const operation = await coordinator.beginIncrementalUpdate()
    expect(coordinator.getSnapshot().status).toBe('updating')
    await expect(
      coordinator.commitIncrementalUpdate(operation, incrementalUpdate(operation, 300))
    ).resolves.toBe(true)

    expect(repository.incremental).toHaveLength(1)
    expect(coordinator.getSnapshot()).toMatchObject({
      status: 'ready',
      activeGeneration: 3,
      revision: 8,
      lastCompletedAt: 300
    })
  })

  it('失败与取消按是否存在 last-good index 收敛到唯一状态', async () => {
    const emptyRepository = new FakeCodeGraphRepository(metadata('workspace-empty'))
    const coordinator = new CodeIndexCoordinator({
      generateOperationId: () => 'operation-empty'
    })
    await coordinator.openWorkspace('workspace-empty', emptyRepository)
    const initialBuild = await coordinator.beginFullRebuild()
    await expect(coordinator.failOperation(initialBuild, {
      code: 'grammar_missing',
      message: 'grammar unavailable'
    })).resolves.toBe(true)
    expect(coordinator.getSnapshot().status).toBe('unavailable')

    const readyRepository = new FakeCodeGraphRepository(metadata('workspace-ready', 2, 4))
    await coordinator.openWorkspace('workspace-ready', readyRepository)
    const update = await coordinator.beginIncrementalUpdate()
    await expect(coordinator.cancelOperation(update)).resolves.toBe(true)
    expect(coordinator.getSnapshot()).toMatchObject({ status: 'ready', revision: 4 })

    const retry = await coordinator.beginIncrementalUpdate()
    await expect(coordinator.failOperation(retry, {
      code: 'parser_failure',
      message: 'one batch failed'
    })).resolves.toBe(true)
    expect(coordinator.getSnapshot()).toMatchObject({
      status: 'degraded',
      activeGeneration: 2,
      revision: 4
    })
  })

  it('workspace 切换后拒绝旧 operation 的完成与重复事件', async () => {
    const repositoryA = new FakeCodeGraphRepository(metadata('workspace-a'))
    const repositoryB = new FakeCodeGraphRepository(metadata('workspace-b', 5, 9))
    let operationNumber = 0
    const coordinator = new CodeIndexCoordinator({
      generateOperationId: () => `operation-${++operationNumber}`
    })
    await coordinator.openWorkspace('workspace-a', repositoryA)
    const stale = await coordinator.beginFullRebuild()

    await coordinator.openWorkspace('workspace-b', repositoryB)
    await expect(
      coordinator.commitFullRebuild(stale, generation(stale), 400)
    ).resolves.toBe(false)
    await expect(coordinator.workerFailed(stale, {
      code: 'worker_crash',
      message: 'old worker exited'
    })).resolves.toBe(false)
    expect(coordinator.reportProgress(stale, { completed: 1, total: 1 })).toBe(false)
    expect(repositoryA.staged).toHaveLength(0)
    expect(coordinator.getSnapshot()).toMatchObject({
      workspaceIdentity: 'workspace-b',
      activeGeneration: 5,
      revision: 9,
      status: 'ready'
    })
  })

  it('新的 rebuild operation 会分配新 generation 并 fence 掉旧结果', async () => {
    const repository = new FakeCodeGraphRepository(metadata('workspace-a'))
    repository.nextGeneration = vi.fn().mockResolvedValue(1)
    let operationNumber = 0
    const coordinator = new CodeIndexCoordinator({
      generateOperationId: () => `operation-${++operationNumber}`
    })
    await coordinator.openWorkspace('workspace-a', repository)
    const stale = await coordinator.beginFullRebuild()
    const current = await coordinator.beginFullRebuild()

    expect([stale.generation, current.generation]).toEqual([1, 2])

    await expect(
      coordinator.commitFullRebuild(stale, generation(stale), 200)
    ).resolves.toBe(false)
    await expect(
      coordinator.commitFullRebuild(current, generation(current), 201)
    ).resolves.toBe(true)
    expect(repository.staged.map((item) => item.operationId)).toEqual(['operation-2'])
  })

  it('worker terminal failure 保留 last-good revision，并关闭 workspace 后清空状态', async () => {
    const repository = new FakeCodeGraphRepository(metadata('workspace-a', 2, 4))
    const coordinator = new CodeIndexCoordinator()
    await coordinator.openWorkspace('workspace-a', repository)
    const operation = await coordinator.beginIncrementalUpdate()

    await coordinator.workerFailed(
      operation,
      { code: 'untrusted-worker-code', message: 'worker exited' }
    )
    expect(coordinator.getSnapshot()).toMatchObject({
      status: 'degraded',
      activeGeneration: 2,
      revision: 4,
      failure: { code: 'worker_crash', message: 'worker exited' }
    })
    expect(Object.isFrozen(CODE_INDEX_FAILURE_CODES)).toBe(true)

    await coordinator.closeWorkspace('workspace-a')
    expect(coordinator.getSnapshot()).toEqual({
      workspaceIdentity: null,
      activeGeneration: null,
      revision: 0,
      status: 'idle',
      coverage: EMPTY_COVERAGE,
      progress: null,
      lastCompletedAt: null,
      failure: null
    })
  })

  it('取消会在延迟增量写入前撤销 write fence，revision 不前进', async () => {
    const repository = new FakeCodeGraphRepository(metadata('workspace-a', 3, 7))
    let releaseCommit: (() => void) | null = null
    repository.incrementalCommitGate = new Promise<void>((resolve) => {
      releaseCommit = resolve
    })
    const coordinator = new CodeIndexCoordinator({
      generateOperationId: () => 'incremental-delayed'
    })
    await coordinator.openWorkspace('workspace-a', repository)
    const operation = await coordinator.beginIncrementalUpdate()
    const commit = coordinator.commitIncrementalUpdate(
      operation,
      incrementalUpdate(operation, 500)
    )
    await vi.waitFor(() => expect(repository.incremental).toHaveLength(1))

    await expect(coordinator.cancelOperation(operation)).resolves.toBe(true)
    releaseCommit?.()
    await expect(commit).rejects.toThrow('write fence expired')

    expect(await repository.getMetadata()).toMatchObject({
      activeGeneration: 3,
      revision: 7
    })
    expect(coordinator.getSnapshot()).toMatchObject({
      status: 'ready',
      activeGeneration: 3,
      revision: 7
    })
  })

  it('取消会阻止已延迟的 generation activation 成为 active', async () => {
    const repository = new FakeCodeGraphRepository(metadata('workspace-a'))
    let releaseActivation: (() => void) | null = null
    repository.activationCommitGate = new Promise<void>((resolve) => {
      releaseActivation = resolve
    })
    const coordinator = new CodeIndexCoordinator({
      generateOperationId: () => 'full-delayed'
    })
    await coordinator.openWorkspace('workspace-a', repository)
    const operation = await coordinator.beginFullRebuild()
    const commit = coordinator.commitFullRebuild(
      operation,
      generation(operation),
      600
    )
    await vi.waitFor(() => expect(repository.activationAttempts).toBe(1))

    await expect(coordinator.cancelOperation(operation)).resolves.toBe(true)
    releaseActivation?.()
    await expect(commit).rejects.toThrow('write fence expired')

    expect(await repository.getMetadata()).toMatchObject({
      activeGeneration: null,
      revision: 0
    })
    expect(coordinator.getSnapshot()).toMatchObject({
      status: 'idle',
      activeGeneration: null,
      revision: 0
    })
  })

  it('提交后 coverage 读取失败仍保留已提交的 generation 与 revision', async () => {
    const repository = new FakeCodeGraphRepository(metadata('workspace-a'))
    const coordinator = new CodeIndexCoordinator({
      generateOperationId: () => 'full-coverage-failure'
    })
    await coordinator.openWorkspace('workspace-a', repository)
    const operation = await coordinator.beginFullRebuild()
    repository.coverageError = new Error('coverage query failed')

    await expect(coordinator.commitFullRebuild(
      operation,
      generation(operation),
      700
    )).rejects.toThrow('coverage query failed')

    expect(await repository.getMetadata()).toMatchObject({
      activeGeneration: 1,
      revision: 1
    })
    expect(coordinator.getSnapshot()).toMatchObject({
      status: 'degraded',
      activeGeneration: 1,
      revision: 1,
      failure: { code: 'storage_read_failed' }
    })
  })
})
