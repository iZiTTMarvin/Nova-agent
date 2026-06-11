/**
 * Slash 命令解析 — 对齐 openclacky parse_skill_command
 */
import type { SkillRegistry } from './SkillRegistry'
import type { SlashParseResult } from './types'
import { SkillLoader } from './SkillLoader'

const SLASH_RE = /^\/(\S+?)(?:\s+(.*))?$/

/**
 * 判断首 token 是否像路径（含额外 `/`），此类输入不算 slash 命令
 */
function looksLikePath(firstToken: string): boolean {
  const withoutLeading = firstToken.slice(1)
  return withoutLeading.includes('/')
}

/**
 * 相似技能推荐：子串匹配 > 字符重叠，最多 3 条
 */
export function suggestSimilarSkills(
  query: string,
  candidates: string[],
  limit = 3
): string[] {
  const q = query.toLowerCase()
  const scored = candidates
    .filter(c => c !== query)
    .map(name => {
      const lower = name.toLowerCase()
      let score = 0
      if (lower.includes(q) || q.includes(lower)) score += 100
      // 字符重叠
      const chars = new Set(q.split(''))
      for (const ch of lower) {
        if (chars.has(ch)) score += 1
      }
      return { name, score }
    })
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)

  return scored.slice(0, limit).map(x => x.name)
}

/**
 * 解析用户输入中的 slash 命令
 */
export function parseSlashCommand(
  input: string,
  registry: SkillRegistry,
  profile?: string
): SlashParseResult {
  const trimmed = input.trim()
  if (!trimmed.startsWith('/')) {
    return { matched: false, found: false, suggestions: [] }
  }

  const match = trimmed.match(SLASH_RE)
  if (!match) {
    return { matched: false, found: false, suggestions: [] }
  }

  const [, skillName, args] = match
  if (!skillName || looksLikePath(`/${skillName}`)) {
    return { matched: false, found: false, suggestions: [] }
  }

  const skill = registry.get(skillName)
  if (!skill) {
    const allNames = registry.listUserInvocable().map(s => s.name)
    return {
      matched: true,
      found: false,
      reason: 'not_found',
      skillName,
      args,
      suggestions: suggestSimilarSkills(skillName, allNames)
    }
  }

  if (!skill.userInvocable) {
    return {
      matched: true,
      found: false,
      reason: 'not_user_invocable',
      skillName,
      args,
      skill,
      suggestions: []
    }
  }

  if (!SkillLoader.isAgentAllowed(skill, profile)) {
    return {
      matched: true,
      found: false,
      reason: 'agent_not_allowed',
      skillName,
      args,
      skill,
      suggestions: []
    }
  }

  return {
    matched: true,
    found: true,
    skillName,
    args,
    skill,
    suggestions: []
  }
}
