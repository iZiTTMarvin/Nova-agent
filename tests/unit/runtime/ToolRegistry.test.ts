import { describe, it, expect } from 'vitest'
import { ToolRegistry } from '../../../src/runtime/tools/ToolRegistry'
import type { ToolExecutor, ToolContext, ToolResult } from '../../../src/runtime/tools/types'

/** 创建一个简单的测试工具 */
function makeTool(name: string, output: string): ToolExecutor {
  return {
    name,
    description: `测试工具: ${name}`,
    parameters: {
      type: 'object',
      properties: {
        input: { type: 'string', description: '输入' }
      }
    },
    async execute(args): Promise<ToolResult> {
      return { success: true, output: `${output}: ${args.input ?? ''}` }
    }
  }
}

/** 创建一个会越界检查的上下文 */
const createContext = (workingDir: string): ToolContext => ({ workingDir })

describe('ToolRegistry', () => {
  it('注册工具后可通过名称获取', () => {
    const registry = new ToolRegistry()
    const tool = makeTool('test_tool', 'ok')
    registry.register(tool)

    expect(registry.getTool('test_tool')).toBe(tool)
  })

  it('getTool 对不存在的工具返回 undefined', () => {
    const registry = new ToolRegistry()
    expect(registry.getTool('no_such_tool')).toBeUndefined()
  })

  it('getToolDefinitions 返回所有注册工具的 schema', () => {
    const registry = new ToolRegistry()
    registry.register(makeTool('tool_a', 'a'))
    registry.register(makeTool('tool_b', 'b'))

    const defs = registry.getToolDefinitions()
    expect(defs).toHaveLength(2)
    expect(defs.map(d => d.name)).toContain('tool_a')
    expect(defs.map(d => d.name)).toContain('tool_b')
    // 每个 definition 必须有 name、description、parameters
    for (const d of defs) {
      expect(d).toHaveProperty('name')
      expect(d).toHaveProperty('description')
      expect(d).toHaveProperty('parameters')
    }
  })

  it('execute 调用对应工具并返回结果', async () => {
    const registry = new ToolRegistry()
    registry.register(makeTool('echo', 'ECHO'))

    const ctx = createContext('/project')
    const result = await registry.execute('echo', { input: 'hello' }, ctx)

    expect(result.success).toBe(true)
    expect(result.output).toBe('ECHO: hello')
  })

  it('execute 对不存在的工具返回错误', async () => {
    const registry = new ToolRegistry()
    const ctx = createContext('/project')

    const result = await registry.execute('missing', {}, ctx)
    expect(result.success).toBe(false)
    expect(result.error).toContain('未注册')
  })

  it('resolvePath 将相对路径解析为绝对路径', () => {
    const registry = new ToolRegistry()
    const resolved = registry.resolvePath('/project', 'src/main.ts')
    // 在 Windows 上返回反斜杠格式
    expect(resolved).toMatch(/[/\\]project[/\\]src[/\\]main\.ts$/)
  })

  it('isWithinWorkspace 正确判断路径是否在工作区内', () => {
    const registry = new ToolRegistry()

    expect(registry.isWithinWorkspace('/project', '/project/src/main.ts')).toBe(true)
    expect(registry.isWithinWorkspace('/project', '/project/sub/deep/file.ts')).toBe(true)
    expect(registry.isWithinWorkspace('/project', '/other/file.ts')).toBe(false)
    expect(registry.isWithinWorkspace('/project', '../etc/passwd')).toBe(false)
  })

  it('resolveAndValidate 成功时返回绝对路径', () => {
    const registry = new ToolRegistry()
    const result = registry.resolveAndValidate('/project', 'src/main.ts')

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.path).toMatch(/[/\\]project[/\\]src[/\\]main\.ts$/)
    }
  })

  it('resolveAndValidate 越界时返回错误', () => {
    const registry = new ToolRegistry()
    const result = registry.resolveAndValidate('/project', '../../etc/passwd')

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('越界')
    }
  })
})
