import { existsSync } from 'node:fs'
import { Worker } from 'node:worker_threads'
import type { CodeIndexFailure } from '../types'
import {
  CODE_INDEX_WORKER_CANCEL_GRACE_MS,
  CodeIndexWorkerMissingError,
  CodeIndexWorkerRunError,
  parseCodeIndexWorkerMessage,
  type CodeIndexHostToWorkerMessage,
  type CodeIndexWorkerPort,
  type CodeIndexWorkerRunOptions,
  type CodeIndexWorkerRunRequest,
  type CodeIndexWorkerRunResult
} from './protocol'

export { CodeIndexWorkerMissingError, CodeIndexWorkerRunError } from './protocol'

export interface CodeIndexWorkerThread {
  postMessage(message: CodeIndexHostToWorkerMessage): void
  on(event: 'message', listener: (value: unknown) => void): this
  once(event: 'error', listener: (error: Error) => void): this
  once(event: 'exit', listener: (code: number) => void): this
  terminate(): Promise<number>
}

export type CodeIndexWorkerThreadFactory = (
  workerPath: string,
  abortFlag: Int32Array
) => CodeIndexWorkerThread

export interface CodeIndexWorkerClientOptions {
  readonly workerPath: string
  readonly cancelGraceMs?: number
  readonly createThread?: CodeIndexWorkerThreadFactory
}

interface ActiveRequest {
  readonly requestId: number
  readonly request: CodeIndexWorkerRunRequest
  readonly options: CodeIndexWorkerRunOptions
  readonly resolve: (result: CodeIndexWorkerRunResult) => void
  readonly reject: (error: CodeIndexWorkerRunError) => void
  readonly completion: Promise<void>
  readonly complete: () => void
}

/** 低层适配器只管消息往返与线程终止，索引生命周期由 Coordinator 拥有。 */
export class CodeIndexWorkerClient implements CodeIndexWorkerPort {
  private readonly thread: CodeIndexWorkerThread
  private readonly abortFlag = new Int32Array(new SharedArrayBuffer(4))
  private readonly cancelGraceMs: number
  private nextRequestId = 1
  private active: ActiveRequest | null = null
  private disposed = false
  private terminalMessage: string | null = null
  private readonly terminalListeners = new Set<(failure: CodeIndexFailure) => void>()

  constructor(private readonly options: CodeIndexWorkerClientOptions) {
    if (!options.createThread && !existsSync(options.workerPath)) {
      throw new CodeIndexWorkerMissingError(
        `Code Index Worker 产物不存在：${options.workerPath}`
      )
    }
    this.cancelGraceMs = options.cancelGraceMs ?? CODE_INDEX_WORKER_CANCEL_GRACE_MS
    if (!Number.isFinite(this.cancelGraceMs) || this.cancelGraceMs < 0) {
      throw new Error('Code Index Worker 取消宽限必须是非负数')
    }
    const createThread = options.createThread ?? defaultThreadFactory
    try {
      this.thread = createThread(options.workerPath, this.abortFlag)
    } catch (error) {
      throw new CodeIndexWorkerMissingError(
        `Code Index Worker 启动失败：${errorMessage(error)}`
      )
    }
    this.thread.on('message', (value) => this.onMessage(value))
    this.thread.once('error', (error) => this.handleTerminalFailure(error.message))
    this.thread.once('exit', (code) => {
      if (!this.disposed) this.handleTerminalFailure(
        this.active === null
          ? `Code Index Worker 意外退出（code=${code}）`
          : `Code Index Worker 在任务完成前退出（code=${code}）`
      )
    })
  }

  run(
    request: CodeIndexWorkerRunRequest,
    options: CodeIndexWorkerRunOptions = {}
  ): Promise<CodeIndexWorkerRunResult> {
    if (this.disposed || this.terminalMessage !== null) {
      return Promise.reject(new CodeIndexWorkerRunError({
        code: 'worker_crash',
        message: this.terminalMessage ?? 'Code Index Worker 已关闭'
      }, null))
    }
    if (this.active !== null) {
      return Promise.reject(new CodeIndexWorkerRunError({
        code: 'worker_crash',
        message: 'Code Index Worker 已有写操作运行中'
      }, null))
    }
    Atomics.store(this.abortFlag, 0, 0)
    const requestId = this.nextRequestId++
    const deferred = completionDeferred()
    return new Promise<CodeIndexWorkerRunResult>((resolve, reject) => {
      const active: ActiveRequest = {
        requestId,
        request,
        options,
        resolve,
        reject,
        completion: deferred.promise,
        complete: deferred.resolve
      }
      this.active = active
      try {
        this.thread.postMessage({
          kind: 'run',
          requestId,
          request
        })
      } catch (error) {
        this.rejectActive(active, terminalError(`Code Index Worker 发送失败：${errorMessage(error)}`))
      }
    })
  }

  async cancel(operationId: string): Promise<void> {
    const active = this.active
    if (!active || active.request.operation.operationId !== operationId) return
    Atomics.store(this.abortFlag, 0, 1)
    try {
      this.thread.postMessage({
        kind: 'cancel',
        requestId: active.requestId,
        operationId
      })
    } catch {
      await this.terminateStalled(active)
      return
    }

    let timer: ReturnType<typeof setTimeout> | null = null
    const timedOut = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(true), this.cancelGraceMs)
    })
    const completed = active.completion.then(() => false)
    const shouldTerminate = await Promise.race([completed, timedOut])
    if (timer) clearTimeout(timer)
    if (shouldTerminate && this.active === active) await this.terminateStalled(active)
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    Atomics.store(this.abortFlag, 0, 1)
    const active = this.active
    if (active) {
      this.rejectActive(active, new CodeIndexWorkerRunError({
        code: 'build_cancelled',
        message: 'Code Index Worker 已关闭'
      }, null))
    }
    await this.thread.terminate()
  }

  onTerminalFailure(listener: (failure: CodeIndexFailure) => void): () => void {
    this.terminalListeners.add(listener)
    if (this.terminalMessage !== null) {
      listener(Object.freeze({ code: 'worker_crash', message: this.terminalMessage }))
    }
    return () => this.terminalListeners.delete(listener)
  }

  private onMessage(value: unknown): void {
    const active = this.active
    if (!active) return
    const message = parseCodeIndexWorkerMessage(value)
    if (!message || message.requestId !== active.requestId) {
      this.rejectActive(active, terminalError('Code Index Worker 返回了无效协议消息'))
      void this.thread.terminate()
      return
    }
    if (message.kind === 'progress') {
      if (message.operationId !== active.request.operation.operationId) {
        this.rejectActive(active, terminalError('Code Index Worker 进度属于其他 operation'))
        void this.thread.terminate()
        return
      }
      try {
        active.options.onProgress?.(message.progress)
      } catch {
        // 进度观察者不能破坏 Worker 传输层。
      }
      return
    }
    if (message.kind === 'failure') {
      if (message.operationId !== active.request.operation.operationId) {
        this.rejectActive(active, terminalError('Code Index Worker 失败结果属于其他 operation'))
      } else {
        this.rejectActive(
          active,
          new CodeIndexWorkerRunError(message.failure, message.committedMetadata)
        )
      }
      return
    }
    if (!sameOperation(message.result.operation, active.request.operation)) {
      this.rejectActive(active, terminalError('Code Index Worker 结果 operation 不匹配'))
      return
    }
    this.resolveActive(active, message.result)
  }

  private handleTerminalFailure(message: string): void {
    if (this.disposed || this.terminalMessage !== null) return
    this.terminalMessage = message
    const active = this.active
    if (active) this.rejectActive(active, terminalError(message))
    const failure: CodeIndexFailure = Object.freeze({ code: 'worker_crash', message })
    for (const listener of this.terminalListeners) {
      try {
        listener(failure)
      } catch {
        // 传输层终态通知不能阻断其他观察者清理。
      }
    }
  }

  private resolveActive(
    active: ActiveRequest,
    result: CodeIndexWorkerRunResult
  ): void {
    if (this.active !== active) return
    this.active = null
    active.complete()
    active.resolve(result)
  }

  private rejectActive(active: ActiveRequest, error: CodeIndexWorkerRunError): void {
    if (this.active !== active) return
    this.active = null
    active.complete()
    active.reject(error)
  }

  private async terminateStalled(active: ActiveRequest): Promise<void> {
    if (this.active === active) {
      this.handleTerminalFailure('Code Index Worker 取消超时，已强制终止')
    }
    await this.thread.terminate()
  }
}

function defaultThreadFactory(workerPath: string, abortFlag: Int32Array): Worker {
  return new Worker(workerPath, { workerData: { abortFlag } })
}

function sameOperation(
  left: CodeIndexWorkerRunRequest['operation'],
  right: CodeIndexWorkerRunRequest['operation']
): boolean {
  return left.operationId === right.operationId &&
    left.kind === right.kind &&
    left.workspaceIdentity === right.workspaceIdentity &&
    left.generation === right.generation &&
    left.baseGeneration === right.baseGeneration &&
    left.baseRevision === right.baseRevision
}

function terminalError(message: string): CodeIndexWorkerRunError {
  return new CodeIndexWorkerRunError({ code: 'worker_crash', message }, null)
}

function completionDeferred(): {
  readonly promise: Promise<void>
  readonly resolve: () => void
} {
  let complete: (() => void) | null = null
  const promise = new Promise<void>((resolve) => {
    complete = resolve
  })
  return {
    promise,
    resolve: () => complete?.()
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
