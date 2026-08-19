/**
 * Code Mode Worker 入口：在本线程内承载 QuickJS 沙箱宿主。
 * 主线程经消息桥发起执行；沙箱内的工具调用经 toolCall 消息送回主线程，
 * 主线程完成统一流水线执行后以 resolveToolCall 回结。
 *
 * 中止通道有两条：SharedArrayBuffer 原子标志（可打断阻塞中的同步循环）
 * 与 abort 消息（切断宿主侧等待）。每次执行前主线程会把标志复位。
 */
import { parentPort, workerData } from 'node:worker_threads'
import { executeInQuickJsSandbox } from './QuickJsSandboxHost'
import { loadQuickJsModule } from './quickJsModule'
import type { CodeModeHostToWorkerMessage } from './protocol'
import type { CodeRuntimeLimits } from '../limits'
import type { CodeRuntimeExecutionResult, CodeRuntimeToolCallResolution } from '../types'

const port = parentPort
if (!port) {
  throw new Error('codeModeWorker 必须以 worker_threads 方式启动')
}
const workerPort: typeof parentPort = port

const abortFlagFromData = (workerData as { abortFlag?: Int32Array }).abortFlag
if (!abortFlagFromData) {
  throw new Error('codeModeWorker 缺少 abortFlag（SharedArrayBuffer）')
}
// 函数声明会提升，收窄不进入闭包；以新常量固化非空类型
const sharedAbortFlag: Int32Array = abortFlagFromData

const modulePromise = loadQuickJsModule()

/** callId → 工具调用回结 resolver（单次执行内串行，跨执行不会并发） */
let pendingToolCalls = new Map<number, (resolution: CodeRuntimeToolCallResolution) => void>()
let currentAbortController: AbortController | null = null

port.on('message', (message: CodeModeHostToWorkerMessage) => {
  if (message.kind === 'execute') {
    void handleExecute(message.requestId, message.source, message.toolNames, message.limits)
    return
  }
  if (message.kind === 'resolveToolCall') {
    pendingToolCalls.get(message.callId)?.(message.resolution)
    pendingToolCalls.delete(message.callId)
    return
  }
  if (message.kind === 'abort') {
    currentAbortController?.abort()
  }
})

async function handleExecute(
  requestId: number,
  source: string,
  toolNames: readonly string[],
  limits: CodeRuntimeLimits
): Promise<void> {
  pendingToolCalls = new Map()
  const abortController = new AbortController()
  currentAbortController = abortController
  let result: CodeRuntimeExecutionResult
  try {
    const module = await modulePromise
    result = await executeInQuickJsSandbox(module, {
      source,
      toolNames,
      limits,
      signal: abortController.signal,
      isAborted: () => Atomics.load(sharedAbortFlag, 0) === 1,
      dispatchToolCall: async request =>
        new Promise<CodeRuntimeToolCallResolution>(resolve => {
          pendingToolCalls.set(request.callId, resolve)
          workerPort!.postMessage({
            kind: 'toolCall',
            requestId,
            callId: request.callId,
            toolName: request.toolName,
            argsJson: request.argsJson
          })
        })
    })
  } catch (err) {
    result = {
      status: 'failed',
      kind: 'execution_error',
      message: err instanceof Error ? err.message : String(err),
      logs: [],
      toolCallCount: 0
    }
  } finally {
    currentAbortController = null
    pendingToolCalls = new Map()
  }
  workerPort!.postMessage({ kind: 'result', requestId, result })
}
