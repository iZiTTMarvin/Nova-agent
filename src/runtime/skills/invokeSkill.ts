/**
 * invokeSkill — 统一 skill 调度（slash / tool 共用）
 */
import { expandTemplate } from './template'
import { parseSlashCommand } from './parseSlashCommand'
import type { SkillRegistry } from './SkillRegistry'
import type { SkillDispatchResult, SkillManifest, TemplateContext } from './types'

export interface InvokeSkillOptions {
  input: string
  registry: SkillRegistry
  profile?: string
  templateContext?: TemplateContext
}

const DEFAULT_USER_PROMPT = '请按上述技能指令执行。'

function buildNoticeText(reason: string, skillName: string, suggestions: string[]): string {
  const lines = [`[系统提示] 无法调用技能 /${skillName}：${reason}`]
  if (suggestions.length > 0) {
    lines.push(`你是否想要：${suggestions.map(s => `/${s}`).join('、')}？`)
  }
  return lines.join('\n')
}

export function expandSkillBody(skill: SkillManifest, args: string | undefined, ctx: TemplateContext): string {
  const { content, warnings } = expandTemplate(skill.body, {
    ...ctx,
    arguments: args ?? ctx.arguments ?? ''
  })
  const warnBlock = warnings.length > 0
    ? `\n\n<!-- 模板警告：\n${warnings.join('\n')}\n-->`
    : ''
  return content + warnBlock
}

/**
 * 调度用户 slash 输入
 */
export function invokeSkill(opts: InvokeSkillOptions): SkillDispatchResult {
  const { input, registry, profile, templateContext = {} } = opts
  const parsed = parseSlashCommand(input, registry, profile)

  if (!parsed.matched) {
    return { kind: 'passthrough' }
  }

  if (!parsed.found) {
    const reasonMap = {
      not_found: '未找到该技能',
      not_user_invocable: '该技能不允许用户直接调用',
      agent_not_allowed: '当前代理配置不允许使用该技能'
    } as const
    const reason = parsed.reason ? reasonMap[parsed.reason] : '未知原因'
    return {
      kind: 'system_notice',
      text: buildNoticeText(reason, parsed.skillName ?? '', parsed.suggestions)
    }
  }

  const skill = parsed.skill!
  const args = parsed.args?.trim() ?? ''

  // 编排入口：frontmatter 声明 workflow: <scriptName>
  if (skill.workflow) {
    return { kind: 'workflow', scriptName: skill.workflow, args }
  }

  if (skill.forkAgent) {
    return { kind: 'fork', skill, args }
  }

  // 注入 skillDirectory，供 SKILL.md 模板写 <%= skillDirectory %>/references/...
  const assistantContent = expandSkillBody(skill, args, {
    ...templateContext,
    skillDirectory: skill.directory
  })
  const userContent = args
    ? `${DEFAULT_USER_PROMPT}\n\n参数：${args}`
    : DEFAULT_USER_PROMPT

  return {
    kind: 'inject',
    assistantContent,
    userContent,
    skillDirectory: skill.directory
  }
}

/**
 * invoke_skill 工具路径：展开 skill body 返回给主对话（不独立开 chat）
 */
export function invokeSkillForTool(
  skillName: string,
  task: string,
  registry: SkillRegistry,
  templateContext: TemplateContext = {}
): {
  success: boolean
  output: string
  error?: string
  fork?: SkillManifest
  /** 成功展开（含 fork）时带回 skill 引用，宿主据此注册 skill.directory 为可读根 */
  skill?: SkillManifest
} {
  const skill = registry.get(skillName)
  if (!skill) {
    return { success: false, output: '', error: `技能 "${skillName}" 未找到` }
  }
  if (!skill.modelInvocable || !skill.enabled) {
    return { success: false, output: '', error: `技能 "${skillName}" 未启用或禁止模型调用` }
  }

  if (skill.forkAgent) {
    return { success: true, output: '', fork: skill, skill }
  }

  // 注入 skillDirectory，供模板写 <%= skillDirectory %>/references/...
  const body = expandSkillBody(skill, task, {
    ...templateContext,
    arguments: task,
    skillDirectory: skill.directory
  })
  const output = `${body}\n\n---\n\n任务：${task}`
  return { success: true, output, skill }
}
