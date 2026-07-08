import { describe, it, expect } from 'vitest'
import { resolve, join } from 'path'
import { ToolRegistry, resolveAndValidatePath } from '../../../src/runtime/tools/ToolRegistry'
import type { ToolExecutor, ToolContext, ToolResult } from '../../../src/runtime/tools/types'
import { createReadState } from '../../../src/runtime/tools/editTool'

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
const createContext = (workingDir: string): ToolContext => ({
  workingDir,
  readState: createReadState()
})

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

describe('resolveAndValidatePath 多根校验', () => {
  const workDir = resolve('/workspace/project')
  const skillRoot = resolve('/home/user/.nova/skills/ref-test')
  const otherRoot = resolve('/tmp/other-skill')

  it('不传 extraRoots：越界仍拒绝（回归）', () => {
    const result = resolveAndValidatePath(workDir, skillRoot)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('越界')
    }
  })

  it('传 extraRoots：根内绝对路径放行', () => {
    const target = join(skillRoot, 'references', 'rule.md')
    const result = resolveAndValidatePath(workDir, target, [skillRoot])
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.path).toBe(resolve(workDir, target))
    }
  })

  it('传 extraRoots：根外仍拒绝', () => {
    const outside = join(otherRoot, 'secret.md')
    const result = resolveAndValidatePath(workDir, outside, [skillRoot])
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('越界')
    }
  })

  it('相对路径永远基于 workingDir，不会解析到 extraRoots 下', () => {
    // 相对路径 "references/rule.md" 应落到 workDir 下，而非 skillRoot
    const result = resolveAndValidatePath(workDir, 'references/rule.md', [skillRoot])
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.path).toBe(join(workDir, 'references', 'rule.md'))
      expect(result.path).not.toContain('.nova')
    }
  })

  it('.. 穿越攻击：<root>/../secret 拒绝', () => {
    // 绝对路径指向 skill 根的父级（穿越出额外根）
    const traversal = join(skillRoot, '..', 'secret.txt')
    const result = resolveAndValidatePath(workDir, traversal, [skillRoot])
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('越界')
    }
  })

  it('工作区内路径不依赖 extraRoots 仍放行', () => {
    const result = resolveAndValidatePath(workDir, 'src/main.ts')
    expect(result.ok).toBe(true)
  })

  it('多个 extraRoots：命中任一即可', () => {
    const target = join(otherRoot, 'a.md')
    const result = resolveAndValidatePath(workDir, target, [skillRoot, otherRoot])
    expect(result.ok).toBe(true)
  })
})

/**
 * Windows 跨盘符：path.relative 返回绝对路径，旧实现会误判为「在根内」。
 * 非 Windows 无盘符概念，本段仅在 win32 上跑真实 resolveAndValidatePath。
 */
describe.runIf(process.platform === 'win32')('resolveAndValidatePath 跨盘符边界（Windows）', () => {
  const workDir = 'D:\\workspace\\project'
  const skillRoot = 'C:\\Users\\x\\.nova\\skills\\ref-test'
  const skillFile = 'C:\\Users\\x\\.nova\\skills\\ref-test\\references\\rule.md'
  const unrelated = 'C:\\Windows\\system32\\config\\SAM'

  it('未注册 extraRoots：跨盘符绝对路径必须拒绝', () => {
    const result = resolveAndValidatePath(workDir, unrelated)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('越界')
  })

  it('未注册时，跨盘符 skill 路径仍拒绝（边界未松动）', () => {
    const result = resolveAndValidatePath(workDir, skillFile)
    expect(result.ok).toBe(false)
  })

  it('注册跨盘符 skillRoot 后，仅根内文件放行', () => {
    expect(resolveAndValidatePath(workDir, skillFile, [skillRoot]).ok).toBe(true)
    expect(resolveAndValidatePath(workDir, unrelated, [skillRoot]).ok).toBe(false)
  })

  it('兄弟目录穿越仍拒绝（同盘符 / 跨盘符共同语义）', () => {
    const sibling = 'C:\\Users\\x\\.nova\\skills\\other-skill\\secret.md'
    expect(resolveAndValidatePath(workDir, sibling, [skillRoot]).ok).toBe(false)
  })

  it('isWithinWorkspace 跨盘符也拒绝', () => {
    const registry = new ToolRegistry()
    expect(registry.isWithinWorkspace(workDir, unrelated)).toBe(false)
    expect(registry.isWithinWorkspace(workDir, skillFile)).toBe(false)
    expect(registry.isWithinWorkspace(workDir, 'src\\main.ts')).toBe(true)
  })
})
