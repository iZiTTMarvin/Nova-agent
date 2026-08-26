/**
 * 权限系统类型定义
 * 定义权限请求、决策和风险等级，供 PermissionManager 和 AgentLoop 使用
 */
import type {
  PathAccessKind,
  PermissionCapabilityCeiling,
  SessionPathGrant
} from '../../shared/permissions/types'
import type { PermissionMode } from '../../shared/session/types'

/** 命令风险等级，影响权限决策和 UI 展示 */
export type RiskLevel = 'low' | 'high'

/** 权限查询的输入：工具名 + 参数 */
export interface PermissionQuery {
  toolName: string
  args: Record<string, unknown>
  sessionId: string
  workspaceRoot: string
  permissionMode: PermissionMode
  /** 能力上限（如只读子代理）；优先于 Permission Mode baseline。 */
  capabilityCeiling?: PermissionCapabilityCeiling | null
}

/** ask 决策附带的展示信息；requestId 由 PermissionCoordinator 独占生成。 */
export interface PermissionRequestMeta {
  command?: string
  riskReason?: string
  externalPaths?: string[]
  pathAccess?: PathAccessKind
}

/** 权限决策结果；只有 ask 会携带交互展示元数据。 */
export type PermissionResult =
  | { decision: 'allow'; reason: string; executionPathGrants?: SessionPathGrant[] }
  | {
      decision: 'ask'
      reason: string
      riskLevel: RiskLevel
      request: PermissionRequestMeta
    }
  | { decision: 'deny'; reason: string; riskLevel: RiskLevel }
