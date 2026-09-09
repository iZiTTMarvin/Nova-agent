/**
 * slash 本地拒绝的展示文案。原因码由主进程判定，这里只做文本映射。
 */
import type { SkillSlashRejection } from '../../shared/skills/types'

export function slashRejectionText(rejection: SkillSlashRejection): string {
  const name = `/${rejection.skillName}`
  const reason =
    rejection.reason === 'not_found'
      ? `未找到技能 ${name}`
      : rejection.reason === 'not_user_invocable'
        ? `技能 ${name} 不允许直接调用`
        : `当前代理配置不允许使用技能 ${name}`
  if (rejection.suggestions.length === 0) return reason
  return `${reason}。你是否想要：${rejection.suggestions.map(s => `/${s}`).join('、')}？`
}
