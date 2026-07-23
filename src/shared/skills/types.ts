/**
 * Skill IPC 与渲染端共享类型（不含 body 全量，列表接口使用 preview）
 */

/** 技能来源（MVP 三源 + 预留枚举） */
export type SkillSource =
  | 'builtin'
  | 'global'
  | 'project'
  | 'third_party_claude'
  | 'virtual'
  | 'mcp'

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
  enabled: boolean
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

/** preload window.nova.skill API 形状 */
export interface NovaSkillApi {
  list(): Promise<SkillSummary[]>
  get(name: string): Promise<SkillSummary | null>
  getBody(name: string): Promise<string | null>
  create(input: SkillCreateInput): Promise<SkillSummary>
  delete(name: string): Promise<void>
  toggle(name: string, enabled: boolean): Promise<SkillSummary>
  import(input: SkillImportInput): Promise<SkillSummary>
  export(name: string): Promise<{ zipPath: string }>
  reload(workspaceRoot?: string | null): Promise<SkillReloadResult>
  /** 打开文件选择器选取 zip（主进程 dialog） */
  pickImportFile(): Promise<string | null>
  onChange(cb: (skills: SkillSummary[]) => void): () => void
}
