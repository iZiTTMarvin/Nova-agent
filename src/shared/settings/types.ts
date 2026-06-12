/**
 * 设置相关 IPC 共享类型
 */
import type { RuleFileEntry, RuleScope } from '../../runtime/agent/rulesDiscovery'
import type { SubAgentSpec } from '../../runtime/agent/SubAgentConfig'

export interface NovaSettingsDto {
  loadThirdPartySkills: boolean
}

export interface RulesListParams {
  workspaceRoot?: string | null
}

export interface RulesReadParams {
  absolutePath: string
  workspaceRoot?: string | null
}

export interface RulesWriteParams {
  absolutePath: string
  content: string
  workspaceRoot?: string | null
}

export interface RulesCreateParams {
  name: string
  scope: RuleScope
  workspaceRoot?: string | null
  /** 初始正文 */
  content?: string
}

export type { RuleFileEntry, SubAgentSpec }

export interface SubagentsListParams {
  workspaceRoot?: string | null
}

export interface SubagentListItem extends SubAgentSpec {
  /** 是否内置（不可删） */
  builtin: boolean
  /** 来源：global | project | builtin */
  origin: 'builtin' | 'global' | 'project'
  /** 磁盘路径（内置为空） */
  filePath?: string
}

export interface SubagentsSaveParams {
  spec: SubAgentSpec
  location: 'global' | 'project'
  workspaceRoot?: string | null
}

export interface SubagentsDeleteParams {
  name: string
  workspaceRoot?: string | null
}
