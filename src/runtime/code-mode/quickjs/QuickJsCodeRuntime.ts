/**
 * Worker 承载的 QuickJS Code Runtime（生产装配）。
 * 持有一个长驻 worker_threads Worker：WASM 模块只加载一次，每次 execute 使用
 * 全新沙箱上下文；执行串行排队。中止经 SharedArrayBuffer 标志传播，可打断
 * 阻塞中的同步循环；结果超时未回时强杀 worker 并按资源上限失败。
 */
import { Worker } from 'node:worker_threads'
import type { CodeRuntime, CodeRuntimeExecutionInput, CodeRuntimeExecutionResult, CodeRuntimeToolCallResolution } from '../types'
import type { CodeModeHostToWorkerMessage, CodeModeWorkerToHostMessage } from './protocol'

/** 结果回传的宽限期：超过沙箱时限后仍无响应即视为 worker 失联 */
const RESULT_GRACE_MS = 5_000

interface ActiveExecution {
  readonly requestId: number
  readonly resolve: (result: CodeRuntimeExecutionResult) => void
  watchdog: NodeJS.Timeout | null
  cleanup: () => void
}

export interface QuickJsCodeRuntimeOptions {
  /** 已构建的 worker 入口文件绝对路径（out/main/codeModeWorker.js） */
  readonly workerPath: string
}

export class QuickJsCodeRuntime implements CodeRuntime {
  private worker: Worker | null = null
  private abortFlag: Int32Array | null = null
  private nextRequestId = 1
  private active: ActiveExecution | null = null
  private queue: Array<() => void> = []
  private disposed = false

  constructor(private readonly options: QuickJsCodeRuntimeOptions) {}

  async execute(input: CodeRuntimeExecutionInput): Promise<CodeRuntimeExecutionResult> {
    if (this.disposed) {
      return { status: 'failed', kind: 'execution_error', message: 'Code Runtime 已关闭', logs: [], toolCallCount: 0 }
    }
    // 串行排队：同一 worker 同时只承载一个沙箱
    while (this.active !== null) {
      await new Promise<void>(resolve => this.queue.push(resolve))
    }
    if (this.disposed) {
      return { status: 'failed', kind: 'execution_error', message: 'Code Runtime 已关闭', logs: [], toolCallCount: 0 }
    }
    try {
      return await this.runExclusive(input)
    } finally {
      const next = this.queue.shift()
      if (next) next()
    }
  }

  dispose(): void {
    this.disposed = true
    this.worker?.terminate()
    this.worker = null
  }

  private async runExclusive(input: CodeRuntimeExecutionInput): Promise<CodeRuntimeExecutionResult> {
    let worker: Worker
    try {
      worker = this.ensureWorker()
    } catch (err) {
      return {
        status: 'failed',
        kind: 'execution_error',
        message: `Code Runtime worker 启动失败：${err instanceof Error ? err.message : String(err)}`,
        logs: [],
        toolCallCount: 0
      }
    }

    const requestId = this.nextRequestId++
    Atomics.store(this.abortFlag!, 0, 0)

    return await new Promise<CodeRuntimeExecutionResult>(resolve => {
      const execution: ActiveExecution = {
        requestId,
        resolve,
        watchdog: null,
        cleanup: () => {}
      }
      this.active = execution

      const settle = (result: CodeRuntimeExecutionResult): void => {
        if (this.active !== execution) return
        this.active = null
        if (execution.watchdog) clearTimeout(execution.watchdog)
        execution.cleanup()
        resolve(result)
      }

      const onMessage = (message: CodeModeWorkerToHostMessage): void => {
        if (message.requestId !== requestId) return
        if (message.kind === 'result') {
          settle(message.result)
          return
        }
        if (message.kind === 'workerError') {
          settle({ status: 'failed', kind: 'execution_error', message: message.message, logs: [], toolCallCount: 0 })
          return
        }
        if (message.kind === 'toolCall') {
          void input
            .dispatchToolCall({
              callId: message.callId,
              toolName: message.toolName,
              argsJson: message.argsJson
            })
            .then(resolution => {
              if (this.active === execution) {
                worker.postMessage({
                  kind: 'resolveToolCall',
                  requestId,
                  callId: message.callId,
                  resolution
                } satisfies CodeModeHostToWorkerMessage)
              }
            })
        }
      }

      const onError = (err: Error): void => {
        settle({
          status: 'failed',
          kind: 'execution_error',
          message: `Code Runtime worker 异常：${err.message}`,
          logs: [],
          toolCallCount: 0
        })
        // worker 已损坏：丢弃以便下次重建
        void worker.terminate()
        if (this.worker === worker) this.worker = null
      }

      const onExit = (code: number): void => {
        settle({
          status: 'failed',
          kind: 'execution_error',
          message: `Code Runtime worker 意外退出（code=${code}）`,
          logs: [],
          toolCallCount: 0
        })
        if (this.worker === worker) this.worker = null
      }

      worker.on('message', onMessage)
      worker.once('error', onError)
      worker.once('exit', onExit)

      // watchdog：沙箱时限 + 宽限期仍无结果即强杀（正常超时由 worker 内部自报）
      execution.watchdog = setTimeout(() => {
        void worker.terminate()
        if (this.worker === worker) this.worker = null
        settle({
          status: 'failed',
          kind: 'limit_exceeded',
          message: `沙箱执行超时（含 ${RESULT_GRACE_MS}ms 宽限期后被强制终止）`,
          logs: [],
          toolCallCount: 0
        })
      }, input.limits.maxSandboxTimeMs + RESULT_GRACE_MS)

      // 中止传播：原子标志可打断阻塞循环；abort 消息切断 worker 侧等待
      let onAbort: (() => void) | null = null
      if (input.signal) {
        if (input.signal.aborted) {
          this.abortNow(worker, requestId)
        } else {
          onAbort = () => {
            if (this.active === execution) this.abortNow(worker, requestId)
          }
          input.signal.addEventListener('abort', onAbort, { once: true })
        }
      }

      const prevCleanup = execution.cleanup
      execution.cleanup = () => {
        prevCleanup()
        worker.off('message', onMessage)
        worker.off('error', onError)
        worker.off('exit', onExit)
        if (onAbort && input.signal) input.signal.removeEventListener('abort', onAbort)
      }

      worker.postMessage({
        kind: 'execute',
        requestId,
        source: input.source,
        toolNames: [...input.toolNames],
        limits: input.limits
      } satisfies CodeModeHostToWorkerMessage)
    })
  }

  private abortNow(worker: Worker, requestId: number): void {
    Atomics.store(this.abortFlag!, 0, 1)
    worker.postMessage({ kind: 'abort', requestId } satisfies CodeModeHostToWorkerMessage)
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker
    this.abortFlag = new Int32Array(new SharedArrayBuffer(4))
    this.worker = new Worker(this.options.workerPath, {
      workerData: { abortFlag: this.abortFlag }
    })
    return this.worker
  }
}

/**
 * 进程内 Code Runtime：直接在当前线程执行沙箱宿主。
 * 用于测试装配与无法提供 worker 产物的环境；
 * 阻塞循环的中止只能依赖时限（无跨线程标志）。
 */
export class InProcessCodeRuntime implements CodeRuntime {
  async execute(input: CodeRuntimeExecutionInput): Promise<CodeRuntimeExecutionResult> {
    const { executeInQuickJsSandbox } = await import('./QuickJsSandboxHost')
    const { loadQuickJsModule } = await import('./quickJsModule')
    return executeInQuickJsSandbox(await loadQuickJsModule(), input)
  }
}

let sharedWorkerRuntime: QuickJsCodeRuntime | null = null

/**
 * 进程级共享 worker runtime：worker 与 WASM 模块只初始化一次，执行串行复用。
 * 随进程生命周期存活；worker 意外退出时下一次执行自动重建。
 */
export function getSharedQuickJsCodeRuntime(workerPath: string): QuickJsCodeRuntime {
  sharedWorkerRuntime ??= new QuickJsCodeRuntime({ workerPath })
  return sharedWorkerRuntime
}
