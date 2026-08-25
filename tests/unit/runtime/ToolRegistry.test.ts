import { describe, it, expect, afterEach } from 'vitest'
import { join } from 'path'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { ToolRegistry, resolveAndValidatePath } from '../../../src/runtime/tools/ToolRegistry'
import type { ToolExecutor, ToolResult } from '../../../src/runtime/tools/types'
import {
  clearSessionPathGrants,
  replaceSkillPathGrants
} from '../../../src/runtime/permissions/pathAccess'

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

describe('resolveToolNameCaseInsensitive', () => {
  it('大小写唯一命中时返回正确名字', () => {
    const registry = new ToolRegistry()
    registry.register(makeTool('bash', 'ok'))

    expect(registry.resolveToolNameCaseInsensitive('Bash')).toEqual({ kind: 'unique', name: 'bash' })
    expect(registry.resolveToolNameCaseInsensitive('BASH')).toEqual({ kind: 'unique', name: 'bash' })
  })

  it('多个仅大小写不同的候选时返回 ambiguous 与候选列表', () => {
    const registry = new ToolRegistry()
    registry.register(makeTool('read', 'a'))
    registry.register(makeTool('Read', 'b'))

    const result = registry.resolveToolNameCaseInsensitive('READ')
    expect(result.kind).toBe('ambiguous')
    if (result.kind === 'ambiguous') {
      expect([...result.candidates].sort()).toEqual(['Read', 'read'])
    }
  })

  it('完全不存在的名字返回 miss', () => {
    const registry = new ToolRegistry()
    registry.register(makeTool('bash', 'ok'))

    expect(registry.resolveToolNameCaseInsensitive('no_such_tool')).toEqual({ kind: 'miss' })
  })
})

describe('resolveAndValidatePath 会话路径授权', () => {
  const sessionId = 'tool-registry-skill-session'
  let workDir = ''
  let skillRoot = ''
  let otherRoot = ''

  function setupRoots(): void {
    workDir = mkdtempSync(join(tmpdir(), 'nova-reg-ws-'))
    skillRoot = mkdtempSync(join(tmpdir(), 'nova-reg-skill-'))
    otherRoot = mkdtempSync(join(tmpdir(), 'nova-reg-other-'))
    mkdirSync(join(skillRoot, 'references'), { recursive: true })
    writeFileSync(join(skillRoot, 'references', 'rule.md'), 'skill\n')
    writeFileSync(join(otherRoot, 'a.md'), 'other\n')
  }

  afterEach(() => {
    clearSessionPathGrants(sessionId)
    for (const dir of [workDir, skillRoot, otherRoot]) {
      if (dir) rmSync(dir, { recursive: true, force: true })
    }
  })

  it('未登记 grant 时工作区外仍拒绝', () => {
    setupRoots()
    const result = resolveAndValidatePath(workDir, skillRoot)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('越界')
  })

  it('登记 skill grant 后根内绝对路径放行', () => {
    setupRoots()
    replaceSkillPathGrants(sessionId, [skillRoot])
    const target = join(skillRoot, 'references', 'rule.md')
    const result = resolveAndValidatePath(workDir, target, { sessionId, access: 'read' })
    expect(result.ok).toBe(true)
  })

  it('登记 skill grant 后根外仍拒绝', () => {
    setupRoots()
    replaceSkillPathGrants(sessionId, [skillRoot])
    const outside = join(otherRoot, 'secret.md')
    writeFileSync(outside, 'nope\n')
    const result = resolveAndValidatePath(workDir, outside, { sessionId, access: 'read' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('越界')
  })

  it('相对路径永远基于 workingDir，不会解析到 skill 根下', () => {
    setupRoots()
    replaceSkillPathGrants(sessionId, [skillRoot])
    const result = resolveAndValidatePath(workDir, 'references/rule.md', { sessionId, access: 'read' })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.path.toLowerCase()).toContain('nova-reg-ws-')
      expect(result.path.toLowerCase()).not.toContain('nova-reg-skill-')
    }
  })

  it('穿越出 skill 根仍拒绝', () => {
    setupRoots()
    replaceSkillPathGrants(sessionId, [skillRoot])
    const traversal = join(skillRoot, '..', 'secret.txt')
    const result = resolveAndValidatePath(workDir, traversal, { sessionId, access: 'read' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('越界')
  })

  it('工作区内路径不依赖 grant 仍放行', () => {
    setupRoots()
    const result = resolveAndValidatePath(workDir, 'src/main.ts')
    expect(result.ok).toBe(true)
  })

  it('多个 skill 根：命中任一即可', () => {
    setupRoots()
    replaceSkillPathGrants(sessionId, [skillRoot, otherRoot])
    const target = join(otherRoot, 'a.md')
    const result = resolveAndValidatePath(workDir, target, { sessionId, access: 'read' })
    expect(result.ok).toBe(true)
  })

  it('skill 只读 grant 不能用于写入', () => {
    setupRoots()
    replaceSkillPathGrants(sessionId, [skillRoot])
    const target = join(skillRoot, 'references', 'rule.md')
    const result = resolveAndValidatePath(workDir, target, { sessionId, access: 'write' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('越界')
  })
})

/**
 * Windows 跨盘符：path.relative 返回绝对路径，旧实现会误判为「在根内」。
 */
describe.runIf(process.platform === 'win32')('resolveAndValidatePath 跨盘符边界（Windows）', () => {
  const workDir = 'D:\\workspace\\project'
  const skillFile = 'C:\\Users\\x\\.nova\\skills\\ref-test\\references\\rule.md'
  const unrelated = 'C:\\nova-unrelated-outside\\secret.md'

  it('未登记 grant 时跨盘符绝对路径必须拒绝', () => {
    const result = resolveAndValidatePath(workDir, unrelated)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('越界')
  })

  it('未登记时跨盘符 skill 路径仍拒绝', () => {
    const result = resolveAndValidatePath(workDir, skillFile)
    expect(result.ok).toBe(false)
  })

  it('isWithinWorkspace 跨盘符也拒绝', () => {
    const registry = new ToolRegistry()
    expect(registry.isWithinWorkspace(workDir, unrelated)).toBe(false)
    expect(registry.isWithinWorkspace(workDir, skillFile)).toBe(false)
    expect(registry.isWithinWorkspace(workDir, 'src\\main.ts')).toBe(true)
  })
})
