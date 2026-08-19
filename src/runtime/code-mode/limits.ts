/**
 * Code Mode 资源上限。数值可测试、可配置，普通用户无需感知。
 */

export interface CodeRuntimeLimits {
  /** 程序源码最大字节数 */
  readonly maxSourceBytes: number
  /** 沙箱整体执行时限（含工具调用等待） */
  readonly maxSandboxTimeMs: number
  /** 单次 run_code 允许发起的工具调用总数 */
  readonly maxToolCalls: number
  /** 同时在途的工具调用上限 */
  readonly maxToolConcurrency: number
  /** 单次工具调用入参上限（args JSON 字节） */
  readonly maxToolInputBytes: number
  /** 单次工具调用结果上限（result JSON 字节） */
  readonly maxToolOutputBytes: number
  /** 回传模型的 curated output 上限（console + return 合计） */
  readonly maxModelOutputBytes: number
  /** 沙箱堆内存上限 */
  readonly maxSandboxMemoryBytes: number
}

export const DEFAULT_CODE_MODE_LIMITS: CodeRuntimeLimits = {
  maxSourceBytes: 64 * 1024,
  maxSandboxTimeMs: 30_000,
  maxToolCalls: 32,
  maxToolConcurrency: 4,
  maxToolInputBytes: 512 * 1024,
  maxToolOutputBytes: 512 * 1024,
  maxModelOutputBytes: 64 * 1024,
  maxSandboxMemoryBytes: 128 * 1024 * 1024
}
