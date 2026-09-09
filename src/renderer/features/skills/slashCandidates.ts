/**
 * Slash 补全候选项 — 技能与命令同源排序。命令候选位已预留，
 * 待原生命令 Owner（如压缩、goal）落地后接入，当前仅有技能候选。
 */
import type { SkillSummary } from '../../../shared/skills/types'

export interface SlashCandidate {
  name: string
  description: string
  kind: 'skill' | 'command'
  source?: string
}

export function skillsToCandidates(skills: SkillSummary[]): SlashCandidate[] {
  return skills
    .filter(s => s.userInvocable && !s.invalid && !s.hidden)
    .map(s => ({
      name: s.name,
      description: s.descriptionZh || s.description,
      kind: 'skill' as const,
      source: s.source
    }))
}

/** 评分：前缀匹配 100，子串 80，字符重叠 60；同分时 skill 优先 */
export function scoreCandidate(query: string, candidate: SlashCandidate): number {
  const q = query.toLowerCase()
  const name = candidate.name.toLowerCase()
  let score = 0
  if (name.startsWith(q)) score = 100
  else if (name.includes(q)) score = 80
  else {
    // 字符级回退：前缀/子串均未命中时，要求 name 包含 query 的每个字符（避免单字符命中污染结果）
    const allCharsPresent = q.length >= 2 && [...q].every(ch => name.includes(ch))
    if (allCharsPresent) score = 60
  }
  if (candidate.kind === 'skill' && score > 0) score += 0.5
  return score
}

export function filterAndRankCandidates(
  query: string,
  candidates: SlashCandidate[]
): SlashCandidate[] {
  const token = query.replace(/^\//, '').toLowerCase()
  if (!token) {
    return [...candidates].sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'skill' ? -1 : 1
      return a.name.localeCompare(b.name)
    })
  }

  return candidates
    .map(c => ({ c, score: scoreCandidate(token, c) }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score || a.c.name.localeCompare(b.c.name))
    .map(x => x.c)
}
