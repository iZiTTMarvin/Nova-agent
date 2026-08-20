/**
 * code-readonly 呈现模式投影与 SDK 生成测试：
 * direct 模式行为零变化；code-readonly 模式下可嵌套只读工具改由 SDK 暴露且不重复出现；
 * SDK 声明字节级稳定；未激活 deferred 工具不进 SDK。
 */
import { describe, expect, it } from 'vitest'
import {
  applyToolPresentation,
  isToolDirectlyPresented,
  resolveToolPresentationMode
} from '@runtime/code-mode/presentation'
import { renderCodeModeSdkSection } from '@runtime/code-mode/sdkPrompt'
import { resolveCodeModeToolBindings } from '@runtime/code-mode/toolBindings'
import { ToolAvailability } from '@runtime/tools/availability'
import type { ToolDefinition } from '@runtime/model/types'

function defs(names: string[]): ToolDefinition[] {
  return names.map(name => ({
    name,
    description: `${name} tool`,
    parameters: { type: 'object', properties: name === 'read' ? { path: { type: 'string' }, offset: { type: 'number' } } : { pattern: { type: 'string' } }, required: name === 'read' ? ['path'] : ['pattern'] }
  }))
}

const ALL_TOOLS = defs([
  'ls',
  'read',
  'grep',
  'find',
  'code_context',
  'edit',
  'write',
  'bash',
  'run_code',
  'task'
])

describe('resolveToolPresentationMode', () => {
  it('默认 direct；NOVA_TOOL_PRESENTATION=code-readonly 开启实验；未知值回退 direct', () => {
    expect(resolveToolPresentationMode({})).toBe('direct')
    expect(resolveToolPresentationMode({ NOVA_TOOL_PRESENTATION: 'code-readonly' })).toBe('code-readonly')
    expect(resolveToolPresentationMode({ NOVA_TOOL_PRESENTATION: 'direct' })).toBe('direct')
    expect(resolveToolPresentationMode({ NOVA_TOOL_PRESENTATION: 'bogus' })).toBe('direct')
  })
})

describe('applyToolPresentation', () => {
  it('direct：run_code 不出现在模型可见面，其余不变（行为零变化）', () => {
    const result = applyToolPresentation('direct', ALL_TOOLS)
    expect(result.map(t => t.name)).toEqual([
      'ls',
      'read',
      'grep',
      'find',
      'code_context',
      'edit',
      'write',
      'bash',
      'task'
    ])
  })

  it('code-readonly：只读探索工具从直调面移除，run_code 进入', () => {
    const result = applyToolPresentation('code-readonly', ALL_TOOLS)
    expect(result.map(t => t.name)).toEqual(['edit', 'write', 'bash', 'run_code', 'task'])
  })

  it('code-readonly 不隐藏未知工具（fail open 于 catalog 之外由清洁度守卫负责）', () => {
    const result = applyToolPresentation('code-readonly', defs(['custom_tool']))
    expect(result.map(t => t.name)).toEqual(['custom_tool'])
  })

  it('direct/native 调用闸门只表达呈现形式', () => {
    expect(isToolDirectlyPresented('direct', 'run_code')).toBe(false)
    expect(isToolDirectlyPresented('direct', 'read')).toBe(true)
    expect(isToolDirectlyPresented('code-readonly', 'run_code')).toBe(true)
    expect(isToolDirectlyPresented('code-readonly', 'read')).toBe(false)
    expect(isToolDirectlyPresented('code-readonly', 'code_context')).toBe(false)
    expect(isToolDirectlyPresented('code-readonly', 'write')).toBe(true)
  })
})

describe('renderCodeModeSdkSection', () => {
  it('SDK 声明按名称排序且字节级稳定', () => {
    const a = renderCodeModeSdkSection(defs(['find', 'read', 'grep', 'ls']))
    const b = renderCodeModeSdkSection(defs(['ls', 'grep', 'find', 'read']))
    expect(a).toBe(b)
    expect(a).toContain('find(args:')
    expect(a).toContain("path: string; offset?: number")
    expect(a).toContain('Promise<{ output: string }>')
  })

  it('SDK 对非标识符参数名加引号，生成合法 TypeScript 字段', () => {
    const section = renderCodeModeSdkSection([{
      name: 'grep',
      description: 'grep tool',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string' },
          '-A': { type: 'number' }
        },
        required: ['pattern']
      }
    }])
    expect(section).toContain('pattern: string')
    expect(section).toContain('"-A"?: number')
    expect(section).not.toContain(' -A?: number')
  })

  it('economy on 时未激活组的 nestable 工具不进 SDK（投影顺序：Mode → Availability → Nesting）', () => {
    const availability = new ToolAvailability()
    availability.setEconomyMode('on')
    availability.bindRegisteredToolNames(['ls', 'read', 'grep', 'find', 'code_context', 'task'])
    // task 为 direct-only 不进 SDK；全部核心只读工具激活
    const bindings = resolveCodeModeToolBindings('default', new Set(availability.getActiveToolNames()))
    expect(bindings).toEqual(['ls', 'read', 'grep', 'find', 'code_context'])
    const section = renderCodeModeSdkSection(defs([...bindings]))
    expect(section).toContain('tools')
    expect(section).toContain('code_context(args:')
    expect(section).not.toContain('task(')
  })
})
