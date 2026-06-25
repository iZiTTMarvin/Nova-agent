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

    // ── T5.2 边界：ls 是单层列目录，不递归，所以 target/ 目录条目本身应显示 ──
    // （与 find 的递归排除语义不同：find 进入 target/ 内部才排除，ls 只列一层）
    it('单层列出时照常显示构建产物目录条目本身', async () => {
      mkdirSync(join(TMP, 'target'), { recursive: true })
      writeFileSync(join(TMP, 'target', 'a.class'), 'x\n')
      const result = await lsTool.execute({ path: '.' }, createContext())
      expect(result.success).toBe(true)
      // target/ 作为目录条目要显示（让模型知道它存在）
      expect(result.output).toContain('target/')
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
      // 输出以 [workspace: ...] 标头开头（session context 双保险），统计时排除标头行
      const lines = result.output.split('\n').filter(l => l.length > 0 && !l.startsWith('[workspace:'))
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

    // ── T5 新增：构建产物排除（本次卡死根因的回归保护） ────────

    describe('构建产物目录排除', () => {
      // 在 TMP 下额外构造 target/ build/ node_modules/ 目录树，
      // 验证 find 递归时不会进入这些目录（卡死根因：target/ 内数千 .class）。
      beforeEach(() => {
        mkdirSync(join(TMP, 'target', 'classes', 'com', 'example'), { recursive: true })
        mkdirSync(join(TMP, 'build', 'obj'), { recursive: true })
        mkdirSync(join(TMP, 'node_modules', 'some-pkg'), { recursive: true })
        // 真实源码
        writeFileSync(join(TMP, 'target', 'classes', 'com', 'example', 'Main.class'), 'fake bytecode\n')
        writeFileSync(join(TMP, 'build', 'obj', 'x.obj'), 'obj\n')
        writeFileSync(join(TMP, 'node_modules', 'some-pkg', 'index.js'), 'module.exports = 1\n')
        // 用户真实源码（应被找到）
        writeFileSync(join(TMP, 'src', 'real.ts'), 'real source\n')
      })

      it('不遍历 target/ 目录（Java/Maven 卡死根因）', async () => {
        const result = await findTool.execute({ pattern: '**/*' }, createContext())
        expect(result.success).toBe(true)
        expect(result.output).toContain('real.ts')
        // target 内的 .class 绝不能出现在结果里
        expect(result.output).not.toContain('Main.class')
        expect(result.output).not.toContain('target')
      })

      it('不遍历 build/ 目录', async () => {
        const result = await findTool.execute({ pattern: '**/*' }, createContext())
        expect(result.output).not.toContain('x.obj')
        expect(result.output).not.toContain('build')
      })

      it('不遍历 node_modules/ 目录', async () => {
        const result = await findTool.execute({ pattern: '**/*.js' }, createContext())
        expect(result.output).not.toContain('some-pkg')
        expect(result.output).not.toContain('node_modules')
      })

      it('按扩展名查找时构建产物不污染结果', async () => {
        const result = await findTool.execute({ pattern: '**/*.ts' }, createContext())
        expect(result.output).toContain('real.ts')
        expect(result.output).not.toContain('.class')
        expect(result.output).not.toContain('.obj')
      })
    })

    // ── T5 新增：abortSignal 中断递归 ────────────────────────

    describe('取消信号', () => {
      it('abortSignal 触发时中断递归并返回取消提示', async () => {
        const ac = new AbortController()
        const ctx = createContext()
        ctx.abortSignal = ac.signal
        // 遍历开始前立即取消（模拟用户在 find 启动瞬间点取消）
        ac.abort()
        const result = await findTool.execute({ pattern: '**/*.ts' }, ctx)
        expect(result.success).toBe(true)
        expect(result.output).toContain('操作已取消')
      })
    })

    // ── T5 新增：gitignore 生效 ──────────────────────────────

    describe('gitignore 过滤', () => {
      it('尊重工作区 .gitignore 规则', async () => {
        writeFileSync(join(TMP, '.gitignore'), '*.log\n')
        writeFileSync(join(TMP, 'app.log'), 'log\n')
        writeFileSync(join(TMP, 'keep.txt'), 'keep\n')

        const result = await findTool.execute({ pattern: '*' }, createContext())
        expect(result.output).toContain('keep.txt')
        expect(result.output).not.toContain('app.log')
      })
    })
  })
})
