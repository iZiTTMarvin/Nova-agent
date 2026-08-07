/**
 * compose 阶段指南注入文本测试
 *
 * 只断言外部行为：六阶段各自的关键语义与统一的阶段标题前缀。
 */
import { describe, expect, it } from 'vitest'
import { getComposeStageGuide } from '../../../../src/runtime/agent/promptBuilder/stageGuides'
import {
  COMPOSE_STAGE_IDS,
  COMPOSE_STAGE_LABELS
} from '../../../../src/shared/composeLifecycle'

describe('getComposeStageGuide', () => {
  it('六阶段均返回带中文阶段标题前缀的指南', () => {
    for (const stageId of COMPOSE_STAGE_IDS) {
      const guide = getComposeStageGuide(stageId)
      expect(guide.startsWith(`[当前阶段: ${COMPOSE_STAGE_LABELS[stageId]} — 阶段指南]`)).toBe(true)
      expect(guide.length).toBeGreaterThan(50)
    }
  })

  it('构思：软确认门与只读边界', () => {
    const guide = getComposeStageGuide('brainstorm')
    expect(guide).toContain('确认')
    expect(guide).toContain('只读')
    expect(guide).toContain('stage_transition')
  })

  it('计划：save_plan 写计划文档，用户批准的硬确认门', () => {
    const guide = getComposeStageGuide('plan')
    expect(guide).toContain('save_plan')
    expect(guide).toContain('.nova/plans/')
    expect(guide).toContain('批准')
    expect(guide).toContain('stage_transition')
  })

  it('开发：亲自实现、不派子代理，完成标准为计划任务全部完成', () => {
    const guide = getComposeStageGuide('implement')
    expect(guide).toContain('亲自')
    expect(guide).toContain('不派遣子代理')
    expect(guide).toContain('验收标准')
  })

  it('验证：亲自跑 typecheck/测试/构建，禁止假绿', () => {
    const guide = getComposeStageGuide('verify')
    expect(guide).toContain('typecheck')
    expect(guide).toContain('测试')
    expect(guide).toContain('假绿')
  })

  it('审查：唯一只读子代理 + 3 次循环上限', () => {
    const guide = getComposeStageGuide('review')
    expect(guide).toContain('task')
    expect(guide).toContain('只读子代理')
    expect(guide).toContain('3 次')
    expect(guide).toContain('return')
  })

  it('收尾：自然语言总结交付与遗留问题', () => {
    const guide = getComposeStageGuide('report')
    expect(guide).toContain('总结')
    expect(guide).toContain('遗留问题')
    expect(guide).toContain('stage_transition')
  })
})
