import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  codeGraphRuntimeCountForTests,
  closeCodeGraphForWorkspace,
  ensureCodeGraphForWorkspace,
  getCodeContextQueryPort,
  InitializedCodeGraphRuntime,
  resetCodeGraphHostForTests,
  scheduleCodeGraphStartupGc,
  setCodeGraphRuntimeFactoryForTests,
  setCodeGraphStartupGcRunnerForTests,
  type CodeGraphRuntimeHandle
} from '../../../src/main/services/CodeGraphHost'
import { createEmptyCodeContextPack } from '../../../src/runtime/code-graph/context'
import type {
  CodeIndexSnapshot,
  WorkspaceChangeErrorListener,
  WorkspaceChangeListener,
  WorkspaceChangeSource
} from '../../../src/runtime/code-graph'

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir() }
}))

describe('CodeGraphHost', () => {
  const roots: string[] = []

  afterEach(async () => {
    await resetCodeGraphHostForTests()
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  it('同一工作区只装配一个 Runtime，切走时只关闭对应 handle', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'nova-code-graph-host-'))
    const secondWorkspace = join(workspace, 'second')
    mkdirSync(secondWorkspace)
    roots.push(workspace)
    const created: string[] = []
    const closed: string[] = []
    const accessed: number[] = []
    setCodeGraphRuntimeFactoryForTests((workspaceRoot) => {
      created.push(workspaceRoot)
      const handle: CodeGraphRuntimeHandle = {
        queryPort: {
          query: async () => createEmptyCodeContextPack({
            status: 'ready',
            intent: 'locate',
            summary: 'ready · locate · test',
            warnings: []
          })
        },
        start: async () => undefined,
        touchAccess: async (accessedAt) => {
          accessed.push(accessedAt)
        },
        close: async () => {
          closed.push(workspaceRoot)
        }
      }
      return handle
    })

    const first = ensureCodeGraphForWorkspace(workspace)
    const reused = ensureCodeGraphForWorkspace(workspace)
    ensureCodeGraphForWorkspace(secondWorkspace)

    expect(reused).toBe(first)
    expect(getCodeContextQueryPort(workspace)).toBe(first)
    expect(created).toHaveLength(2)
    await vi.waitFor(() => expect(accessed).toHaveLength(2))
    expect(codeGraphRuntimeCountForTests()).toBe(2)

    await closeCodeGraphForWorkspace(workspace)
    expect(closed).toEqual([created[0]])
    expect(codeGraphRuntimeCountForTests()).toBe(1)
    expect(getCodeContextQueryPort(workspace)).toBeNull()
  })

  it('启动 GC 不依赖启用会话，并保护启动时的活动工作区', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'nova-code-graph-gc-'))
    roots.push(workspace)
    const runner = vi.fn(async () => ({
      freedBytes: 0,
      retainedBytes: 0,
      removedWorkspaceIdentities: [],
      diagnostics: []
    }))
    setCodeGraphStartupGcRunnerForTests(runner)

    scheduleCodeGraphStartupGc(true, workspace)
    scheduleCodeGraphStartupGc(true, null)

    await vi.waitFor(() => expect(runner).toHaveBeenCalledOnce())
    expect(runner).toHaveBeenCalledWith({
      appDataPath: tmpdir(),
      activeWorkspaceIdentity: expect.stringMatching(/^[a-f0-9]{16}$/)
    })
  })

  it('没有活动工作区时仍调度启动 GC', async () => {
    const runner = vi.fn(async () => ({
      freedBytes: 0,
      retainedBytes: 0,
      removedWorkspaceIdentities: [],
      diagnostics: []
    }))
    setCodeGraphStartupGcRunnerForTests(runner)

    scheduleCodeGraphStartupGc(true, null)

    await vi.waitFor(() => expect(runner).toHaveBeenCalledWith({
      appDataPath: tmpdir(),
      activeWorkspaceIdentity: null
    }))
  })

  it('功能关闭时不加载或触达代码索引缓存', async () => {
    const runner = vi.fn(async () => ({
      freedBytes: 0,
      retainedBytes: 0,
      removedWorkspaceIdentities: [],
      diagnostics: []
    }))
    setCodeGraphStartupGcRunnerForTests(runner)

    scheduleCodeGraphStartupGc(false, null)
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(runner).not.toHaveBeenCalled()

    scheduleCodeGraphStartupGc(true, null)
    await vi.waitFor(() => expect(runner).toHaveBeenCalledOnce())
  })

  it('Host 立即完成装配，但只在 watcher ready 后启动 drift', async () => {
    const source = new ControlledChangeSource()
    const snapshot = readySnapshot()
    const coordinator = coordinatorPort(snapshot)
    const runtime = new InitializedCodeGraphRuntime(
      coordinator,
      workerWorkspace(),
      { getStateReader: async () => null, close: async () => undefined },
      async () => source,
      { query: async () => createEmptyCodeContextPack({
        status: 'ready', intent: 'locate', summary: 'ready', warnings: []
      }) }
    )

    await runtime.start()
    expect(coordinator.checkDrift).not.toHaveBeenCalled()
    source.markReady()
    await vi.waitFor(() => expect(coordinator.checkDrift).toHaveBeenCalledOnce())

    await runtime.close()
    expect(source.closeCalls).toBe(1)
    expect(coordinator.closeWorkspace).toHaveBeenCalledWith('workspace-a')
  })

  it('watcher 初始化失败进入 degraded，但不阻止首次冷建', async () => {
    const source = new ControlledChangeSource()
    const snapshot = { ...readySnapshot(), activeGeneration: null, revision: 0, status: 'idle' as const }
    const coordinator = coordinatorPort(snapshot)
    const runtime = new InitializedCodeGraphRuntime(
      coordinator,
      workerWorkspace(),
      { getStateReader: async () => null, close: async () => undefined },
      async () => source,
      { query: async () => createEmptyCodeContextPack({
        status: 'building', intent: 'locate', summary: 'building', warnings: []
      }) }
    )

    await runtime.start()
    source.fail(new Error('recursive watch failed'))
    await vi.waitFor(() => expect(coordinator.rebuild).toHaveBeenCalledOnce())
    expect(coordinator.reportChangeSourceFailure).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'recursive watch failed' })
    )
    await runtime.close()
  })
})

class ControlledChangeSource implements WorkspaceChangeSource {
  closeCalls = 0
  private changeListener: WorkspaceChangeListener | null = null
  private errorListener: WorkspaceChangeErrorListener | null = null
  private resolveReady: (() => void) | null = null
  private rejectReady: ((error: Error) => void) | null = null
  private readonly ready = new Promise<void>((resolveReady, rejectReady) => {
    this.resolveReady = resolveReady
    this.rejectReady = rejectReady
  })

  subscribe(listener: WorkspaceChangeListener): () => void {
    this.changeListener = listener
    return () => {
      if (this.changeListener === listener) this.changeListener = null
    }
  }

  subscribeError(listener: WorkspaceChangeErrorListener): () => void {
    this.errorListener = listener
    return () => {
      if (this.errorListener === listener) this.errorListener = null
    }
  }

  whenReady(): Promise<void> {
    return this.ready
  }

  markReady(): void {
    this.resolveReady?.()
  }

  fail(error: Error): void {
    this.errorListener?.(error)
    this.rejectReady?.(error)
  }

  async close(): Promise<void> {
    this.closeCalls += 1
    this.rejectReady?.(new Error('closed'))
  }
}

function coordinatorPort(snapshot: CodeIndexSnapshot) {
  return {
    getSnapshot: vi.fn(() => snapshot),
    openWorkspace: vi.fn(async () => snapshot),
    closeWorkspace: vi.fn(async () => undefined),
    rebuild: vi.fn(async () => true),
    checkDrift: vi.fn(async () => true),
    touchAccess: vi.fn(async () => true),
    notifyWorkspaceChange: vi.fn(),
    reportChangeSourceFailure: vi.fn()
  }
}

function readySnapshot(): CodeIndexSnapshot {
  return {
    workspaceIdentity: 'workspace-a',
    activeGeneration: 1,
    revision: 1,
    status: 'ready',
    coverage: {
      eligibleFiles: 1,
      indexedFiles: 1,
      parseFailures: 0,
      unsupportedFiles: 0,
      oversizedFiles: 0,
      unresolvedRelations: 0
    },
    progress: null,
    lastCompletedAt: 1,
    failure: null,
    workerState: 'stopped'
  }
}

function workerWorkspace() {
  return {
    workspaceIdentity: 'workspace-a',
    workspaceRoot: join(tmpdir(), 'workspace-a'),
    dbPath: join(tmpdir(), 'workspace-a', 'index.db'),
    parserSignature: 'parser-v1',
    resolverSignature: 'resolver-v1',
    coreWasmPath: join(tmpdir(), 'core.wasm'),
    grammarWasmPaths: {
      javascript: join(tmpdir(), 'javascript.wasm'),
      typescript: join(tmpdir(), 'typescript.wasm'),
      tsx: join(tmpdir(), 'tsx.wasm'),
      python: join(tmpdir(), 'python.wasm')
    }
  }
}
