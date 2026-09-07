/**
 * compose 阶段指南注入文本测试
 *
 * 只断言外部行为：五阶段各自的关键语义与统一的阶段标题前缀。
 */
import { describe, expect, it } from 'vitest'
import { getComposeStageGuide } from '../../../../src/runtime/agent/promptBuilder/stageGuides'
import {
  COMPOSE_STAGE_IDS,
  COMPOSE_STAGE_LABELS
} from '../../../../src/shared/composeLifecycle'

describe('getComposeStageGuide', () => {
  it('五阶段均返回带中文阶段标题前缀的指南', () => {
    for (const stageId of COMPOSE_STAGE_IDS) {
      const guide = getComposeStageGuide(stageId)
      expect(guide.startsWith(`[当前阶段: ${COMPOSE_STAGE_LABELS[stageId]} — 阶段指南]`)).toBe(true)
      expect(guide.length).toBeGreaterThan(50)
    }
  })

  it('问：软确认门与只读边界', () => {
    const guide = getComposeStageGuide('interview')
    expect(guide).toContain('确认')
    expect(guide).toContain('只读')
    expect(guide).toContain('stage_transition')
  })

  it('图：save_plan 写计划文档，用户批准的硬确认门', () => {
    const guide = getComposeStageGuide('blueprint')
    expect(guide).toContain('save_plan')
    expect(guide).toContain('.nova/plans/')
    expect(guide).toContain('批准')
    expect(guide).toContain('stage_transition')
  })

  it('锤：亲自实现、不派子代理，完成标准为计划任务全部完成', () => {
    const guide = getComposeStageGuide('build')
    expect(guide).toContain('亲自')
    expect(guide).toContain('不派遣子代理')
    expect(guide).toContain('验收标准')
  })

  it('验：唯一只读子代理 + 循环上限', () => {
    const guide = getComposeStageGuide('inspect')
    expect(guide).toContain('task')
    expect(guide).toContain('只读子代理')
    expect(guide).toContain('3 次')
    expect(guide).toContain('return')
  })

  it('验：brief 四要素与 review 子代理类型完整（自然语言交接约定）', () => {
    const guide = getComposeStageGuide('inspect')
    expect(guide).toContain('需求背景')
    expect(guide).toContain('计划文档位置')
    expect(guide).toContain('改动清单')
    expect(guide).toContain('验证证据')
    expect(guide).toContain('subagent_type: review')
    expect(guide).toContain('markdown')
  })

  it('交：自然语言总结交付与遗留问题', () => {
    const guide = getComposeStageGuide('deliver')
    expect(guide).toContain('总结')
    expect(guide).toContain('遗留问题')
    expect(guide).toContain('stage_transition')
  })
})
