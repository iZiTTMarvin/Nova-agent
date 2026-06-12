/**
 * slashCandidates 评分与过滤单测
 */
import { describe, expect, it } from 'vitest'
import {
  filterAndRankCandidates,
  scoreCandidate,
  type SlashCandidate
} from '../../../src/renderer/features/skills/slashCandidates'

const candidates: SlashCandidate[] = [
  { name: 'onboard', description: '首启向导', kind: 'skill' },
  { name: 'code-review', description: '代码审查', kind: 'skill' },
  { name: 'commit', description: '提交', kind: 'command' }
]

describe('slashCandidates', () => {
  it('输入 / 时返回全部候选项，skill 排在 command 前（同默认排序）', () => {
    const result = filterAndRankCandidates('', candidates)
    expect(result.length).toBe(3)
    expect(result[0].kind).toBe('skill')
  })

  it('前缀匹配得分高于子串匹配', () => {
    expect(scoreCandidate('on', { name: 'onboard', description: '', kind: 'skill' })).toBeGreaterThan(
      scoreCandidate('bo', { name: 'onboard', description: '', kind: 'skill' })
    )
  })

  it('过滤 on 前缀时 onboard 优先于 code-review', () => {
    const result = filterAndRankCandidates('on', candidates)
    expect(result[0].name).toBe('onboard')
  })

  it('字符回退要求 query 全字符命中，单字符巧合不给分', () => {
    expect(scoreCandidate('ax', { name: 'xy', description: '', kind: 'skill' })).toBe(0)
    expect(scoreCandidate('ab', { name: 'axb', description: '', kind: 'skill' })).toBeGreaterThan(0)
  })
})
