/**
 * 权限相关 IPC 共享类型（PRD §5.2）
 *
 * 注意：PermissionRule 的完整定义在 runtime/permissions/PermissionRule.ts（运行时）。
 * 这里只放 IPC 协议层的参数/返回值类型，避免 shared 层反向依赖 runtime。
 *
 * 防御性约束：项目级规则的 upsert 必须由用户通过 UI 发起，
 * 主进程校验 projectPath 是当前打开项目后才允许写盘（见 PermissionService）。
 */
import type { PermissionDecision } from '../session/types'

/** IPC 传输用的规则载荷（与 runtime PermissionRule 结构对齐，但不携带运行时方法） */
export interface PermissionRuleDto {
  id: string
  toolName: string
  behavior: PermissionDecision
  scope: 'global' | 'project'
  projectPath?: string
  commandPrefix?: string
  commandRegex?: string
  filePath?: string
  description?: string
  createdAt: number
}

/** 列出规则参数 */
export interface PermissionListParams {
  /** 当前项目路径，用于返回项目级 + 全局规则合集；为空只返回全局 */
  projectPath?: string | null
}

/** 新增/更新规则参数 */
export interface PermissionUpsertParams {
  toolName: string
  behavior: PermissionDecision
  scope: 'global' | 'project'
  /** 项目级规则必填；主进程校验必须是当前打开项目 */
  projectPath?: string
  commandPrefix?: string
  commandRegex?: string
  filePath?: string
  description?: string
}

/** 删除规则参数 */
export interface PermissionDeleteParams {
  ruleId: string
  projectPath?: string | null
}
