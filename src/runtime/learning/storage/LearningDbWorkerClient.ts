import { Worker } from 'node:worker_threads'
import { join } from 'node:path'
import type { LearningDbHostMessage, LearningDbWorkerMessage } from './protocol'

export class LearningDbWorkerClient {
  private worker: Worker | null = null
  private nextRequestId = 1
  private readonly pending = new Map<number, { resolve: () => void; reject: (e: Error) => void }>()

  constructor(private readonly workerPath: string) {}

  static defaultWorkerPath(): string {
    return join(__dirname, 'learningDbWorker.js')
  }

  async start(): Promise<void> {
    if (this.worker) return
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
      if (msg.kind === 'ok') pending.resolve()
      else pending.reject(new Error(msg.message))
    })
    this.worker.on('error', err => {
      for (const [, p] of this.pending) p.reject(err)
      this.pending.clear()
    })
  }

  async open(dbPath: string): Promise<void> {
    await this.postMessage({ kind: 'open', requestId: 0, dbPath })
  }

  async runTransaction(
    statements: readonly { sql: string; params?: readonly unknown[] }[]
  ): Promise<void> {
    await this.postMessage({ kind: 'transaction', requestId: 0, statements })
  }

  async close(): Promise<void> {
    if (!this.worker) return
    await this.postMessage({ kind: 'close', requestId: 0 })
    await this.worker.terminate()
    this.worker = null
  }

  private postMessage(message: LearningDbHostMessage): Promise<void> {
    if (!this.worker) return Promise.reject(new Error('学习 Worker 未启动'))
    const requestId = this.nextRequestId++
    const outbound = { ...message, requestId }
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject })
      this.worker!.postMessage(outbound)
    })
  }
}
