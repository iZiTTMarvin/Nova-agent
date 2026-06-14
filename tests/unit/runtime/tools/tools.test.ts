import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync, mkdir } from 'fs'
import { join } from 'path'
import { lsTool } from '../../../../src/runtime/tools/lsTool'
import { readTool } from '../../../../src/runtime/tools/readTool'
import { createGrepTool } from '../../../../src/runtime/tools/grepTool'
import { findTool } from '../../../../src/runtime/tools/findTool'
import { createReadState } from '../../../../src/runtime/tools/editTool'
import type { ToolContext } from '../../../../src/runtime/tools/types'

/** 创建临时测试目录 */
const TMP = join(process.cwd(), '.test-workspace-tools')

function createContext(): ToolContext {
  return { workingDir: TMP, readState: createReadState() }
}

describe('只读工具', () => {
  beforeEach(() => {
    // 创建测试目录结构:
    // TMP/
    //   hello.txt       -> "hello world"
    //   src/
    //     main.ts       -> "const x = 1"
    //     utils.ts      -> "export function add(a, b)"
    //     sub/
    //       deep.ts     -> "deep file"
    mkdirSync(TMP, { recursive: true })
    mkdirSync(join(TMP, 'src', 'sub'), { recursive: true })
    writeFileSync(join(TMP, 'hello.txt'), 'hello world\n')
    writeFileSync(join(TMP, 'src', 'main.ts'), 'const x = 1\n')
    writeFileSync(join(TMP, 'src', 'utils.ts'), 'export function add(a: number, b: number): number {\n  return a + b\n}\n')
    writeFileSync(join(TMP, 'src', 'sub', 'deep.ts'), 'deep file\n')
  })

  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true })
  })

  // ── lsTool ────────────────────────────────────────────────

  describe('lsTool', () => {
    it('列出根目录下的文件和目录', async () => {
      const result = await lsTool.execute({ path: '.' }, createContext())
      expect(result.success).toBe(true)
      expect(result.output).toContain('hello.txt')
      expect(result.output).toContain('src')
    })

    it('列出子目录内容', async () => {
      const result = await lsTool.execute({ path: 'src' }, createContext())
      expect(result.success).toBe(true)
      expect(result.output).toContain('main.ts')
      expect(result.output).toContain('utils.ts')
      expect(result.output).toContain('sub')
    })

    it('对不存在的目录返回错误', async () => {
      const result = await lsTool.execute({ path: 'no-exist' }, createContext())
      expect(result.success).toBe(false)
      expect(result.error).toBeDefined()
    })

    it('越界路径被拒绝', async () => {
      const result = await lsTool.execute({ path: '../../etc' }, createContext())
      expect(result.success).toBe(false)
      expect(result.error).toContain('越界')
    })
  })

  // ── readTool ──────────────────────────────────────────────

  describe('readTool', () => {
    it('读取文件内容', async () => {
      const result = await readTool.execute({ path: 'hello.txt' }, createContext())
      expect(result.success).toBe(true)
      expect(result.output).toContain('hello world')
    })

    it('读取子目录中的文件', async () => {
      const result = await readTool.execute({ path: 'src/main.ts' }, createContext())
      expect(result.success).toBe(true)
      expect(result.output).toContain('const x = 1')
    })

    it('对不存在的文件返回错误', async () => {
      const result = await readTool.execute({ path: 'missing.txt' }, createContext())
      expect(result.success).toBe(false)
    })

    it('越界路径被拒绝', async () => {
      const result = await readTool.execute({ path: '../../../etc/passwd' }, createContext())
      expect(result.success).toBe(false)
      expect(result.error).toContain('越界')
    })
  })

  // ── grepTool ──────────────────────────────────────────────

  describe('grepTool', () => {
    const grepTool = createGrepTool()

    it('搜索到匹配的内容', async () => {
      const result = await grepTool.execute({ pattern: 'function', path: 'src' }, createContext())
      expect(result.success).toBe(true)
      expect(result.output).toContain('utils.ts')
      expect(result.output).toContain('function add')
    })

    it('无匹配时输出空结果提示', async () => {
      const result = await grepTool.execute({ pattern: 'NOTEXIST_12345' }, createContext())
      expect(result.success).toBe(true)
      expect(result.output).toContain('未找到匹配')
    })

    it('越界路径被拒绝', async () => {
      const result = await grepTool.execute({ pattern: 'x', path: '../../etc' }, createContext())
      expect(result.success).toBe(false)
      expect(result.error).toContain('越界')
    })

    it('缺少 pattern 返回错误', async () => {
      const result = await grepTool.execute({}, createContext())
      expect(result.success).toBe(false)
      expect(result.error).toContain('pattern')
    })

    it('output_mode: "files_with_matches" 仅返回文件路径', async () => {
      const result = await grepTool.execute(
        { pattern: 'function', path: 'src', output_mode: 'files_with_matches' },
        createContext()
      )
      expect(result.success).toBe(true)
      expect(result.output).toContain('utils.ts')
      expect(result.output).not.toContain('function add')
    })

    it('output_mode: "count" 返回文件和计数', async () => {
      const result = await grepTool.execute(
        { pattern: 'function', path: 'src', output_mode: 'count' },
        createContext()
      )
      expect(result.success).toBe(true)
      expect(result.output).toContain('utils.ts')
      expect(result.output).toMatch(/utils\.ts: \d+/)
    })

    it('head_limit 限制返回条数', async () => {
      const result = await grepTool.execute(
        { pattern: '.', path: 'src', head_limit: 2 },
        createContext()
      )
      expect(result.success).toBe(true)
      const lines = result.output.split('\n').filter(l => l.length > 0)
      expect(lines.length).toBeLessThanOrEqual(2)
    })
  })

  // ── findTool ──────────────────────────────────────────────

  describe('findTool', () => {
    it('按 glob 模式查找文件', async () => {
      const result = await findTool.execute({ pattern: '**/*.ts' }, createContext())
      expect(result.success).toBe(true)
      expect(result.output).toContain('main.ts')
      expect(result.output).toContain('utils.ts')
      expect(result.output).toContain('deep.ts')
    })

    it('限定搜索目录', async () => {
      const result = await findTool.execute({ pattern: '**/*.ts', path: 'src' }, createContext())
      expect(result.success).toBe(true)
      expect(result.output).toContain('main.ts')
      expect(result.output).toContain('deep.ts')
    })

    it('非递归模式只匹配当前层级', async () => {
      const result = await findTool.execute({ pattern: '*.ts', path: 'src' }, createContext())
      expect(result.success).toBe(true)
      expect(result.output).toContain('main.ts')
      expect(result.output).toContain('utils.ts')
      expect(result.output).not.toContain('deep.ts')
    })

    it('越界路径被拒绝', async () => {
      const result = await findTool.execute({ pattern: '*', path: '../../etc' }, createContext())
      expect(result.success).toBe(false)
      expect(result.error).toContain('越界')
    })
  })
})
