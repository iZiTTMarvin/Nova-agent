import { parentPort, workerData } from 'node:worker_threads'
import {
  CodeIndexWorkerBuildError,
  runFullCodeIndexBuild
} from './CodeIndexBuildRunner'
import {
  parseCodeIndexHostMessage,
  type CodeIndexWorkerToHostMessage
} from './protocol'
import type { CodeIndexFailure } from '../types'

const port = parentPort
if (!port) throw new Error('codeGraphWorker 必须以 worker_threads 方式启动')
const workerPort = port
const sharedAbortFlag = readAbortFlag(workerData)

// Node 无独立 worker_threads 优先级接口；不用进程级 setPriority 牵连 Electron，由统一并发预算限资源。

let active: {
  readonly requestId: number
  readonly operationId: string
  readonly abortController: AbortController
} | null = null

workerPort.on('message', (value: unknown) => {
  const message = parseCodeIndexHostMessage(value)
  if (!message) {
    // 无法关联 requestId 的消息不得伪造业务失败，必须交给线程终态处理。
    throw new Error('Index Worker 收到无效协议消息')
  }
  if (message.kind === 'cancel') {
    if (
      active?.requestId === message.requestId &&
      active.operationId === message.operationId
    ) active.abortController.abort()
    return
  }
  if (active !== null) {
    postFailure(message.requestId, message.request.operation.operationId, {
      code: 'worker_crash',
      message: 'Index Worker 不允许并发写操作'
    }, null)
    return
  }
  void run(message.requestId, message.request)
})

async function run(
  requestId: number,
  request: Parameters<typeof runFullCodeIndexBuild>[0]
): Promise<void> {
  const abortController = new AbortController()
  active = {
    requestId,
    operationId: request.operation.operationId,
    abortController
  }
  try {
    const result = await runFullCodeIndexBuild(request, {
      abortSignal: abortController.signal,
      isAborted: () => Atomics.load(sharedAbortFlag, 0) === 1,
      onProgress: (progress) => workerPort.postMessage({
        kind: 'progress',
        requestId,
        operationId: request.operation.operationId,
        progress
      } satisfies CodeIndexWorkerToHostMessage)
    })
    workerPort.postMessage({
      kind: 'result',
      requestId,
      result
    } satisfies CodeIndexWorkerToHostMessage)
  } catch (error) {
    const failure = failureFromError(error)
    postFailure(
      requestId,
      request.operation.operationId,
      failure,
      error instanceof CodeIndexWorkerBuildError ? error.committedMetadata : null
    )
  } finally {
    if (active?.requestId === requestId) active = null
  }
}

function postFailure(
  requestId: number,
  operationId: string,
  failure: CodeIndexFailure,
  committedMetadata: CodeIndexWorkerBuildError['committedMetadata']
): void {
  workerPort.postMessage({
    kind: 'failure',
    requestId,
    operationId,
    failure,
    committedMetadata
  } satisfies CodeIndexWorkerToHostMessage)
}

function failureFromError(error: unknown): CodeIndexFailure {
  return Object.freeze({
    code: error instanceof CodeIndexWorkerBuildError ? error.code : 'worker_crash',
    message: error instanceof Error ? error.message : String(error)
  })
}

function readAbortFlag(value: unknown): Int32Array {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('codeGraphWorker 缺少 workerData')
  }
  const flag = Reflect.get(value, 'abortFlag')
  if (!(flag instanceof Int32Array) || !(flag.buffer instanceof SharedArrayBuffer)) {
    throw new Error('codeGraphWorker 缺少 SharedArrayBuffer abortFlag')
  }
  return flag
}
