import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { editTool, createReadState } from '../../../../src/runtime/tools/editTool'
import { writeTool } from '../../../../src/runtime/tools/writeTool'
import { readTool } from '../../../../src/runtime/tools/readTool'
import { CheckpointManager } from '../../../../src/runtime/checkpoints/CheckpointManager'
import type { ToolContext } from '../../../../src/runtime/tools/types'

const TMP = join(process.cwd(), '.test-writetools-workspace')
const CHECKPOINT_ROOT = join(process.cwd(), '.test-writetools-checkpoints')
const SESSION_ID = 'test-session'
const MESSAGE_ID = 'msg-001'

/** 测试用 readState：beforeEach 中重建，确保测试间互不影响（与 I1 行为对齐） */
let testReadState = createReadState()

function createContext(
  withCheckpoint = false
): ToolContext & { checkpointManager?: CheckpointManager } {
  const ctx: ToolContext = { workingDir: TMP, readState: testReadState }
  if (withCheckpoint) {
    const mgr = new CheckpointManager({
      checkpointDir: CHECKPOINT_ROOT,
      sessionId: SESSION_ID,
      workspaceRoot: TMP
    })
    mgr.beginMessage(MESSAGE_ID)
    ctx.checkpointManager = mgr
  }
  return ctx
}

describe('写入工具', () => {
  beforeEach(() => {
    mkdirSync(TMP, { recursive: true })
    writeFileSync(join(TMP, 'hello.txt'), 'hello world\n')
    mkdirSync(join(TMP, 'src'), { recursive: true })
    writeFileSync(join(TMP, 'src', 'main.ts'), 'const x = 1\nexport { x }\n')
    rmSync(CHECKPOINT_ROOT, { recursive: true, force: true })
    testReadState = createReadState()
  })

  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true })
    rmSync(CHECKPOINT_ROOT, { recursive: true, force: true })
  })

  // ── editTool ──────────────────────────────────────────────

  describe('editTool', () => {
    it('精确替换文件中的指定内容', async () => {
      const ctx = createContext()
      await readTool.execute({ path: 'hello.txt' }, ctx)
      const result = await editTool.execute(
        { path: 'hello.txt', old: 'world', new: 'Nova' },
        ctx
      )
      expect(result.success).toBe(true)
      expect(readFileSync(join(TMP, 'hello.txt'), 'utf-8')).toBe('hello Nova\n')
    })

    it('替换多行文本', async () => {
      const ctx = createContext()
      await readTool.execute({ path: 'src/main.ts' }, ctx)
      const result = await editTool.execute(
        { path: 'src/main.ts', old: 'const x = 1', new: 'const x = 42' },
        ctx
      )
      expect(result.success).toBe(true)
      const content = readFileSync(join(TMP, 'src', 'main.ts'), 'utf-8')
      expect(content).toContain('const x = 42')
    })

    it('old 文本不存在时返回错误', async () => {
      const ctx = createContext()
      await readTool.execute({ path: 'hello.txt' }, ctx)
      const result = await editTool.execute(
        { path: 'hello.txt', old: 'NOTEXIST', new: 'foo' },
        ctx
      )
      expect(result.success).toBe(false)
      expect(result.error).toContain('not found')
    })

    it('old 文本出现多次时返回错误（防止歧义）', async () => {
      writeFileSync(join(TMP, 'dup.txt'), 'aaa\nbbb\naaa\n')
      const ctx = createContext()
      await readTool.execute({ path: 'dup.txt' }, ctx)

      const result = await editTool.execute(
        { path: 'dup.txt', old: 'aaa', new: 'ccc' },
        ctx
      )
      expect(result.success).toBe(false)
      expect(result.error).toContain('2 times')
    })

    it('缺少参数时返回错误', async () => {
      const r1 = await editTool.execute({ path: 'a.txt' }, createContext())
      expect(r1.success).toBe(false)

      const r2 = await editTool.execute({}, createContext())
      expect(r2.success).toBe(false)
    })

    it('越界路径被拒绝', async () => {
      const result = await editTool.execute(
        { path: '../../etc/passwd', old: 'x', new: 'y' },
        createContext()
      )
      expect(result.success).toBe(false)
      expect(result.error).toContain('越界')
    })

    it('配合 checkpoint 时备份原始内容', async () => {
      const ctx = createContext(true)
      await readTool.execute({ path: 'hello.txt' }, ctx)

      const result = await editTool.execute(
        { path: 'hello.txt', old: 'world', new: 'Nova' },
        ctx
      )
      expect(result.success).toBe(true)

      // 验证备份内容是原始值
      const backupPath = join(
        CHECKPOINT_ROOT, SESSION_ID, MESSAGE_ID, 'files', 'hello.txt'
      )
      expect(existsSync(backupPath)).toBe(true)
      expect(readFileSync(backupPath, 'utf-8')).toBe('hello world\n')
    })
  })

  // ── writeTool ─────────────────────────────────────────────

  describe('writeTool', () => {
    it('创建新文件', async () => {
      const result = await writeTool.execute(
        { path: 'new-file.ts', content: 'export const a = 1\n' },
        createContext()
      )
      expect(result.success).toBe(true)
      expect(result.output).toContain('创建新文件')
      expect(readFileSync(join(TMP, 'new-file.ts'), 'utf-8')).toBe('export const a = 1\n')
    })

    it('覆盖已有文件', async () => {
      const result = await writeTool.execute(
        { path: 'hello.txt', content: 'replaced content' },
        createContext()
      )
      expect(result.success).toBe(true)
      expect(result.output).toContain('覆盖')
      expect(readFileSync(join(TMP, 'hello.txt'), 'utf-8')).toBe('replaced content')
    })

    it('在子目录中创建新文件（自动创建目录）', async () => {
      const result = await writeTool.execute(
        { path: 'src/lib/utils.ts', content: 'export function noop() {}\n' },
        createContext()
      )
      expect(result.success).toBe(true)
      expect(existsSync(join(TMP, 'src', 'lib', 'utils.ts'))).toBe(true)
    })

    it('缺少参数时返回错误', async () => {
      const r1 = await writeTool.execute({ path: 'a.txt' }, createContext())
      expect(r1.success).toBe(false)

      const r2 = await writeTool.execute({}, createContext())
      expect(r2.success).toBe(false)
    })

    it('越界路径被拒绝', async () => {
      const result = await writeTool.execute(
        { path: '../../etc/hack', content: 'bad' },
        createContext()
      )
      expect(result.success).toBe(false)
      expect(result.error).toContain('越界')
    })

    it('新建文件时 checkpoint 记录到 createdFiles', async () => {
      const ctx = createContext(true)

      const result = await writeTool.execute(
        { path: 'created.ts', content: 'new\n' },
        ctx
      )
      expect(result.success).toBe(true)

      // 新建文件不应有备份文件
      const backupPath = join(
        CHECKPOINT_ROOT, SESSION_ID, MESSAGE_ID, 'files', 'created.ts'
      )
      expect(existsSync(backupPath)).toBe(false)
    })

    it('覆盖已有文件时 checkpoint 备份原始内容', async () => {
      const ctx = createContext(true)

      await writeTool.execute(
        { path: 'hello.txt', content: 'new content\n' },
        ctx
      )

      const backupPath = join(
        CHECKPOINT_ROOT, SESSION_ID, MESSAGE_ID, 'files', 'hello.txt'
      )
      expect(existsSync(backupPath)).toBe(true)
      expect(readFileSync(backupPath, 'utf-8')).toBe('hello world\n')
    })

    it('写入空内容是合法的', async () => {
      const result = await writeTool.execute(
        { path: 'empty.txt', content: '' },
        createContext()
      )
      expect(result.success).toBe(true)
      expect(readFileSync(join(TMP, 'empty.txt'), 'utf-8')).toBe('')
    })

    it('execution generation 失效时拒绝写入', async () => {
      const ctx = createContext()
      ctx.assertExecutionCurrent = () => false
      const result = await writeTool.execute(
        { path: 'hello.txt', content: 'should-not-write\n' },
        ctx
      )
      expect(result.success).toBe(false)
      expect(result.error).toMatch(/generation 已失效/)
      expect(readFileSync(join(TMP, 'hello.txt'), 'utf-8')).toBe('hello world\n')
    })
  })
})
