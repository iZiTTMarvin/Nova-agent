/**
 * CodeRuntime 宿主 ↔ Worker 消息协议（纯类型，不依赖 worker_threads）。
 * 一次 execute 对应一个 requestId；工具调用按 callId 请求-回结配对。
 */
import type { CodeRuntimeLimits } from '../limits'
import type { CodeRuntimeExecutionResult, CodeRuntimeToolCallResolution } from '../types'

export interface CodeModeExecutePayload {
  readonly kind: 'execute'
  readonly requestId: number
  readonly source: string
  readonly toolNames: readonly string[]
  readonly limits: CodeRuntimeLimits
}

export interface CodeModeResolveToolCallPayload {
  readonly kind: 'resolveToolCall'
  readonly requestId: number
  readonly callId: number
  readonly resolution: CodeRuntimeToolCallResolution
}

export interface CodeModeAbortPayload {
  readonly kind: 'abort'
  readonly requestId: number
}

export type CodeModeHostToWorkerMessage =
  | CodeModeExecutePayload
  | CodeModeResolveToolCallPayload
  | CodeModeAbortPayload

export interface CodeModeToolCallPayload {
  readonly kind: 'toolCall'
  readonly requestId: number
  readonly callId: number
  readonly toolName: string
  readonly argsJson: string
}

export interface CodeModeResultPayload {
  readonly kind: 'result'
  readonly requestId: number
  readonly result: CodeRuntimeExecutionResult
}

export interface CodeModeWorkerErrorPayload {
  readonly kind: 'workerError'
  readonly requestId: number
  readonly message: string
}

export type CodeModeWorkerToHostMessage =
  | CodeModeToolCallPayload
  | CodeModeResultPayload
  | CodeModeWorkerErrorPayload
