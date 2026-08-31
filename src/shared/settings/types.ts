/**
 * 设置相关 IPC 共享类型
 */
import type { Mode, PermissionMode } from '../session/types'
import type { SubagentProfileModel } from '../subagents/types'

export type { PermissionMode }

export type RuleScope = 'workspace' | 'global'

/** 规则文件条目（IPC 安全） */
export interface RuleFileEntry {
  id: string
  relativePath: string
  absolutePath: string
  scope: RuleScope
  editable: boolean
}

/** 子代理持久化预设（当前版本 schema）。 */
export interface SubAgentSpec {
  /** 稳定身份：创建时生成，之后不可修改；global/project 同 ID 表示显式覆盖。 */
  id: string
  /** 显示名：可修改，重命名不影响覆盖、历史 Child Session 或显式派遣。 */
  name: string
  description: string
  /** 禁用只影响新的派遣；历史 child 仍按冻结配置恢复或重放。 */
  enabled: boolean
  allowedTools: string[]
  prompt: string
  /** 缺省绑定 = 跟随默认模型（派遣时确定）；旧 modelId 形状仅可只读加载。 */
  model?: SubagentProfileModel
  maxToolRounds?: number
  contextWindow?: number
}

export type SubagentPresetLocation = 'global' | 'project'

/**
 * 加载/写入预设时的类型化诊断；损坏配置不得伪装成「没有配置」。
 * 只由 preset 领域 Owner 产生，Renderer 与工具仅投影。
 */
export type SubagentPresetDiagnosticCode =
  | 'document_unreadable'
  | 'unknown_version'
  | 'duplicate_id'
  | 'invalid_preset'

export interface SubagentPresetDiagnostic {
  code: SubagentPresetDiagnosticCode
  location: SubagentPresetLocation
  message: string
  /** 条目级诊断的归属 ID（可解析时提供）。 */
  presetId?: string
  /** 条目级诊断的字段名（可解析时提供）。 */
  field?: string
}

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
  /** 新建会话使用的默认权限模式。 */
  defaultPermissionMode: PermissionMode
  /** bash 工具默认 shell 路径（空表示用系统默认） */
  defaultShell: string
  /**
   * 持久 shell 会话部署开关：bash 命令到前台等待边界仍存活时登记为可续操作会话；
   * 关闭后退回旧的边界强制终止语义。删除条件见方案文档回滚节。
   */
  persistentShellSessions: boolean
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
  /** Tavily API Key（本地明文存储，不上传） */
  webSearchTavilyApiKey?: string

  // ── 本地代码智能 ──
  /** 是否为新建会话启用本地代码索引 */
  codeIndexEnabled: boolean

  // ── 跨会话记忆 ──
  /** 是否启用跨会话记忆（L1/L2 注入与 FTS 检索） */
  memoryEnabled: boolean
  /** L2 FTS 检索返回条数上限（正整数） */
  memorySearchLimit: number
  /** L2 相关性分数下限（0~1，BM25 归一化后） */
  memoryScoreFloor: number
  /** search 热路径是否触发 reconcile（默认 false，热路径只查索引） */
  memoryReconcileOnSearch: boolean

  // ── 跨会话记忆采集子开关（由 memoryEnabled 一键统控，UI 不单独暴露）──
  /** 是否自动采集工具/消息观察写入 working 记忆 */
  memoryCaptureEnabled: boolean
  /** 是否将会话结束摘要写入 episodic 记忆 */
  memoryEpisodicSummaryEnabled: boolean
  /** 记忆 LLM 提炼开关（测试版，默认关） */
  memoryExtractEnabled: boolean
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

export interface SubagentsListParams {
  workspaceRoot?: string | null
}

export interface SubagentListItem extends SubAgentSpec {
  /** 是否内置（不可删） */
  builtin: boolean
  /** 来源：global | project | builtin */
  origin: 'builtin' | SubagentPresetLocation
  /** 磁盘路径（内置为空） */
  filePath?: string
}

export interface SubagentsListResult {
  items: SubagentListItem[]
  /** 读取自定义预设时产生的诊断投影；无损坏时为空数组。 */
  diagnostics: SubagentPresetDiagnostic[]
}

export interface SubagentPresetCreateParams {
  preset: SubAgentSpec
  location: SubagentPresetLocation
  workspaceRoot?: string | null
}

export interface SubagentPresetUpdateParams {
  /** 更新目标 ID；与 preset.id 不一致时拒绝（ID 创建后不可改）。 */
  id: string
  preset: SubAgentSpec
  location: SubagentPresetLocation
  workspaceRoot?: string | null
}

export interface SubagentPresetSetEnabledParams {
  id: string
  enabled: boolean
  location: SubagentPresetLocation
  workspaceRoot?: string | null
}

export interface SubagentsDeleteParams {
  id: string
  location: SubagentPresetLocation
  workspaceRoot?: string | null
}
