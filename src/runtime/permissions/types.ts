/**
 * 权限系统类型定义
 * 定义权限请求、决策和风险等级，供 PermissionManager 和 AgentLoop 使用
 */
import type { PermissionDecision } from '../../shared/session/types'

/** 命令风险等级，影响权限决策和 UI 展示 */
export type RiskLevel = 'low' | 'medium' | 'high'

/** 权限查询的输入：工具名 + 参数 */
export interface PermissionQuery {
  toolName: string
  args: Record<string, unknown>
}

/** 权限决策结果，包含决策和风险说明 */
export interface PermissionResult {
  decision: PermissionDecision
  /** 风险等级，用于 UI 展示和日志 */
  riskLevel: RiskLevel
  /** 决策原因说明，供 UI 展示给用户 */
  reason: string
}
