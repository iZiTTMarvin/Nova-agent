/**
 * slashCandidates 评分与过滤单测
 */
import { describe, expect, it } from 'vitest'
import {
  filterAndRankCandidates,
  scoreCandidate,
  skillsToCandidates,
  type SlashCandidate
} from '../../../src/renderer/features/skills/slashCandidates'
import type { SkillSummary } from '../../../src/shared/skills/types'

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

/** 构造最小 SkillSummary，仅覆盖 skillsToCandidates 过滤所需字段 */
function makeSkill(overrides: Partial<SkillSummary> = {}): SkillSummary {
  return {
    name: 'test-skill',
    description: '测试',
    source: 'builtin',
    sourcePath: '',
    userInvocable: true,
    modelInvocable: true,
    enabled: true,
    invalid: false,
    warnings: [],
    bodyPreview: '',
    hasSupportingFiles: false,
    ...overrides
  }
}

describe('skillsToCandidates 过滤', () => {
  it('保留 userInvocable、enabled、非 hidden、非 invalid 的技能', () => {
    const result = skillsToCandidates([makeSkill({ name: 'onboard' })])
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('onboard')
  })

  it('过滤 hidden 编排技能', () => {
    const result = skillsToCandidates([
      makeSkill({ name: 'br-debug', hidden: true }),
      makeSkill({ name: 'onboard' })
    ])
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('onboard')
  })

  it('过滤 invalid 技能', () => {
    const result = skillsToCandidates([
      makeSkill({ name: 'bad-skill', invalid: true }),
      makeSkill({ name: 'onboard' })
    ])
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('onboard')
  })

  it('过滤 userInvocable 为 false 的技能', () => {
    const result = skillsToCandidates([
      makeSkill({ name: 'model-only', userInvocable: false }),
      makeSkill({ name: 'onboard' })
    ])
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('onboard')
  })

  it('hidden 未设置时视为 false，不影响展示', () => {
    const skill = makeSkill({ name: 'no-hidden-field' })
    delete (skill as Record<string, unknown>).hidden
    const result = skillsToCandidates([skill])
    expect(result).toHaveLength(1)
  })
})
