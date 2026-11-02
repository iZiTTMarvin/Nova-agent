/**
 * Tool Availability 三态行为：off 保持全量面（与历史 wire 一致）、shadow 旁路诊断、
 * on 按 Catalog deferred 组收窄；激活、恢复、required pin 与执行闸门语义。
 */
import { describe, expect, it } from 'vitest'
import type { ToolDefinition } from '../../../../src/runtime/model/types'
import {
  LOAD_TOOLS_ACTIVATED_MARKER,
  ToolAvailability
} from '../../../../src/runtime/tools/availability'
import { createLoadToolsTool } from '../../../../src/runtime/tools/loadTools'
import { createReadState } from '../../../../src/runtime/tools/editTool'
import {
  createAgentContext,
  getEffectiveToolDefinitions,
  projectEffectiveToolDefinitions
} from '../../../../src/runtime/agent/core/AgentContext'
import { ToolRegistry } from '../../../../src/runtime/tools/ToolRegistry'
import type { ToolExecutor } from '../../../../src/runtime/tools/types'

const REGISTERED = ['ls', 'read', 'grep', 'find', 'edit', 'write', 'bash', 'archive_read',
  'todo_write', 'askQuestion', 'web_search', 'invoke_skill', 'task', 'load_tools']

function stubDefinition(name: string): ToolDefinition {
  return {
    name,
    description: `${name} tool`,
    parameters: { type: 'object', properties: {} }
  }
}

const FULL_DEFS = REGISTERED.map(stubDefinition)

function createAvailability(mode: 'off' | 'shadow' | 'on'): ToolAvailability {
  const availability = new ToolAvailability()
  availability.setEconomyMode(mode)
  availability.bindRegisteredToolNames(REGISTERED)
  return availability
}

describe('ToolAvailability 三态投影', () => {
  it('off：全量面 + 隐藏 load_tools，与历史行为一致（deferred 工具不受组约束）', () => {
    const availability = createAvailability('off')
    const names = availability.filterDefinitions(FULL_DEFS).map(def => def.name)
    expect(names).toEqual(REGISTERED.filter(name => name !== 'load_tools'))
    // off 下 deferred 工具直接可执行（不启用 gating）
    expect(availability.isToolAvailable('task')).toBe(true)
  })

  it('shadow：与 off 完全相同的模型可见面（不改变实际请求）', () => {
    const availability = createAvailability('shadow')
    const names = availability.filterDefinitions(FULL_DEFS).map(def => def.name)
    expect(names).toEqual(REGISTERED.filter(name => name !== 'load_tools'))
    expect(availability.isToolAvailable('task')).toBe(true)
  })

  it('on：core + load_tools 连接器可见，deferred 工具激活前不可见', () => {
    const availability = createAvailability('on')
    const names = availability.filterDefinitions(FULL_DEFS).map(def => def.name)
    expect(names).toContain('read')
    expect(names).toContain('load_tools')
    expect(names).not.toContain('task')

    // wire 级：deferred schema 不得进入 provider request
    const providerNames = projectEffectiveToolDefinitions('default', FULL_DEFS, availability).map(
      def => def.name
    )
    expect(providerNames).not.toContain('task')
  })

  it('on：激活后下一投影生效（next-step activation），旧工具是新工具的前缀', () => {
    const availability = createAvailability('on')
    const before = availability.filterDefinitions(FULL_DEFS).map(def => def.name)
    expect(availability.activate('agent')).toEqual({ ok: true, group: 'agent', alreadyActive: false })

    const names = availability.filterDefinitions(FULL_DEFS).map(def => def.name)
    expect(names).toContain('task')
    expect(names.slice(0, before.length)).toEqual(before)
    const shuffled = [...FULL_DEFS].reverse()
    expect(availability.filterDefinitions(shuffled).map(def => def.name)).toEqual(names)
  })

  it('重复激活幂等：already_loaded，不重复记录激活', () => {
    const availability = createAvailability('on')
    availability.activate('agent')
    const second = availability.activate('agent')
    expect(second).toEqual({ ok: true, group: 'agent', alreadyActive: true })
    expect(availability.getDiagnostics(FULL_DEFS).activations).toHaveLength(1)
  })

  it('未知组 / 预留空组 / 经济未开启均拒绝激活', () => {
    const off = createAvailability('off')
    expect(off.activate('agent').ok).toBe(false)

    const on = createAvailability('on')
    expect(on.activate('not-a-group').ok).toBe(false)
    expect(on.activate('browser').ok).toBe(false)
    expect(on.isToolAvailable('task')).toBe(false)
  })

  it('required pin：Harness 指定的 deferred 工具第 0 步即可见可执行', () => {
    const availability = createAvailability('on')
    availability.setRequiredToolNames(['task'])
    expect(availability.filterDefinitions(FULL_DEFS).map(def => def.name)).toContain('task')
    expect(availability.isToolAvailable('task')).toBe(true)
  })

  it('on：执行闸门拒绝未激活 deferred 工具；core 工具不受组约束', () => {
    const availability = createAvailability('on')
    expect(availability.isToolAvailable('read')).toBe(true)
    expect(availability.isToolAvailable('task')).toBe(false)
  })

  it('注册清单缺席 live 组成员时：on 不下发 load_tools 连接器', () => {
    const availability = new ToolAvailability()
    availability.setEconomyMode('on')
    availability.bindRegisteredToolNames(REGISTERED.filter(name => name !== 'task'))
    const names = availability.filterDefinitions(FULL_DEFS).map(def => def.name)
    expect(names).not.toContain('load_tools')
  })
})

describe('激活态持久化与恢复', () => {
  it('从会话持久化状态恢复（权威路径），未知 / 已删除组安全忽略', () => {
    const availability = createAvailability('off')
    const { restoredGroups } = availability.restoreFromSessionState({
      version: 1,
      activatedGroups: ['agent', 'web', 'memory', 'ghost-group']
    })
    expect(restoredGroups).toEqual(['agent'])
    expect(availability.getActivatedGroups().has('agent')).toBe(true)
  })

  it('历史 orchestration alias 归一化为 agent', () => {
    const availability = createAvailability('off')
    const { restoredGroups } = availability.restoreFromSessionState({
      version: 1,
      activatedGroups: ['orchestration']
    })
    expect(restoredGroups).toEqual(['agent'])
  })

  it('损坏 / 未知版本的持久化字段被忽略，且不阻断后续消息回填', () => {
    const availability = createAvailability('on')
    const corrupt = availability.restoreFromSessionState({
      version: 99,
      activatedGroups: ['agent']
    })
    expect(corrupt.usable).toBe(false)
    expect(corrupt.restoredGroups).toEqual([])
    expect(availability.restoreFromSessionState('corrupt').usable).toBe(false)
    expect(availability.restoreFromSessionState(null).usable).toBe(false)
    expect(availability.restoreFromSessionState({
      version: 2,
      activatedGroups: ['agent', 42]
    }).usable).toBe(false)
    expect(availability.restoreFromSessionState({
      version: 2,
      activatedGroups: ['agent', '']
    }).usable).toBe(false)

    // 损坏字段视同缺失：消息 marker 回填仍可接管
    const backfill = availability.backfillFromMessages([
      {
        role: 'assistant',
        toolCalls: [{ id: 'c1', name: 'load_tools', arguments: JSON.stringify({ group: 'agent' }) }]
      },
      {
        role: 'tool',
        toolCallId: 'c1',
        content: `Activated\n${LOAD_TOOLS_ACTIVATED_MARKER}agent`
      }
    ])
    expect(backfill.restoredGroups).toEqual(['agent'])
  })

  it('旧消息 marker 回填：只计成功激活，持久态恢复后不再重建', () => {
    const availability = createAvailability('on')
    const { restoredGroups } = availability.backfillFromMessages([
      {
        role: 'assistant',
        toolCalls: [
          { id: 'c1', name: 'load_tools', arguments: JSON.stringify({ group: 'orchestration' }) },
          { id: 'c2', name: 'load_tools', arguments: JSON.stringify({ group: 'web' }) }
        ]
      },
      {
        role: 'tool',
        toolCallId: 'c1',
        content: `Activated\n${LOAD_TOOLS_ACTIVATED_MARKER}orchestration`
      },
      {
        role: 'tool',
        toolCallId: 'c2',
        content: 'error: unknown group'
      }
    ])
    // alias 归一 + 已删除组忽略 + 失败调用不计入
    expect(restoredGroups).toEqual(['agent'])
    expect(availability.isToolAvailable('task')).toBe(true)

    // 已初始化后，后续消息扫描（如 injectHistory）不得清空持久态
    const again = availability.backfillFromMessages([])
    expect(again.restoredGroups).toEqual(['agent'])
  })

  it('持久化快照：无激活组返回 null，有则按激活先后写入 v2', () => {
    const availability = createAvailability('on')
    expect(availability.getPersistableState()).toBeNull()
    availability.activate('agent')
    expect(availability.getPersistableState()).toEqual({
      version: 2,
      activatedGroups: ['agent']
    })
  })

  it('激活后通过持久化回调通知宿主', () => {
    const availability = createAvailability('on')
    const persisted: Array<{ version: 1 | 2; activatedGroups: readonly string[] }> = []
    availability.setPersistCallback(state => persisted.push(state))
    availability.activate('agent')
    expect(persisted).toEqual([{ version: 2, activatedGroups: ['agent'] }])
  })
})

describe('getEffectiveToolDefinitions mode ∩ availability', () => {
  function stubTool(name: string): ToolExecutor {
    return {
      name,
      description: name,
      parameters: { type: 'object', properties: {} },
      async execute() {
        return { success: true, output: 'ok' }
      }
    }
  }

  it('先 mode 后 group：plan 仍隐藏 write，即使经济关闭', () => {
    const registry = new ToolRegistry()
    for (const name of ['read', 'write', 'task', 'load_tools']) {
      registry.register(stubTool(name))
    }
    const availability = createAvailability('off')

    const ctx = createAgentContext({
      readState: createReadState(),
      toolRegistry: registry,
      toolAvailability: availability,
      mode: 'plan'
    })

    const names = getEffectiveToolDefinitions(ctx).map(def => def.name)
    expect(names).toContain('read')
    expect(names).not.toContain('write')
    expect(names).not.toContain('load_tools')
  })

  it('economy on：plan 模式下未激活的 task 不进入模型可见面', () => {
    const names = projectEffectiveToolDefinitions(
      'plan',
      FULL_DEFS,
      createAvailability('on')
    ).map(def => def.name)
    expect(names).not.toContain('task')
    expect(names).toContain('read')
  })
})

describe('load_tools 工具', () => {
  it('成功激活并写入恢复标记；重复调用返回 already loaded', async () => {
    const availability = createAvailability('on')
    const tool = createLoadToolsTool({
      getAvailability: () => availability,
      registeredToolNames: REGISTERED
    })
    const first = await tool.execute(
      { group: 'agent' },
      { workingDir: process.cwd(), readState: createReadState() }
    )
    expect(first.success).toBe(true)
    expect(first.output).toContain(`${LOAD_TOOLS_ACTIVATED_MARKER}agent`)
    expect(first.output).toContain('next model step')
    expect(availability.isToolAvailable('task')).toBe(true)

    const second = await tool.execute(
      { group: 'agent' },
      { workingDir: process.cwd(), readState: createReadState() }
    )
    expect(second.success).toBe(true)
    expect(second.output).toContain('already loaded')
    expect(second.output).toContain(`${LOAD_TOOLS_ACTIVATED_MARKER}agent`)
  })

  it('部分成员注册时，成员列表与契约回调都只包含已注册项', async () => {
    const availability = createAvailability('on')
    const tool = createLoadToolsTool({
      getAvailability: () => availability,
      registeredToolNames: REGISTERED,
      renderActivatedContract: members => `contract:${members.join(',')}`
    })
    const result = await tool.execute(
      { group: 'agent' },
      { workingDir: process.cwd(), readState: createReadState() }
    )
    expect(result.success).toBe(true)
    expect(result.output).toContain('Members: task\n')
    expect(result.output).toContain('contract:task')
    expect(result.output).not.toContain('task_followup')
  })

  it('enum 仅含 live 组；描述不含历史组与预留组', () => {
    const tool = createLoadToolsTool({
      getAvailability: () => null,
      registeredToolNames: REGISTERED
    })
    const groupSchema = (tool.parameters as { properties: { group: { enum?: string[] } } })
      .properties.group
    expect(groupSchema.enum).toEqual(['agent'])
    expect(tool.description).toContain('agent')
    expect(tool.description).not.toContain('browser')
    expect(tool.description).not.toContain('orchestration')
  })

  it('未知组与经济未启用返回错误', async () => {
    const off = createAvailability('off')
    const offTool = createLoadToolsTool({
      getAvailability: () => off,
      registeredToolNames: REGISTERED
    })
    const offResult = await offTool.execute(
      { group: 'agent' },
      { workingDir: process.cwd(), readState: createReadState() }
    )
    expect(offResult.success).toBe(false)

    const on = createAvailability('on')
    const onTool = createLoadToolsTool({
      getAvailability: () => on,
      registeredToolNames: REGISTERED
    })
    const badResult = await onTool.execute(
      { group: 'nope' },
      { workingDir: process.cwd(), readState: createReadState() }
    )
    expect(badResult.success).toBe(false)
    expect(badResult.error).toContain('未知工具组')
  })
})

describe('Tool Economy 诊断', () => {
  it('shadow：wouldHide 报告将被隐藏的 deferred 工具，被调用后记为 wouldMiss', () => {
    const availability = createAvailability('shadow')
    const diagnostics = availability.getDiagnostics(FULL_DEFS)
    expect(diagnostics.mode).toBe('shadow')
    expect(diagnostics.wouldHideTools).toEqual(['task'])
    expect(diagnostics.wouldMissTools).toEqual([])

    // 模型实际调用了 task（shadow 全量面可见）：记为 would-miss
    availability.isToolAvailable('task')
    expect(availability.getDiagnostics(FULL_DEFS).wouldMissTools).toEqual(['task'])
  })

  it('on：schema 收缩与 unused activation 指标', () => {
    const availability = createAvailability('on')
    const before = availability.getDiagnostics(FULL_DEFS)
    expect(before.visibleToolCount).toBe(FULL_DEFS.length - 1) // task 隐藏，load_tools 在场
    expect(before.hiddenToolCount).toBe(1)
    expect(before.fullToolSchemaChars).toBeGreaterThan(before.visibleToolSchemaChars)
    expect(before.toolSchemaCharReduction).toBeGreaterThan(0)

    availability.activate('agent')
    // 激活后从未使用 → unused activation
    const afterActivation = availability.getDiagnostics(FULL_DEFS)
    expect(afterActivation.unusedActivationCount).toBe(1)
    // 执行闸门观察到成员调用 → 不再计 unused
    availability.isToolAvailable('task')
    expect(availability.getDiagnostics(FULL_DEFS).unusedActivationCount).toBe(0)
  })

  it('off：可见面仅少 load_tools 连接器，deferred 工具不产生额外收缩', () => {
    const availability = createAvailability('off')
    const diagnostics = availability.getDiagnostics(FULL_DEFS)
    expect(diagnostics.hiddenToolCount).toBe(1)
    expect(diagnostics.visibleToolCount).toBe(diagnostics.fullToolCount - 1)
    // would-be 指标仍按 on 语义计算，供 shadow 评估对比
    expect(diagnostics.wouldHideTools).toEqual(['task'])
  })
})

describe('economy=on 激活顺序与 required pin', () => {
  const ORDER_DEFS = [
    ...FULL_DEFS,
    stubDefinition('browser_open'),
    stubDefinition('browser_observe')
  ]

  function availabilityOn(names = ORDER_DEFS.map(def => def.name)): ToolAvailability {
    const availability = new ToolAvailability()
    availability.setEconomyMode('on')
    availability.bindRegisteredToolNames(names)
    return availability
  }

  it('economy=off 输出顺序与历史行为一致', () => {
    const availability = createAvailability('off')
    expect(availability.filterDefinitions(FULL_DEFS).map(def => def.name)).toEqual(
      REGISTERED.filter(name => name !== 'load_tools')
    )
  })

  it('依次激活 agent → browser 与反向激活均满足旧 tools 是新 tools 的前缀', () => {
    const forward = availabilityOn()
    const forward0 = forward.filterDefinitions(ORDER_DEFS).map(def => def.name)
    forward.activate('agent')
    const forward1 = forward.filterDefinitions(ORDER_DEFS).map(def => def.name)
    forward.activate('browser')
    const forward2 = forward.filterDefinitions(ORDER_DEFS).map(def => def.name)
    expect(forward1.slice(0, forward0.length)).toEqual(forward0)
    expect(forward2.slice(0, forward1.length)).toEqual(forward1)
    expect(forward2.slice(forward1.length)).toEqual(['browser_open', 'browser_observe'])

    const reverse = availabilityOn()
    reverse.filterDefinitions(ORDER_DEFS)
    reverse.activate('browser')
    const reverse1 = reverse.filterDefinitions(ORDER_DEFS).map(def => def.name)
    reverse.activate('agent')
    const reverse2 = reverse.filterDefinitions(ORDER_DEFS).map(def => def.name)
    expect(reverse2.slice(0, reverse1.length)).toEqual(reverse1)
    expect(reverse2.slice(reverse1.length)).toContain('task')
    expect(forward2).not.toEqual(reverse2)
  })

  it('重复激活不重复、不重排', () => {
    const availability = availabilityOn()
    availability.activate('browser')
    availability.activate('agent')
    const once = availability.filterDefinitions(ORDER_DEFS).map(def => def.name)
    expect(availability.activate('browser')).toEqual({
      ok: true,
      group: 'browser',
      alreadyActive: true
    })
    expect(availability.filterDefinitions(ORDER_DEFS).map(def => def.name)).toEqual(once)
  })

  it('运行中新增 required pin 纯追加；删除后不再出现在可见面', () => {
    const availability = availabilityOn()
    const baseline = availability.filterDefinitions(ORDER_DEFS).map(def => def.name)
    availability.setRequiredToolNames(['task'])
    const pinned = availability.filterDefinitions(ORDER_DEFS).map(def => def.name)
    expect(pinned.slice(0, baseline.length)).toEqual(baseline)
    expect(pinned.at(-1)).toBe('task')
    availability.setRequiredToolNames([])
    expect(availability.filterDefinitions(ORDER_DEFS).map(def => def.name)).toEqual(baseline)
  })

  it('mode 核心集变化后重建基线，不保留旧模式缺失工具', () => {
    const availability = availabilityOn()
    const plan = projectEffectiveToolDefinitions('plan', ORDER_DEFS, availability)
    expect(plan.map(def => def.name)).not.toContain('write')

    const defaultMode = projectEffectiveToolDefinitions('default', ORDER_DEFS, availability)
    expect(defaultMode.map(def => def.name)).toContain('write')
  })

  it('v2 恢复后再次激活只追加', () => {
    const first = availabilityOn()
    first.activate('browser')
    first.activate('agent')
    const persisted = first.getPersistableState()
    const restored = availabilityOn()
    const result = restored.restoreFromSessionState(persisted)
    expect(result.usable).toBe(true)
    expect(result.orderMigrated).toBe(false)
    const before = restored.filterDefinitions(ORDER_DEFS).map(def => def.name)
    restored.activate('agent')
    expect(restored.filterDefinitions(ORDER_DEFS).map(def => def.name)).toEqual(before)
  })

  it('v1 能从成功 load_tools 历史恢复真实顺序', () => {
    const availability = availabilityOn()
    const restored = availability.restoreFromSessionState(
      { version: 1, activatedGroups: ['agent', 'browser'] },
      [
        {
          role: 'assistant',
          toolCalls: [
            { id: 'c1', name: 'load_tools', arguments: JSON.stringify({ group: 'browser' }) },
            { id: 'c2', name: 'load_tools', arguments: JSON.stringify({ group: 'agent' }) }
          ]
        },
        {
          role: 'tool',
          toolCallId: 'c1',
          content: `${LOAD_TOOLS_ACTIVATED_MARKER}browser`
        },
        {
          role: 'tool',
          toolCallId: 'c2',
          content: `${LOAD_TOOLS_ACTIVATED_MARKER}agent`
        }
      ]
    )
    expect(restored.usable).toBe(true)
    expect(restored.orderMigrated).toBe(false)
    expect(restored.restoredGroups).toEqual(['browser', 'agent'])
  })

  it('v1 无法恢复顺序时采用确定性顺序并标记一次性迁移', () => {
    const availability = availabilityOn()
    const restored = availability.restoreFromSessionState({
      version: 1,
      activatedGroups: ['browser', 'agent']
    })
    expect(restored.usable).toBe(true)
    expect(restored.orderMigrated).toBe(true)
    expect(restored.restoredGroups).toEqual(['agent', 'browser'])
  })
})
