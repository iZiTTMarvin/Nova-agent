/**
 * 验证服务 — 自包含的验证闭环
 *
 * 职责清晰分层：
 * - strategy 选命令
 * - runner 执行命令
 * - service 组合模式策略 + 权限 + 结果格式化
 *
 * 调用方只需传入一个完整的 VerificationOptions，服务内部完成：
 * 1. 检查 mode 和 hasModifications
 * 2. 选择验证命令
 * 3. default 模式通过 permissionCallback 走权限确认
 * 4. 执行命令并返回结果
 *
 * 不依赖任何全局状态，不直接操作 EventBus / IPC / SessionStore
 */
import { isAutoPermissionSemantics } from '../permissions/rules'
import { selectVerificationCommand } from './strategy'
import { runVerificationCommand } from './runner'
import type { VerificationOptions, VerificationResult } from './types'

export { formatVerificationSummary } from './format'

/**
 * 执行验证流程
 *
 * @returns 验证结果，如果跳过验证则返回 null
 */
export async function runVerification(options: VerificationOptions): Promise<VerificationResult | null> {
  // plan 模式不验证
  if (options.mode === 'plan') return null

  // 本轮无真实文件修改时不验证
  if (!options.hasModifications) return null

  // 选择验证命令
  const candidate = selectVerificationCommand(options.workingDir)
  if (!candidate) return null

  // default + ask：弹确认；default + auto / compose：直接跑
  const policy = options.permissionPolicy ?? 'ask'
  if (!isAutoPermissionSemantics(options.mode, policy)) {
    if (!options.permissionCallback) return null
    const granted = await options.permissionCallback(candidate.command)
    if (!granted) return null
  }

  const result = await runVerificationCommand(
    candidate.command,
    candidate.type,
    options.workingDir,
    { abortSignal: options.abortSignal }
  )

  return result
}
