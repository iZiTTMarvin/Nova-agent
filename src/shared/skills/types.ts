/**
 * Skill IPC 与渲染端共享类型（不含 body 全量，列表接口使用 preview）
 */

/** 技能来源（MVP 三源 + 预留枚举） */
export type SkillSource =
  | 'builtin'
  | 'global'
  | 'project'
  | 'third_party'
  | 'virtual'
  | 'mcp'

/** 可选择共享给 Nova 的第三方技能目录族：`.agents`（跨工具约定）与 `.claude`（Claude Code） */
export type ThirdPartySkillSourceId = 'agents' | 'claude'

/** 每个第三方来源是否已获用户同意加载；默认全部关闭 */
export type ThirdPartySkillSources = Record<ThirdPartySkillSourceId, boolean>

export interface ThirdPartySkillLocation {
  scope: 'user' | 'project'
  path: string
  exists: boolean
  /** 目录下可识别的技能数（含符号链接指向的技能） */
  count: number
}

/** 设置页展示用的第三方来源状态 */
export interface ThirdPartySkillSourceStatus {
  id: ThirdPartySkillSourceId
  label: string
  enabled: boolean
  locations: ThirdPartySkillLocation[]
}

/** 渲染端 / IPC 安全的技能摘要 */
export interface SkillSummary {
  name: string
  nameZh?: string
  description: string
  descriptionZh?: string
  source: SkillSource
  sourcePath: string
  userInvocable: boolean
  modelInvocable: boolean
  invalid?: boolean
  invalidReason?: string
  warnings: string[]
  bodyPreview: string
  argumentHint?: string
  hasSupportingFiles: boolean
  forkAgent?: boolean
  /** 编排内部技能，不出现在用户 `/` 补全中 */
  hidden?: boolean
}

export type SkillCreateLocation = 'global' | 'project'

export interface SkillCreateInput {
  name: string
  description: string
  body: string
  location: SkillCreateLocation
}

export interface SkillImportInput {
  url?: string
  zipPath?: string
  location: SkillCreateLocation
}

export interface SkillReloadResult {
  count: number
  errors: string[]
}

export interface SkillExportInput {
  name: string
  /** 程序化导出时直接指定落盘路径；缺省则弹保存对话框由用户选择 */
  destPath?: string
}

export interface SkillExportResult {
  canceled: boolean
  zipPath?: string
}

/** slash 本地拒绝原因（与运行时 SlashParseResult 共用字面量） */
export type SkillSlashRejectionReason = 'not_found' | 'not_user_invocable' | 'agent_not_allowed'

/**
 * slash 本地拒绝：发送边界在落盘与建 run 前直接返回，不调用模型。
 * suggestions 最多三条，仅 not_found 时有值。
 */
export interface SkillSlashRejection {
  reason: SkillSlashRejectionReason
  skillName: string
  suggestions: string[]
}

/** 目录诊断：解释某条技能为何不可见或不可用 */
export interface SkillCatalogDiagnostic {
  code: 'load_error' | 'shadowed' | 'profile_restricted'
  message: string
  skillName?: string
  path?: string
}

/**
 * 技能目录快照：主进程组装的权威只读投影。
 * `+` 入口与 `/` 补全消费同一份快照；loading/error 只描述目录本身，
 * 不复用各技能自身的 invalid 语义。
 */
export interface SkillCatalogSnapshot {
  skills: SkillSummary[]
  loading: boolean
  error: string | null
  refreshedAt: number | null
  diagnostics: SkillCatalogDiagnostic[]
  thirdPartySources: ThirdPartySkillSourceStatus[]
}

/** preload window.nova.skill API 形状 */
export interface NovaSkillApi {
  list(): Promise<SkillCatalogSnapshot>
  get(name: string): Promise<SkillSummary | null>
  getBody(name: string): Promise<string | null>
  create(input: SkillCreateInput): Promise<SkillSummary>
  delete(name: string): Promise<void>
  import(input: SkillImportInput): Promise<SkillSummary>
  export(name: string, destPath?: string): Promise<SkillExportResult>
  reload(workspaceRoot?: string | null): Promise<SkillReloadResult>
  /** 打开文件选择器选取 zip（主进程 dialog） */
  pickImportFile(): Promise<string | null>
  onChange(cb: (snapshot: SkillCatalogSnapshot) => void): () => void
}
