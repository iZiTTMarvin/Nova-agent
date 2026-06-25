/**
 * 设置相关 IPC 共享类型
 */
import type { RuleFileEntry, RuleScope } from '../../runtime/agent/context/rulesDiscovery'
import type { SubAgentSpec } from '../../runtime/agent/core/SubAgentConfig'
import type { Mode } from '../session/types'

/**
 * 应用级用户偏好（持久化到 ~/.nova/settings.json）
 *
 * 与 LLM 配置（ModelConfig，独立文件）分离。
 * 加载时由 novaSettings 做默认值填充，保证旧版本设置缺少新字段时安全升级。
 */
export interface NovaSettingsDto {
  // ── 现有 ──
  loadThirdPartySkills: boolean

  // ── PRD §5.6 新增：通用偏好 ──
  /** 默认运行模式（新建会话时使用） */
  defaultMode: Mode
  /** bash 工具默认 shell 路径（空表示用系统默认） */
  defaultShell: string
  /** bash 命令默认超时（毫秒，0 表示不超时） */
  defaultShellTimeout: number
  /** 是否启用修改后自动验证 */
  verificationEnabled: boolean
  /** 主 Agent 单条消息内最大连续工具调用轮数，防止长任务静默截断；范围 1~1000 */
  maxToolRounds: number
  /** 编辑器字体大小（px） */
  editorFontSize: number
  /** 编辑器字体族 */
  editorFontFamily: string
  /** 主题 */
  theme: 'light' | 'dark' | 'system'
  /** DiffViewer 默认是否自动展开 */
  diffAutoExpand: boolean
  /** 上次打开的项目路径（启动时恢复，空表示无） */
  lastProjectPath: string | null
  /** 陈旧快照自动保留天数（超过此天数的 checkpoint files/ 会被启动时 GC 清理） */
  snapshotRetentionDays: number
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
