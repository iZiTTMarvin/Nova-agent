/**
 * Code Runtime 类型：受限程序执行契约。
 * Runtime 只负责"在隔离环境中执行受限 JS 并桥回工具调用"，
 * 与 Tool Catalog / Permission 解耦；真正工具调用由宿主重入统一执行流水线。
 */

import type { CodeRuntimeLimits } from './limits'

/** run_code 失败分类：模型可见的错误语义（§33），内部诊断另留明细 */
export type RunCodeFailureKind =
  | 'parse_error'
  | 'execution_error'
  | 'unknown_tool'
  | 'limit_exceeded'
  | 'tool_failure'
  | 'aborted'

/** 沙箱发起的一次工具调用请求（args 已 JSON 序列化） */
export interface CodeRuntimeToolCallRequest {
  readonly callId: number
  readonly toolName: string
  readonly argsJson: string
}

/** 工具调用结果：ok 时 resultJson 为传回沙箱的 JSON 文本，否则 errorMessage 进入沙箱异常 */
export interface CodeRuntimeToolCallResolution {
  readonly ok: boolean
  readonly resultJson?: string
  readonly errorMessage?: string
}

export interface CodeRuntimeExecutionInput {
  /** 模型生成的程序源码（顶层可使用 return / await） */
  readonly source: string
  /** 允许在 tools.* 上暴露的工具名（由 Catalog 嵌套策略 ∩ 当前激活集解析） */
  readonly toolNames: readonly string[]
  readonly limits: CodeRuntimeLimits
  readonly signal?: AbortSignal
  /**
   * 同步中止探针（比 signal 更强的中断源）：
   * signal 的 abort 事件依赖事件循环，无法打断阻塞中的同步执行；
   * Worker 部署时由主线程写 SharedArrayBuffer 标志、沙箱线程原子读取，
   * 使中断器在阻塞循环内也能感知中止。两种来源任一命中即中止。
   */
  readonly isAborted?: () => boolean
  /**
   * 工具桥：把沙箱内调用送回宿主统一执行流水线。
   * 实现方必须保证结果（或异常）最终回结，不得静默丢弃。
   */
  readonly dispatchToolCall: (request: CodeRuntimeToolCallRequest) => Promise<CodeRuntimeToolCallResolution>
}

export interface CodeRuntimeExecutionResult {
  readonly status: 'ok' | 'failed'
  /** status=ok：return 值的 JSON 文本；无 return 时为 null */
  readonly valueJson?: string | null
  /** status=failed：失败分类 */
  readonly kind?: RunCodeFailureKind
  /** 面向模型的失败信息（已足够自我修正） */
  readonly message?: string
  /** console 输出（无论成败都收集） */
  readonly logs: readonly string[]
  /** 实际发起的工具调用总数 */
  readonly toolCallCount: number
}

export interface CodeRuntime {
  execute(input: CodeRuntimeExecutionInput): Promise<CodeRuntimeExecutionResult>
}
