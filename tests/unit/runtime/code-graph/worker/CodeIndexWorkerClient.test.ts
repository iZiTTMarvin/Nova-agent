import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  CodeIndexWorkerClient,
  CodeIndexWorkerMissingError,
  CodeIndexWorkerRunError,
  STRUCTURAL_RESOLVER_SIGNATURE,
  TREE_SITTER_PARSER_SIGNATURE,
  type CodeIndexHostToWorkerMessage,
  type CodeIndexWorkerRunRequest,
  type CodeIndexWorkerThread
} from '@runtime/code-graph'

class FakeWorkerThread implements CodeIndexWorkerThread {
  readonly sent: CodeIndexHostToWorkerMessage[] = []
  terminateCalls = 0
  private messageListener: ((value: unknown) => void) | null = null
  private errorListener: ((error: Error) => void) | null = null
  private exitListener: ((code: number) => void) | null = null

  postMessage(message: CodeIndexHostToWorkerMessage): void {
    this.sent.push(message)
  }

  on(event: 'message', listener: (value: unknown) => void): this {
    if (event === 'message') this.messageListener = listener
    return this
  }

  once(event: 'error' | 'exit', listener: ((error: Error) => void) | ((code: number) => void)): this {
    if (event === 'error') {
      this.errorListener = (error) => {
        Reflect.apply(listener, undefined, [error])
      }
    } else {
      this.exitListener = (code) => {
        Reflect.apply(listener, undefined, [code])
      }
    }
    return this
  }

  async terminate(): Promise<number> {
    this.terminateCalls += 1
    return 0
  }

  emitMessage(value: unknown): void {
    this.messageListener?.(value)
  }

  emitError(error: Error): void {
    this.errorListener?.(error)
  }

  emitExit(code: number): void {
    this.exitListener?.(code)
  }
}

describe('CodeIndexWorkerClient', () => {
  it('校验跨线程结果并转发有界进度', async () => {
    const thread = new FakeWorkerThread()
    let abortFlag: Int32Array | null = null
    const client = new CodeIndexWorkerClient({
      workerPath: 'fake-worker.js',
      createThread: (_path, flag) => {
        abortFlag = flag
        return thread
      }
    })
    const progress = vi.fn()
    const request = runRequest()
    const run = client.run(request, { onProgress: progress })

    expect(abortFlag).toBeInstanceOf(Int32Array)
    expect(thread.sent).toEqual([expect.objectContaining({ kind: 'run', requestId: 1 })])
    thread.emitMessage({
      kind: 'progress',
      requestId: 1,
      operationId: request.operation.operationId,
      progress: { completed: 1, total: 2 }
    })
    thread.emitMessage({
      kind: 'result',
      requestId: 1,
      result: successResult(request)
    })

    await expect(run).resolves.toMatchObject({
      metadata: { activeGeneration: 1, revision: 1 }
    })
    expect(progress).toHaveBeenCalledWith({ completed: 1, total: 2 })
    await client.dispose()
  })

  it('取消通过共享标志与协议同时传播', async () => {
    const thread = new FakeWorkerThread()
    let abortFlag: Int32Array | null = null
    const client = new CodeIndexWorkerClient({
      workerPath: 'fake-worker.js',
      createThread: (_path, flag) => {
        abortFlag = flag
        return thread
      }
    })
    const request = runRequest()
    const run = client.run(request)
    const cancelling = client.cancel(request.operation.operationId)
    expect(abortFlag ? Atomics.load(abortFlag, 0) : -1).toBe(1)
    expect(thread.sent).toContainEqual({
      kind: 'cancel',
      requestId: 1,
      operationId: request.operation.operationId
    })
    thread.emitMessage({
      kind: 'failure',
      requestId: 1,
      operationId: request.operation.operationId,
      failure: { code: 'build_cancelled', message: 'cancelled' },
      committedMetadata: null
    })

    await expect(run).rejects.toMatchObject({
      failure: { code: 'build_cancelled' }
    })
    await expect(cancelling).resolves.toBeUndefined()
    await client.dispose()
  })

  it('无效消息与 terminal error 都会清理等待中的 Promise', async () => {
    const invalidThread = new FakeWorkerThread()
    const invalidClient = new CodeIndexWorkerClient({
      workerPath: 'fake-worker.js',
      createThread: () => invalidThread
    })
    const invalidRun = invalidClient.run(runRequest())
    invalidThread.emitMessage({ kind: 'result', requestId: 1, result: 'loose' })
    await expect(invalidRun).rejects.toBeInstanceOf(CodeIndexWorkerRunError)
    expect(invalidThread.terminateCalls).toBe(1)

    const crashedThread = new FakeWorkerThread()
    const crashedClient = new CodeIndexWorkerClient({
      workerPath: 'fake-worker.js',
      createThread: () => crashedThread
    })
    const crashedRun = crashedClient.run(runRequest())
    crashedThread.emitError(new Error('boom'))
    await expect(crashedRun).rejects.toMatchObject({ failure: { code: 'worker_crash' } })
    await invalidClient.dispose()
    await crashedClient.dispose()
  })

  it('生产 Worker 产物缺失时同步报 worker_missing', () => {
    expect(() => new CodeIndexWorkerClient({
      workerPath: resolve('definitely-missing-code-graph-worker.js')
    })).toThrow(CodeIndexWorkerMissingError)
  })

  it('空闲 Worker 退出也会发布 terminal failure，不伪装成可复用', async () => {
    const thread = new FakeWorkerThread()
    const client = new CodeIndexWorkerClient({
      workerPath: 'fake-worker.js',
      createThread: () => thread
    })
    const listener = vi.fn()
    client.onTerminalFailure(listener)
    thread.emitExit(0)

    expect(listener).toHaveBeenCalledWith({
      code: 'worker_crash',
      message: expect.stringContaining('code=0')
    })
    await expect(client.run(runRequest())).rejects.toMatchObject({
      failure: { code: 'worker_crash' }
    })
    await client.dispose()
  })

  it('取消超时后强制终止并发布终态，不把死 Worker 放回空闲池', async () => {
    const thread = new FakeWorkerThread()
    const client = new CodeIndexWorkerClient({
      workerPath: 'fake-worker.js',
      cancelGraceMs: 0,
      createThread: () => thread
    })
    const listener = vi.fn()
    client.onTerminalFailure(listener)
    const request = runRequest()
    const run = client.run(request)

    await client.cancel(request.operation.operationId)
    await expect(run).rejects.toMatchObject({ failure: { code: 'worker_crash' } })
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ code: 'worker_crash' }))
    expect(thread.terminateCalls).toBe(1)
    await client.dispose()
  })
})

function runRequest(): CodeIndexWorkerRunRequest {
  return {
    operation: {
      operationId: 'operation-1',
      kind: 'full-rebuild',
      workspaceIdentity: 'workspace-a',
      generation: 1,
      baseGeneration: null,
      baseRevision: 0
    },
    workspace: {
      workspaceIdentity: 'workspace-a',
      workspaceRoot: resolve('workspace-a'),
      dbPath: resolve('workspace-a/index.db'),
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
}

function successResult(request: CodeIndexWorkerRunRequest) {
  return {
    operation: request.operation,
    outcome: 'committed',
    rebuildReason: null,
    metadata: {
      schemaVersion: 1,
      workspaceIdentity: 'workspace-a',
      activeGeneration: 1,
      revision: 1,
      parserSignature: TREE_SITTER_PARSER_SIGNATURE,
      resolverSignature: STRUCTURAL_RESOLVER_SIGNATURE,
      lastCompletedAt: 100,
      lastAccessed: 100
    },
    coverage: {
      eligibleFiles: 2,
      indexedFiles: 2,
      parseFailures: 0,
      unsupportedFiles: 0,
      oversizedFiles: 0,
      unresolvedRelations: 0
    },
    durationMs: 10
  }
}
