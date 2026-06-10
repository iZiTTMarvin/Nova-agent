/**
 * buildSkillContext — 将技能清单格式化为 system prompt 片段
 */
import type { SkillManifest } from '../skills/SkillManifest'

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
