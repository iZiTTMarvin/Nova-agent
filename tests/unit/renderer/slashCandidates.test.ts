/**
 * slashCandidates 评分与过滤单测
 */
import { describe, expect, it } from 'vitest'
import {
  filterAndRankCandidates,
  nativeCommandsToCandidates,
  pilotSkillsToCandidates,
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
  it('输入 / 时命令排在技能前，同组按名称确定性排序', () => {
    const result = filterAndRankCandidates('', candidates)
    expect(result.map(candidate => candidate.name)).toEqual(['commit', 'code-review', 'onboard'])
  })

  it('没有技能候选时仍映射并返回三个原生命令', () => {
    const result = filterAndRankCandidates('', nativeCommandsToCandidates())
    expect(result.map(candidate => ({ name: candidate.name, kind: candidate.kind }))).toEqual([
      { name: 'compact', kind: 'command' },
      { name: 'init', kind: 'command' },
      { name: 'plan', kind: 'command' }
    ])
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

describe('pilotSkillsToCandidates', () => {
  it('技能列表为空时返回「选择技能…」引导动作项', () => {
    const candidates = pilotSkillsToCandidates([])
    expect(candidates).toHaveLength(1)
    expect(candidates[0].name).toBe('选择技能…')
    expect(candidates[0].isAction).toBe(true)
    expect(candidates[0].kind).toBe('skill')
  })

  it('技能列表非空时在已许可技能末尾追加「管理可用技能…」动作项', () => {
    const candidates = pilotSkillsToCandidates([
      makeSkill({ name: 'frontend-design', description: '前端设计' })
    ])
    expect(candidates).toHaveLength(2)
    expect(candidates[0].name).toBe('frontend-design')
    expect(candidates[0].isAction).toBeUndefined()
    expect(candidates[1].name).toBe('管理可用技能…')
    expect(candidates[1].isAction).toBe(true)
  })

  it('排序时动作项排在已许可技能之后，命令依然排在最前', () => {
    const pilotCandidates = pilotSkillsToCandidates([
      makeSkill({ name: 'zebra' }),
      makeSkill({ name: 'apple' })
    ])
    const all = [...nativeCommandsToCandidates(), ...pilotCandidates]
    const ranked = filterAndRankCandidates('', all)
    const names = ranked.map(c => c.name)
    expect(names.slice(0, 3)).toEqual(['compact', 'init', 'plan'])
    expect(names.slice(3)).toEqual(['apple', 'zebra', '管理可用技能…'])
  })
})
