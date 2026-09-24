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
    'Invoke with invoke_skill; each skill runs its workflow in a clean context.',
    '',
    ...lines,
    '</skills>'
  ].join('\n')
}

/** 按当前 mode/profile 拼装普通技能上下文。 */
export function buildSkillContextForMode(
  mode: Mode,
  listForContext: (profile?: string) => SkillManifest[]
): string {
  return buildSkillContext(listForContext(mode))
}
