/**
 * Skill 系统核心类型定义
 * 对齐 docs/skill-system-design.md §5.1（MVP 不含 brand / encrypted）
 */
import type { HookEvent } from '../../shared/agent/types'
import type { SkillSource } from '../../shared/skills/types'

export type { SkillSource }

/** 扫描/解析错误 */
export interface LoadError {
  path: string
  message: string
  skillName?: string
}

/** slash 命令解析结果 */
export interface SlashParseResult {
  matched: boolean
  found: boolean
  reason?: 'not_found' | 'not_user_invocable' | 'agent_not_allowed'
  skillName?: string
  args?: string
  skill?: SkillManifest
  suggestions: string[]
}

/** 模板展开上下文 */
export interface TemplateContext {
  workspacePath?: string
  selectedFiles?: string[]
  gitBranch?: string
  memoriesMeta?: string
  sessionId?: string
  /** slash / tool 传入的参数文本 */
  arguments?: string
  [key: string]: string | string[] | undefined
}

/** 完整技能清单 */
export interface SkillManifest {
  name: string
  nameZh?: string
  description: string
  descriptionZh?: string
  userInvocable: boolean
  modelInvocable: boolean
  agent?: string | string[]
  allowedTools?: string[]
  forbiddenTools?: string[]
  argumentHint?: string
  hooks?: HookEvent[]
  forkAgent?: boolean
  subagentModel?: string
  autoSummarize?: boolean
  body: string
  source: SkillSource
  sourcePath: string
  directory: string
  invalid?: boolean
  invalidReason?: string
  warnings: string[]
  hasSupportingFiles: boolean
  /** 运行时 model 调用开关（默认跟随 modelInvocable） */
  enabled: boolean
  /**
   * 隐藏技能：仅 compose 模式对模型可见（编排 skill）。
   * 非 compose 的 listForContext 会过滤掉。
   */
  hidden?: boolean
  /**
   * 编排脚本名：slash 触发时走 workflow 而非 inject/fork。
   * 例：workflow: br-full-dev
   */
  workflow?: string
  /** 编排 skill 的 whenToUse（写入 compose_skills 块） */
  whenToUse?: string
}

/** invokeSkill 调度结果 */
export type SkillDispatchResult =
  | { kind: 'passthrough' }
  | { kind: 'system_notice'; text: string }
  | { kind: 'fork'; skill: SkillManifest; args: string }
  | {
      kind: 'inject'
      assistantContent: string
      userContent: string
      /** 本 skill 所在目录；调用方据此注册为额外只读根，供模型按需 read reference */
      skillDirectory?: string
    }
  | { kind: 'workflow'; scriptName: string; args: string }
