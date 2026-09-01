import { describe, expect, it } from 'vitest'
import {
  applyHostArchiveReadCapability,
  resolveSubagentProfileSnapshot
} from '../../../../src/runtime/subagents'
import { BUILTIN_SUBAGENTS } from '../../../../src/runtime/agent/core/SubAgentConfig'

describe('resolveSubagentProfileSnapshot', () => {
  it('校验 unknown 输入并冻结稳定 profile snapshot 与 configHash', () => {
    const raw = {
      id: 'code',
      name: 'code',
      description: 'writes code',
      prompt: 'do the work',
      allowedTools: ['read', 'write', 'read', 'task', 'task_followup'],
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

  it('profileId 取稳定 id，snapshot.name 取展示名', () => {
    const snapshot = resolveSubagentProfileSnapshot({
      id: 'code',
      name: '编程助手',
      description: 'writes code',
      prompt: 'do the work',
      allowedTools: ['read']
    }, 'code')

    expect(snapshot.profileId).toBe('code')
    expect(snapshot.name).toBe('编程助手')
  })

  it('递归工具只有显式开启时可见', () => {
    const snapshot = resolveSubagentProfileSnapshot({
      id: 'code',
      name: 'code',
      description: 'writes code',
      prompt: 'do the work',
      allowedTools: ['read', 'task']
    }, 'code', { allowRecursion: true })

    expect(snapshot.toolNames).toEqual(['read', 'task'])
  })

  it('保留 canonical modelEntryId binding 与显式 reasoning effort', () => {
    const snapshot = resolveSubagentProfileSnapshot({
      id: 'code',
      name: 'code',
      description: 'writes code',
      prompt: 'do the work',
      allowedTools: ['read'],
      model: {
        providerId: 'provider',
        modelEntryId: 'entry',
        reasoningEffort: 'medium'
      }
    }, 'code')

    expect(snapshot.model).toEqual({
      providerId: 'provider',
      modelEntryId: 'entry',
      reasoningEffort: 'medium'
    })
  })

  it('拒绝混用 modelEntryId 与旧 modelId 字段', () => {
    expect(() => resolveSubagentProfileSnapshot({
      id: 'code',
      name: 'code',
      description: 'writes code',
      prompt: 'do the work',
      allowedTools: ['read'],
      model: {
        providerId: 'provider',
        modelEntryId: 'entry',
        modelId: 'api-model'
      }
    }, 'code')).toThrow(/modelEntryId/)
  })

  it('read_only profile 永久剥离写工具与递归 delegation 工具', () => {
    const snapshot = resolveSubagentProfileSnapshot({
      id: 'explore',
      name: 'explore',
      description: 'inspect',
      prompt: 'read only',
      allowedTools: ['read', 'edit', 'write', 'bash', 'task']
    }, 'explore')

    expect(snapshot.permissionCeiling).toBe('read_only')
    expect(snapshot.toolNames).toEqual(['read'])
  })

  it('skillRoots 进入冻结快照与 configHash，路径变化会生成不同配置身份', () => {
    const base = {
      id: 'skill:inspect',
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

  it('未配置轮数时按 permissionCeiling 分档：只读与可写取不同默认，自定义只读 preset 走只读档', () => {
    const readOnly = resolveSubagentProfileSnapshot({
      id: 'custom-reader',
      name: 'reader',
      description: 'inspect',
      prompt: 'read only',
      allowedTools: ['read', 'grep']
    }, 'custom-reader')

    const workspaceWrite = resolveSubagentProfileSnapshot({
      id: 'custom-writer',
      name: 'writer',
      description: 'implement',
      prompt: 'write things',
      allowedTools: ['read', 'write']
    }, 'custom-writer')

    expect(readOnly.permissionCeiling).toBe('read_only')
    expect(workspaceWrite.permissionCeiling).toBe('workspace_write')
    expect(readOnly.maxToolRounds).not.toBe(workspaceWrite.maxToolRounds)
    // 内置 explore 同样不声明轮数，走与自定义只读 preset 相同的默认档
    const builtinExplore = BUILTIN_SUBAGENTS.find(s => s.id === 'explore')
    if (!builtinExplore) throw new Error('expected explore builtin')
    const exploreSnapshot = resolveSubagentProfileSnapshot(builtinExplore, 'explore')
    expect(exploreSnapshot.maxToolRounds).toBe(readOnly.maxToolRounds)
  })

  it('显式配置的轮数覆盖分档默认并进入 configHash', () => {
    const base = {
      id: 'custom-reader',
      name: 'reader',
      description: 'inspect',
      prompt: 'read only',
      allowedTools: ['read']
    }
    const withDefault = resolveSubagentProfileSnapshot(base, 'custom-reader')
    const explicit = resolveSubagentProfileSnapshot(
      { ...base, maxToolRounds: 7 },
      'custom-reader'
    )

    expect(explicit.maxToolRounds).toBe(7)
    expect(explicit.configHash).not.toBe(withDefault.configHash)
  })

  it('identity、类型与边界不合法时 fail closed', () => {
    expect(() => resolveSubagentProfileSnapshot(null, 'explore')).toThrow(/JSON object/)
    expect(() => resolveSubagentProfileSnapshot({
      id: 'other',
      name: 'other',
      description: 'x',
      prompt: 'x',
      allowedTools: []
    }, 'explore')).toThrow(/identity/)
    expect(() => resolveSubagentProfileSnapshot({
      name: 'explore',
      description: 'x',
      prompt: 'x',
      allowedTools: []
    }, 'explore')).toThrow(/\.id/)
    expect(() => resolveSubagentProfileSnapshot({
      id: 'explore',
      name: 'explore',
      description: 'x',
      prompt: 'x',
      allowedTools: ['read'],
      maxToolRounds: 0
    }, 'explore')).toThrow(/maxToolRounds/)
    expect(() => resolveSubagentProfileSnapshot({
      id: 'explore',
      name: 'explore',
      description: 'x',
      prompt: 'x',
      allowedTools: [],
      skillRoots: ['   ']
    }, 'explore')).toThrow(/skillRoots/)
  })
})

describe('builtin review profile', () => {
  it('解析为 read_only：写工具全部剥离，prompt 含审查职责语义', () => {
    const spec = BUILTIN_SUBAGENTS.find(s => s.id === 'review')
    expect(spec).toBeDefined()
    if (!spec) return

    const snapshot = resolveSubagentProfileSnapshot(spec, 'review')
    expect(snapshot.permissionCeiling).toBe('read_only')
    for (const writeTool of ['edit', 'write', 'bash', 'save_plan', 'switch_mode']) {
      expect(snapshot.toolNames).not.toContain(writeTool)
    }
    expect(snapshot.toolNames).toEqual(['ls', 'read', 'grep', 'find', 'code_context'])
    expect(snapshot.systemPrompt.length).toBeGreaterThan(0)
    expect(snapshot.systemPrompt).toMatch(/审查/)
  })
})

describe('builtin general-purpose profile', () => {
  it('解析为 workspace_write：可写能力由工具 effect 推导，不靠 prompt', () => {
    const spec = BUILTIN_SUBAGENTS.find(s => s.id === 'general-purpose')
    expect(spec).toBeDefined()
    if (!spec) return

    const snapshot = resolveSubagentProfileSnapshot(spec, 'general-purpose')
    expect(snapshot.permissionCeiling).toBe('workspace_write')
    expect(snapshot.toolNames).toEqual(expect.arrayContaining(['ls', 'read', 'write', 'bash', 'web_search', 'run_code']))
    for (const forbidden of ['task', 'invoke_skill', 'save_plan', 'stage_transition', 'askQuestion', 'switch_mode', 'todo_write']) {
      expect(snapshot.toolNames).not.toContain(forbidden)
    }
    expect(snapshot.toolNames).not.toContain('memory_search')
    expect(snapshot.systemPrompt).toMatch(/混合任务/)
  })

  it('不绑定模型时走派遣时 activeModel 冻结 header，不继承父 reasoning override', async () => {
    const spec = BUILTIN_SUBAGENTS.find(s => s.id === 'general-purpose')
    expect(spec).toBeDefined()
    if (!spec) return

    const snapshot = resolveSubagentProfileSnapshot(spec, 'general-purpose')
    expect(snapshot.model).toBeUndefined()
  })
})

describe('applyHostArchiveReadCapability', () => {
  it('宿主有 archive_read 时子工具列表继承该能力', () => {
    expect(applyHostArchiveReadCapability(['read', 'grep'], true)).toEqual([
      'read',
      'grep',
      'archive_read'
    ])
  })

  it('宿主有能力时不重复插入 archive_read', () => {
    expect(
      applyHostArchiveReadCapability(['read', 'archive_read', 'grep'], true)
    ).toEqual(['read', 'grep', 'archive_read'])
  })

  it('宿主无 archive_read 时子工具列表不得携带', () => {
    expect(
      applyHostArchiveReadCapability(['read', 'archive_read', 'grep'], false)
    ).toEqual(['read', 'grep'])
  })

  it('宿主能力未知时保持 profile 工具列表不变', () => {
    expect(
      applyHostArchiveReadCapability(['read', 'archive_read'], undefined)
    ).toEqual(['read', 'archive_read'])
  })
})
