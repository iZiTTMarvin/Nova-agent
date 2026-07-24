/**
 * 验证命令执行结果类型（供 XForge Test Gate 等受控执行路径使用）
 */
export type VerificationCommandType = 'test' | 'lint' | 'build'

/** 验证执行结果 */
export interface VerificationResult {
  command: string
  type: VerificationCommandType
  success: boolean
  output: string
  exitCode: number | null
  durationMs: number
  timedOut?: boolean
  cancelled?: boolean
}

/** 验证进程的受控执行选项 */
export interface VerificationExecutionOptions {
  abortSignal?: AbortSignal
  /** 未提供时使用 runner 的默认超时 */
  timeoutMs?: number
}
