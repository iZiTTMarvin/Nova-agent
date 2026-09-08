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
  describe('问阶段：仅放行只读工具', () => {
    it.each(READONLY_TOOLS)('放行 %s', (toolName) => {
      expect(getComposeStageToolDenial('interview', toolName)).toBeNull()
    })

    it.each(NON_READONLY_TOOLS)('拒绝 %s', (toolName) => {
      const denial = getComposeStageToolDenial('interview', toolName)
      expect(denial).not.toBeNull()
      expect(denial).toContain('问')
      expect(denial).toContain(toolName)
    })

    it('未知工具一律拒绝', () => {
      const denial = getComposeStageToolDenial('interview', 'some_future_tool')
      expect(denial).not.toBeNull()
      expect(denial).toContain('问')
    })

    it('拒绝文案说明如何解锁', () => {
      const denial = getComposeStageToolDenial('interview', 'write')
      expect(denial).toContain('stage_transition')
      expect(denial).toContain('访谈')
      expect(denial).toContain('一页纸')
    })
  })

  describe('图阶段：只读 + save_plan', () => {
    it.each(READONLY_TOOLS)('放行 %s', (toolName) => {
      expect(getComposeStageToolDenial('blueprint', toolName)).toBeNull()
    })

    it('放行 save_plan（计划文档是唯一允许的文件副作用）', () => {
      expect(getComposeStageToolDenial('blueprint', 'save_plan')).toBeNull()
    })

    it('放行 critic 子代理 task', () => {
      expect(getComposeStageToolDenial('blueprint', 'task', { subagent_type: 'critic' })).toBeNull()
    })

    it.each(['edit', 'write', 'bash', 'invoke_skill'])('拒绝 %s', (toolName) => {
      const denial = getComposeStageToolDenial('blueprint', toolName)
      expect(denial).not.toBeNull()
      expect(denial).toContain('图')
      expect(denial).toContain(toolName)
    })

    it('拒绝非 critic 的 task', () => {
      expect(getComposeStageToolDenial('blueprint', 'task', { subagent_type: 'code' })).toContain('task')
      expect(getComposeStageToolDenial('blueprint', 'task', { subagent_type: 'explore' })).toContain('task')
      expect(getComposeStageToolDenial('blueprint', 'task', { subagent_type: 'inspector' })).toContain('task')
    })

    it('未知工具一律拒绝', () => {
      const denial = getComposeStageToolDenial('blueprint', 'some_future_tool')
      expect(denial).not.toBeNull()
      expect(denial).toContain('图')
    })

    it('拒绝文案说明如何解锁', () => {
      const denial = getComposeStageToolDenial('blueprint', 'bash')
      expect(denial).toContain('stage_transition')
      expect(denial).toContain('锤')
    })
  })

  describe('shell_session 会话工具：按 action 收放', () => {
    it('interview 与 blueprint 阶段拒绝 write、放行只读 action', () => {
      expect(getComposeStageToolDenial('interview', 'shell_session', { action: 'write' })).toContain('写入')
      expect(getComposeStageToolDenial('blueprint', 'shell_session', { action: 'write' })).toContain('写入')
      expect(getComposeStageToolDenial('interview', 'shell_session', { action: 'write' })).toContain('锤')
      expect(getComposeStageToolDenial('interview', 'shell_session', { action: 'read' })).toBeNull()
      expect(getComposeStageToolDenial('blueprint', 'shell_session', { action: 'interrupt' })).toBeNull()
      expect(getComposeStageToolDenial('blueprint', 'shell_session', { action: 'stop' })).toBeNull()
    })

    it('锤及以后不干预任何 action', () => {
      expect(getComposeStageToolDenial('build', 'shell_session', { action: 'write' })).toBeNull()
    })
  })

  describe('锤及以后：不干预', () => {
    const OPEN_STAGES = ['build', 'inspect', 'deliver'] as const
    const ALL_TOOLS = [...READONLY_TOOLS, ...NON_READONLY_TOOLS, 'some_future_tool']

    it.each(OPEN_STAGES)('%s 阶段放行全部工具', (stage) => {
      for (const toolName of ALL_TOOLS) {
        expect(getComposeStageToolDenial(stage, toolName)).toBeNull()
      }
    })
  })

  it('五阶段都有确定行为（无遗漏分支）', () => {
    for (const stage of COMPOSE_STAGE_IDS) {
      expect(() => {
        getComposeStageToolDenial(stage, 'write')
        getComposeStageToolDenial(stage, 'read')
      }).not.toThrow()
    }
  })
})
