/**
 * buildSkillContext — 将技能清单格式化为 system prompt 片段
 */
import type { SkillManifest } from '../../skills/types'
import type { Mode } from '../../../shared/session/types'

/**
 * 拼装 <skills> 段
 * @param skills 可注入上下文的技能列表
 */
export function buildSkillContext(skills: SkillManifest[]): string {
  if (skills.length === 0) return ''
  const lines = skills.map(s => `- ${s.name}: ${s.description}`)
  return [
    '<skills>',
    '你可以通过 invoke_skill 工具调用以下技能。每个技能会在干净上下文中执行其定义的工作。',
    '',
    ...lines,
    '</skills>'
  ].join('\n')
}

/**
 * compose 模式额外拼装 <compose_skills>：列出全部 hidden 编排 skill。
 */
export function buildComposeSkillContext(hiddenSkills: SkillManifest[]): string {
  if (hiddenSkills.length === 0) return ''
  const lines = hiddenSkills.map(s => {
    const when = s.whenToUse ? ` whenToUse=${JSON.stringify(s.whenToUse)}` : ''
    return `- ${s.name}: ${s.description}${when}`
  })
  return [
    '<compose_skills>',
    '以下编排技能仅在 compose 模式可用，由编排脚本通过 agent({ skill }) 调用：',
    '',
    ...lines,
    '</compose_skills>'
  ].join('\n')
}

/**
 * 按模式拼装技能上下文：compose 时包含 hidden + compose_skills 块。
 */
export function buildSkillContextForMode(
  mode: Mode,
  listForContext: (profile?: string, opts?: { includeHidden?: boolean }) => SkillManifest[],
  listHidden: () => SkillManifest[]
): string {
  const isCompose = mode === 'compose'
  const visible = listForContext(mode, { includeHidden: isCompose })
  // compose 下 listForContext 已含 hidden；普通 skills 块只列非 hidden，hidden 进 compose_skills
  const normal = isCompose ? visible.filter(s => !s.hidden) : visible
  const parts = [buildSkillContext(normal)]
  if (isCompose) {
    parts.push(buildComposeSkillContext(listHidden()))
  }
  return parts.filter(Boolean).join('\n\n')
}
