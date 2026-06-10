import { describe, it, expect } from 'vitest'
import { BUILTIN_SUBAGENTS, getSubAgentSpec, listSubAgents } from '../../../../src/runtime/agent/SubAgentConfig'

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

  it('未知类型返回 undefined', () => {
    expect(getSubAgentSpec('unknown')).toBeUndefined()
  })

  it('listSubAgents 包含内置', () => {
    const names = listSubAgents().map(s => s.name)
    expect(names).toContain('explore')
    expect(names).toContain('code')
  })

  it('BUILTIN_SUBAGENTS 至少 2 个', () => {
    expect(BUILTIN_SUBAGENTS.length).toBeGreaterThanOrEqual(2)
  })
})
