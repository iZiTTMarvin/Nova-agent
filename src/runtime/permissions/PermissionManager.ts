/**
 * PermissionManager — 权限决策引擎
 * 根据当前模式（plan/default/auto）和工具类型做出权限决策
 * bash 工具额外检查命令风险等级
 */
import type { Mode } from '../../shared/session/types'
import type { PermissionQuery, PermissionResult, RiskLevel } from './types'
import { getBaseDecision, assessCommandRisk, getRiskDescription } from './rules'

export class PermissionManager {
  /**
   * 查询指定工具+模式下的权限决策
   *
   * - plan 模式：只读工具 allow，写入和 bash 全部 deny
   * - default 模式：只读和写入 allow，bash 工具 ask（需用户确认）
   * - auto 模式：全部 allow，但 bash 危险命令强制 deny
   */
  check(query: PermissionQuery, mode: Mode): PermissionResult {
    const { toolName, args } = query

    // 获取基础决策（不考虑命令级别细节）
    const baseDecision = getBaseDecision(mode, toolName)

    // bash 工具需要额外检查命令风险
    if (toolName === 'bash') {
      return this.checkBash(args.command as string, mode, baseDecision)
    }

    return {
      decision: baseDecision,
      riskLevel: baseDecision === 'deny' ? 'high' : 'low',
      reason: this.buildReason(toolName, mode, baseDecision)
    }
  }

  /** bash 工具的详细权限检查 */
  private checkBash(
    command: string,
    mode: Mode,
    baseDecision: 'allow' | 'ask' | 'deny'
  ): PermissionResult {
    // plan 模式直接拒绝
    if (mode === 'plan') {
      return {
        decision: 'deny',
        riskLevel: 'high',
        reason: 'plan 模式下禁止执行任何 shell 命令'
      }
    }

    const { riskLevel, isDangerous, reason } = assessCommandRisk(command || '')

    // auto 模式下危险命令强制拒绝
    if (mode === 'auto' && isDangerous) {
      return {
        decision: 'deny',
        riskLevel: 'high',
        reason: `auto 模式下禁止执行危险命令: ${reason}`
      }
    }

    return {
      decision: baseDecision,
      riskLevel,
      reason: isDangerous
        ? reason
        : getRiskDescription('bash', riskLevel)
    }
  }

  /** 构建决策原因说明 */
  private buildReason(
    toolName: string,
    mode: Mode,
    decision: 'allow' | 'ask' | 'deny'
  ): string {
    if (decision === 'deny') {
      if (mode === 'plan') {
        return `plan 模式下禁止使用 "${toolName}" 工具，请切换到 default 或 auto 模式`
      }
      return `权限策略拒绝执行 "${toolName}"`
    }
    return getRiskDescription(toolName, 'low')
  }
}
