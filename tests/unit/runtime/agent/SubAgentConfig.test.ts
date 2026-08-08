import { describe, it, expect } from 'vitest'
import { BUILTIN_SUBAGENTS, getSubAgentSpec, listSubAgents } from '../../../../src/runtime/agent/core/SubAgentConfig'

describe('SubAgentConfig', () => {
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
    expect(spec?.allowedTools).toEqual(['ls', 'read', 'grep', 'find'])
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
})
