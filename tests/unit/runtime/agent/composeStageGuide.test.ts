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

  it('每份指南正文不超过 25 行', () => {
    for (const stageId of COMPOSE_STAGE_IDS) {
      const body = getComposeStageGuide(stageId).replace(/^[^\n]+\n/, '')
      expect(body.split('\n').length, stageId).toBeLessThanOrEqual(25)
    }
  })

  it('问：askQuestion 标推荐，只读边界', () => {
    const guide = getComposeStageGuide('interview')
    expect(guide).toContain('askQuestion')
    expect(guide).toContain('推荐')
    expect(guide).toContain('只读')
    expect(guide).toContain('stage_transition')
  })

  it('图：一页纸、critic 挑刺、save_plan', () => {
    const guide = getComposeStageGuide('blueprint')
    expect(guide).toContain('一页纸')
    expect(guide).toContain('critic')
    expect(guide).toContain('save_plan')
    expect(guide).toContain('stage_transition')
  })

  it('锤：todo_write 导入条目，小任务亲自写，大任务派 code', () => {
    const guide = getComposeStageGuide('build')
    expect(guide).toContain('todo_write')
    expect(guide).toContain('亲自')
    expect(guide).toContain('code')
    expect(guide).toContain('stage_transition')
  })

  it('验：派 inspector，未通过 return build', () => {
    const guide = getComposeStageGuide('inspect')
    expect(guide).toContain('inspector')
    expect(guide).toContain('return build')
    expect(guide).toContain('两轮')
    expect(guide).toContain('stage_transition')
  })

  it('交：三段收尾', () => {
    const guide = getComposeStageGuide('deliver')
    expect(guide).toContain('怎么用')
    expect(guide).toContain('我验了什么')
    expect(guide).toContain('没做的')
    expect(guide).not.toContain('证据')
    expect(guide).not.toContain('回执')
    expect(guide).not.toContain('覆盖率')
    expect(guide).toContain('stage_transition')
  })
})
