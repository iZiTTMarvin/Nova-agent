import { describe, it, expect } from 'vitest'
import { BUILTIN_SUBAGENTS, getSubAgentSpec, listSubAgents } from '../../../../src/runtime/agent/core/SubAgentConfig'
import { BUILTIN_SUBAGENT_IDS, isBuiltinSubagentId } from '../../../../src/shared/subagents/presetIdentity'

describe('SubAgentConfig', () => {
  it('内置 definition 与共享保留 ID 双向对账，防止身份出现第二来源', () => {
    const ids = BUILTIN_SUBAGENTS.map(s => s.id).sort()
    expect(ids).toEqual(Object.values(BUILTIN_SUBAGENT_IDS).sort())
    for (const spec of BUILTIN_SUBAGENTS) {
      expect(isBuiltinSubagentId(spec.id)).toBe(true)
      expect(spec.enabled).toBe(true)
    }
  })

  it('内置 explore 子代理', () => {
    const spec = getSubAgentSpec('explore')
    expect(spec?.allowedTools).toContain('read')
    expect(spec?.allowedTools).not.toContain('write')
  })

  it('内置 code 子代理含写工具', () => {
    const spec = getSubAgentSpec('code')
    expect(spec?.allowedTools).toContain('edit')
    expect(spec?.allowedTools).toContain('bash')
  })

  it('内置 review 子代理为只读审查 profile', () => {
    const spec = getSubAgentSpec('review')
    expect(spec?.description).toContain('审查')
    expect(spec?.allowedTools).toEqual(['ls', 'read', 'grep', 'find', 'code_context'])
    expect(spec?.allowedTools.some(t => t === 'edit' || t === 'write' || t === 'bash')).toBe(false)
    expect(spec?.maxToolRounds).toBe(20)
    expect(spec?.prompt).toBeTruthy()
    expect(spec?.prompt).toMatch(/审查/)
    expect(spec?.prompt).toContain('不修改任何文件')
  })

  it('未知类型返回 undefined', () => {
    expect(getSubAgentSpec('unknown')).toBeUndefined()
  })

  it('listSubAgents 包含内置', () => {
    const names = listSubAgents().map(s => s.name)
    expect(names).toContain('explore')
    expect(names).toContain('code')
    expect(names).toContain('review')
  })

  it('BUILTIN_SUBAGENTS 至少 3 个', () => {
    expect(BUILTIN_SUBAGENTS.length).toBeGreaterThanOrEqual(3)
  })

  it('内置 general-purpose 为可写混合 profile 且不可继续派遣子代理', () => {
    const spec = getSubAgentSpec('general-purpose')
    expect(spec).toBeDefined()
    expect(spec?.description).toContain('通用')
    expect(spec?.allowedTools).toEqual(expect.arrayContaining(['read', 'edit', 'write', 'bash', 'web_search', 'run_code']))
    for (const forbidden of ['task', 'invoke_skill', 'save_plan', 'stage_transition', 'askQuestion', 'switch_mode', 'todo_write']) {
      expect(spec?.allowedTools).not.toContain(forbidden)
    }
    expect(spec?.allowedTools).not.toContain('memory_search')
    expect(spec?.maxToolRounds).toBe(30)
    expect(spec?.prompt).toMatch(/混合任务/)
  })
})
