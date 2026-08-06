import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../../../../src/runtime/model/types'
import {
  LOAD_TOOLS_ACTIVATED_MARKER,
  ToolAvailability
} from '../../../../src/runtime/tools/availability'
import { createLoadToolsTool } from '../../../../src/runtime/tools/loadTools'
import { createReadState } from '../../../../src/runtime/tools/editTool'
import {
  createAgentContext,
  getEffectiveToolDefinitions
} from '../../../../src/runtime/agent/core/AgentContext'
import { ToolRegistry } from '../../../../src/runtime/tools/ToolRegistry'
import type { ToolExecutor } from '../../../../src/runtime/tools/types'

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

describe('ToolAvailability', () => {
  it('enabled=false 时隐藏 load_tools，其余恒等', () => {
    const availability = new ToolAvailability()
    availability.setEnabled(false)
    const filtered = availability.filterDefinitions([
      { name: 'read' },
      { name: 'web_search' },
      { name: 'load_tools' }
    ])
    expect(filtered.map(t => t.name)).toEqual(['read', 'web_search'])
  })

  it('enabled 时默认只暴露 core + load_tools，激活后下一读生效', () => {
    const availability = new ToolAvailability()
    availability.setEnabled(true)
    const defs = [
      { name: 'read' },
      { name: 'web_search' },
      { name: 'load_tools' },
      { name: 'task' }
    ]
    expect(availability.filterDefinitions(defs).map(t => t.name)).toEqual([
      'read',
      'load_tools'
    ])

    const activated = availability.activate('web')
    expect(activated.ok).toBe(true)
    expect(availability.filterDefinitions(defs).map(t => t.name)).toEqual([
      'read',
      'web_search',
      'load_tools'
    ])
  })

  it('非法组名拒绝激活', () => {
    const availability = new ToolAvailability()
    availability.setEnabled(true)
    const result = availability.activate('not-a-group')
    expect(result.ok).toBe(false)
  })

  it('enabled=false 时拒绝 activate', () => {
    const availability = new ToolAvailability()
    availability.setEnabled(false)
    const result = availability.activate('web')
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toContain('未启用')
  })

  it('从消息历史恢复已成功激活的组', () => {
    const availability = new ToolAvailability()
    availability.setEnabled(true)
    const messages: ChatMessage[] = [
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          {
            id: 'c1',
            name: 'load_tools',
            arguments: JSON.stringify({ group: 'memory' })
          }
        ]
      },
      {
        role: 'tool',
        toolCallId: 'c1',
        content: `Activated\n${LOAD_TOOLS_ACTIVATED_MARKER}memory`
      }
    ]
    availability.restoreFromMessages(messages)
    expect(availability.isToolAvailable('memory_search')).toBe(true)
    expect(availability.isToolAvailable('web_search')).toBe(false)
  })

  it('失败的 load_tools 结果不恢复激活态', () => {
    const availability = new ToolAvailability()
    availability.setEnabled(true)
    availability.restoreFromMessages([
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          {
            id: 'c1',
            name: 'load_tools',
            arguments: JSON.stringify({ group: 'web' })
          }
        ]
      },
      {
        role: 'tool',
        toolCallId: 'c1',
        content: 'error: unknown group'
      }
    ])
    expect(availability.isToolAvailable('web_search')).toBe(false)
  })
})

describe('getEffectiveToolDefinitions mode ∩ group', () => {
  it('先 mode 后 group：plan 仍隐藏 write，即使工具经济关闭', () => {
    const registry = new ToolRegistry()
    for (const name of ['read', 'write', 'web_search', 'load_tools']) {
      registry.register(stubTool(name))
    }
    const availability = new ToolAvailability()
    availability.setEnabled(false)

    const ctx = createAgentContext({
      readState: createReadState(),
      toolRegistry: registry,
      toolAvailability: availability,
      mode: 'plan'
    })

    const names = getEffectiveToolDefinitions(ctx).map(t => t.name)
    expect(names).toContain('read')
    expect(names).not.toContain('write')
    expect(names).not.toContain('load_tools')
  })

  it('economy 开启时 plan 下未激活的 web_search 被 group 过滤', () => {
    const registry = new ToolRegistry()
    for (const name of ['read', 'web_search', 'load_tools']) {
      registry.register(stubTool(name))
    }
    const availability = new ToolAvailability()
    availability.setEnabled(true)

    const ctx = createAgentContext({
      readState: createReadState(),
      toolRegistry: registry,
      toolAvailability: availability,
      mode: 'plan'
    })

    expect(getEffectiveToolDefinitions(ctx).map(t => t.name).sort()).toEqual([
      'load_tools',
      'read'
    ])
  })
})

describe('load_tools tool', () => {
  it('成功激活并写入恢复标记', async () => {
    const availability = new ToolAvailability()
    availability.setEnabled(true)
    const tool = createLoadToolsTool({ getAvailability: () => availability })
    const result = await tool.execute(
      { group: 'orchestration' },
      {
        workingDir: process.cwd(),
        readState: createReadState()
      }
    )
    expect(result.success).toBe(true)
    expect(result.output).toContain(`${LOAD_TOOLS_ACTIVATED_MARKER}orchestration`)
    expect(availability.isToolAvailable('task')).toBe(true)
  })

  it('未知组返回错误', async () => {
    const availability = new ToolAvailability()
    availability.setEnabled(true)
    const tool = createLoadToolsTool({ getAvailability: () => availability })
    const result = await tool.execute(
      { group: 'nope' },
      {
        workingDir: process.cwd(),
        readState: createReadState()
      }
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain('未知工具组')
  })
})
