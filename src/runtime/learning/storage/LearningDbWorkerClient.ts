import { Worker } from 'node:worker_threads'
import { join } from 'node:path'
import type { LearningDbHostMessage, LearningDbWorkerMessage } from './protocol'
import type { LearningDbWorkerOp } from './workerCommand'
import { parseLearningDbWorkerResult } from './workerCommand'

type Pending = {
  resolve: (result: unknown) => void
  reject: (e: Error) => void
}

export class LearningDbWorkerClient {
  private worker: Worker | null = null
  private nextRequestId = 1
  private readonly pending = new Map<number, Pending>()
  private crashed = false

  constructor(private readonly workerPath: string) {}

  static defaultWorkerPath(): string {
    return join(__dirname, 'learningDbWorker.js')
  }

  async start(): Promise<void> {
    if (this.worker) return
    this.crashed = false
    this.worker = new Worker(this.workerPath)
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('学习 Worker 启动超时')), 10_000)
      this.worker!.once('message', (msg: LearningDbWorkerMessage) => {
        clearTimeout(timeout)
        if (msg.kind === 'ready') resolve()
        else reject(new Error('学习 Worker 握手失败'))
      })
      this.worker!.once('error', err => {
        clearTimeout(timeout)
        reject(err)
      })
    })
    this.worker.on('message', (msg: LearningDbWorkerMessage) => {
      if (msg.kind === 'ready') return
      const pending = this.pending.get(msg.requestId)
      if (!pending) return
      this.pending.delete(msg.requestId)
      if (msg.kind === 'ok') pending.resolve(msg.result)
      else pending.reject(new Error(msg.message))
    })
    this.worker.on('error', err => {
      this.crashed = true
      for (const [, p] of this.pending) {
        p.reject(new Error(`学习 Worker 不可用: ${err.message}`))
      }
      this.pending.clear()
    })
    this.worker.on('exit', code => {
      if (code !== 0) {
        this.crashed = true
        for (const [, p] of this.pending) {
          p.reject(new Error('学习 Worker 已退出'))
        }
        this.pending.clear()
      }
    })
  }

  isCrashed(): boolean {
    return this.crashed
  }

  async open(dbPath: string): Promise<void> {
    await this.postMessage({ kind: 'open', requestId: 0, dbPath })
  }

  async invoke<T = unknown>(command: LearningDbWorkerOp): Promise<T> {
    const result = await this.postMessage({
      kind: 'invoke',
      requestId: 0,
      command
    })
    return result as T
  }

  async close(): Promise<void> {
    if (!this.worker) return
    await this.postMessage({ kind: 'close', requestId: 0 })
    await this.worker.terminate()
    this.worker = null
  }

  /** 测试用：强制终止 Worker，模拟崩溃。 */
  terminateWithoutClose(): void {
    if (!this.worker) return
    for (const [, p] of this.pending) {
      p.reject(new Error('学习 Worker 不可用'))
    }
    this.pending.clear()
    void this.worker.terminate()
    this.worker = null
    this.crashed = true
  }

  private postMessage(message: LearningDbHostMessage): Promise<unknown> {
    if (!this.worker || this.crashed) {
      return Promise.reject(new Error('学习 Worker 不可用'))
    }
    const requestId = this.nextRequestId++
    const outbound = { ...message, requestId }
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject })
      this.worker!.postMessage(outbound)
    })
  }
}

export function unwrapWorkerInvoke<T>(result: unknown): T {
  const parsed = parseLearningDbWorkerResult(result)
  if (!parsed.ok) throw new Error(parsed.message)
  return parsed.result as T
}
