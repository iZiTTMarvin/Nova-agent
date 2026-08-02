import { describe, expect, it } from 'vitest'
import { resolveSubagentProfileSnapshot } from '../../../../src/runtime/subagents'

describe('resolveSubagentProfileSnapshot', () => {
  it('校验 unknown 输入并冻结稳定 profile snapshot 与 configHash', () => {
    const raw = {
      name: 'code',
      description: 'writes code',
      prompt: 'do the work',
      allowedTools: ['read', 'write', 'read', 'task', 'start_workflow'],
      model: { providerID: 'provider', modelID: 'model' },
      maxToolRounds: 30,
      contextWindow: 128_000
    }

    const first = resolveSubagentProfileSnapshot(raw, 'code')
    const second = resolveSubagentProfileSnapshot(raw, 'code')

    expect(first).toEqual({
      profileId: 'code',
      name: 'code',
      description: 'writes code',
      systemPrompt: 'do the work',
      toolNames: ['read', 'write'],
      permissionCeiling: 'workspace_write',
      model: { providerId: 'provider', modelId: 'model' },
      maxToolRounds: 30,
      contextWindow: 128_000,
      configHash: expect.stringMatching(/^[0-9a-f]{64}$/)
    })
    expect(first.configHash).toBe(second.configHash)
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(first.toolNames)).toBe(true)
  })

  it('递归工具只有显式开启时可见，start_workflow 始终不可见', () => {
    const snapshot = resolveSubagentProfileSnapshot({
      name: 'code',
      description: 'writes code',
      prompt: 'do the work',
      allowedTools: ['read', 'task', 'start_workflow']
    }, 'code', { allowRecursion: true })

    expect(snapshot.toolNames).toEqual(['read', 'task'])
  })

  it('read_only profile 永久剥离写工具与递归 delegation 工具', () => {
    const snapshot = resolveSubagentProfileSnapshot({
      name: 'explore',
      description: 'inspect',
      prompt: 'read only',
      allowedTools: ['read', 'edit', 'write', 'bash', 'task', 'start_workflow']
    }, 'explore')

    expect(snapshot.permissionCeiling).toBe('read_only')
    expect(snapshot.toolNames).toEqual(['read'])
  })

  it('skillRoots 进入冻结快照与 configHash，路径变化会生成不同配置身份', () => {
    const base = {
      name: 'skill:inspect',
      description: 'inspect with skill references',
      prompt: 'read the referenced material',
      allowedTools: ['read'],
      skillRoots: ['D:/skills/inspect', 'D:/skills/inspect']
    }

    const first = resolveSubagentProfileSnapshot(base, 'skill:inspect')
    const second = resolveSubagentProfileSnapshot({
      ...base,
      skillRoots: ['D:/skills/other']
    }, 'skill:inspect')

    expect(first.skillRoots).toEqual(['D:/skills/inspect'])
    expect(Object.isFrozen(first.skillRoots)).toBe(true)
    expect(first.configHash).not.toBe(second.configHash)
  })

  it('identity、类型与边界不合法时 fail closed', () => {
    expect(() => resolveSubagentProfileSnapshot(null, 'explore')).toThrow(/JSON object/)
    expect(() => resolveSubagentProfileSnapshot({
      name: 'other',
      description: 'x',
      prompt: 'x',
      allowedTools: []
    }, 'explore')).toThrow(/identity/)
    expect(() => resolveSubagentProfileSnapshot({
      name: 'explore',
      description: 'x',
      prompt: 'x',
      allowedTools: ['read'],
      maxToolRounds: 0
    }, 'explore')).toThrow(/maxToolRounds/)
    expect(() => resolveSubagentProfileSnapshot({
      name: 'explore',
      description: 'x',
      prompt: 'x',
      allowedTools: [],
      skillRoots: ['   ']
    }, 'explore')).toThrow(/skillRoots/)
  })
})
