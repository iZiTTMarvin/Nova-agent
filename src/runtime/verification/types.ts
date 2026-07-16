/**
 * 验证服务类型定义
 *
 * 验证服务负责在 agent 修改代码后自动选择并执行验证命令，
 * 把结果通过回调推送给调用方。服务本身不依赖任何全局状态。
 */
import type { Mode, PermissionPolicy } from '../../shared/session/types'

/** 验证命令类型，按优先级排列 */
export type VerificationCommandType = 'test' | 'lint' | 'build'

/** 候选验证命令 */
export interface VerificationCandidate {
  type: VerificationCommandType
  command: string
  /** 命令来源（如 "package.json scripts"） */
  source: string
}

/** 验证执行结果 */
export interface VerificationResult {
  /** 执行的命令 */
  command: string
  /** 命令类型 */
  type: VerificationCommandType
  /** 是否成功（退出码 0） */
  success: boolean
  /** 命令输出摘要 */
  output: string
  /** 退出码 */
  exitCode: number | null
  /** 执行耗时（毫秒） */
  durationMs: number
  /** 子进程因执行超时被终止 */
  timedOut?: boolean
  /** 调用方取消信号导致终止 */
  cancelled?: boolean
}

/** 验证进程的受控执行选项。 */
export interface VerificationExecutionOptions {
  abortSignal?: AbortSignal
  /** 未提供时使用 runner 的默认超时。 */
  timeoutMs?: number
}

/**
 * 权限确认回调
 * default 模式下验证命令需要用户确认
 * 返回 true 表示允许执行，false 表示拒绝
 */
export type PermissionCallback = (command: string) => Promise<boolean>

/**
 * 验证服务的运行选项
 * 所有状态通过参数显式传入，不依赖任何全局变量
 */
export interface VerificationOptions {
  /** 工作区路径 */
  workingDir: string
  /** 当前模式 */
  mode: Mode
  /**
   * 工具批准策略（仅 default 模式生效）。
   * ask：验证前弹确认；auto / compose：直接跑。
   */
  permissionPolicy?: PermissionPolicy
  /** 取消信号 */
  abortSignal?: AbortSignal
  /**
   * 本轮是否有真实的文件修改
   * 应基于 checkpoint manifest 判定，而非工具名猜测
   */
  hasModifications: boolean
  /**
   * 权限确认回调（default + ask 时必需）
   * 由调用方注入，负责弹出确认弹窗并等待用户决策
   */
  permissionCallback?: PermissionCallback
}
