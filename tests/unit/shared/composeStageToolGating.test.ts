/**
 * compose 阶段工具门禁矩阵测试
 *
 * 只断言外部行为：阶段 × 工具能力的放行/拒绝，以及拒绝文案的中文可读性。
 */
import { describe, expect, it } from 'vitest'
import { getComposeStageToolDenial } from '../../../src/shared/composeLifecycle/stageToolGating'
import { COMPOSE_STAGE_IDS } from '../../../src/shared/composeLifecycle'

const READONLY_TOOLS = [
  'read',
  'ls',
  'grep',
  'find',
  'code_context',
  'web_search',
  'archive_read',
  'memory_search',
  'load_tools',
  'todo_write',
  'askQuestion',
  'stage_transition'
]

const NON_READONLY_TOOLS = ['edit', 'write', 'bash', 'save_plan', 'task', 'invoke_skill']

describe('compose 阶段工具门禁', () => {
  describe('构思阶段：仅放行只读工具', () => {
    it.each(READONLY_TOOLS)('放行 %s', (toolName) => {
      expect(getComposeStageToolDenial('brainstorm', toolName)).toBeNull()
    })

    it.each(NON_READONLY_TOOLS)('拒绝 %s', (toolName) => {
      const denial = getComposeStageToolDenial('brainstorm', toolName)
      expect(denial).not.toBeNull()
      expect(denial).toContain('构思')
      expect(denial).toContain(toolName)
    })

    it('未知工具一律拒绝', () => {
      const denial = getComposeStageToolDenial('brainstorm', 'some_future_tool')
      expect(denial).not.toBeNull()
      expect(denial).toContain('构思')
    })

    it('拒绝文案说明如何解锁', () => {
      const denial = getComposeStageToolDenial('brainstorm', 'write')
      expect(denial).toContain('stage_transition')
      expect(denial).toContain('确认')
    })
  })

  describe('计划阶段：只读 + save_plan', () => {
    it.each(READONLY_TOOLS)('放行 %s', (toolName) => {
      expect(getComposeStageToolDenial('plan', toolName)).toBeNull()
    })

    it('放行 save_plan（计划文档是唯一允许的文件副作用）', () => {
      expect(getComposeStageToolDenial('plan', 'save_plan')).toBeNull()
    })

    it.each(['edit', 'write', 'bash', 'task', 'invoke_skill'])('拒绝 %s', (toolName) => {
      const denial = getComposeStageToolDenial('plan', toolName)
      expect(denial).not.toBeNull()
      expect(denial).toContain('计划')
      expect(denial).toContain(toolName)
    })

    it('未知工具一律拒绝', () => {
      const denial = getComposeStageToolDenial('plan', 'some_future_tool')
      expect(denial).not.toBeNull()
      expect(denial).toContain('计划')
    })

    it('拒绝文案说明如何解锁', () => {
      const denial = getComposeStageToolDenial('plan', 'bash')
      expect(denial).toContain('stage_transition')
      expect(denial).toContain('批准')
    })
  })

  describe('开发及以后：不干预', () => {
    const OPEN_STAGES = ['implement', 'verify', 'review', 'report'] as const
    const ALL_TOOLS = [...READONLY_TOOLS, ...NON_READONLY_TOOLS, 'some_future_tool']

    it.each(OPEN_STAGES)('%s 阶段放行全部工具', (stage) => {
      for (const toolName of ALL_TOOLS) {
        expect(getComposeStageToolDenial(stage, toolName)).toBeNull()
      }
    })
  })

  it('六阶段都有确定行为（无遗漏分支）', () => {
    for (const stage of COMPOSE_STAGE_IDS) {
      // 每个阶段对写工具和只读工具都必须返回确定结果，不抛异常
      expect(() => {
        getComposeStageToolDenial(stage, 'write')
        getComposeStageToolDenial(stage, 'read')
      }).not.toThrow()
    }
  })
})
