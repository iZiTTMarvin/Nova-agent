import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, readFileSync, rmSync, statSync, utimesSync } from 'fs'
import { join } from 'path'
import { editTool, createReadState } from '../../../../src/runtime/tools/editTool'
import { readTool } from '../../../../src/runtime/tools/readTool'
import { writeTool } from '../../../../src/runtime/tools/writeTool'
import { encodeFile } from '../../../../src/runtime/tools/editDiff'
import type { ToolContext } from '../../../../src/runtime/tools/types'

const TMP = join(process.cwd(), '.test-workspace-edit')

/**
 * 测试用 readState：单文件作用域，beforeEach 中重建。
 * 同一个 it 内多次 createContext 共享同一份 readState，使得
 * 「先 read 后 edit」的链路能在测试里跑通（与生产环境同一 AgentLoop 实例
 * 跨工具调用共享 readState 的行为对齐）。
 */
let testReadState = createReadState()

function createContext(overrides?: Partial<ToolContext>): ToolContext {
  return { workingDir: TMP, readState: testReadState, ...overrides }
}

describe('editTool 集成测试', () => {
  beforeEach(() => {
    mkdirSync(TMP, { recursive: true })
    testReadState = createReadState()
  })

  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true })
  })

  it('基本单点替换（新格式 edits[]）', async () => {
    writeFileSync(join(TMP, 'a.ts'), 'const x = 1\nconst y = 2\n')
    await readTool.execute({ path: 'a.ts' }, createContext())

    const result = await editTool.execute(
      { filePath: 'a.ts', edits: [{ oldText: 'const x = 1', newText: 'const x = 10' }] },
      createContext()
    )
    expect(result.success).toBe(true)
    expect(readFileSync(join(TMP, 'a.ts'), 'utf-8')).toContain('const x = 10')
  })

  it('多点替换同时生效', async () => {
    writeFileSync(join(TMP, 'b.ts'), 'aaa\nbbb\nccc\n')
    await readTool.execute({ path: 'b.ts' }, createContext())

    const result = await editTool.execute(
      {
        filePath: 'b.ts',
        edits: [
          { oldText: 'aaa', newText: 'AAA' },
          { oldText: 'ccc', newText: 'CCC' },
        ],
      },
      createContext()
    )
    expect(result.success).toBe(true)
    const content = readFileSync(join(TMP, 'b.ts'), 'utf-8')
    expect(content).toContain('AAA')
    expect(content).toContain('CCC')
    expect(content).toContain('bbb')
  })

  it('旧格式 { path, old, new } 向后兼容', async () => {
    writeFileSync(join(TMP, 'c.ts'), 'hello world\n')
    await readTool.execute({ path: 'c.ts' }, createContext())

    const result = await editTool.execute(
      { path: 'c.ts', old: 'hello', new: 'goodbye' },
      createContext()
    )
    expect(result.success).toBe(true)
    expect(readFileSync(join(TMP, 'c.ts'), 'utf-8')).toContain('goodbye world')
  })

  it('未读文件被拒绝', async () => {
    writeFileSync(join(TMP, 'd.ts'), 'content\n')

    const result = await editTool.execute(
      { filePath: 'd.ts', edits: [{ oldText: 'content', newText: 'new' }] },
      createContext()
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain('not been read')
  })

  it('oldText 未找到时返回错误', async () => {
    writeFileSync(join(TMP, 'e.ts'), 'real content\n')
    await readTool.execute({ path: 'e.ts' }, createContext())

    const result = await editTool.execute(
      { filePath: 'e.ts', edits: [{ oldText: 'not here', newText: 'x' }] },
      createContext()
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain('not found')
  })

  it('oldText 出现多次时返回错误', async () => {
    writeFileSync(join(TMP, 'f.ts'), 'dup\ndup\nother\n')
    await readTool.execute({ path: 'f.ts' }, createContext())

    const result = await editTool.execute(
      { filePath: 'f.ts', edits: [{ oldText: 'dup', newText: 'x' }] },
      createContext()
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain('appears 2 times')
  })

  it('路径越界被拒绝', async () => {
    const result = await editTool.execute(
      { filePath: '../../etc/passwd', edits: [{ oldText: 'a', newText: 'b' }] },
      createContext()
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain('越界')
  })

  it('CRLF 文件编辑后保持 CRLF', async () => {
    writeFileSync(join(TMP, 'crlf.ts'), 'line1\r\nline2\r\nline3\r\n')
    await readTool.execute({ path: 'crlf.ts' }, createContext())

    const result = await editTool.execute(
      { filePath: 'crlf.ts', edits: [{ oldText: 'line2', newText: 'LINE2' }] },
      createContext()
    )
    expect(result.success).toBe(true)
    const content = readFileSync(join(TMP, 'crlf.ts'))
    expect(content.toString()).toContain('\r\n')
    expect(content.toString()).toContain('LINE2')
  })

  it('AbortSignal 中断编辑', async () => {
    writeFileSync(join(TMP, 'abort.ts'), 'content\n')
    await readTool.execute({ path: 'abort.ts' }, createContext())

    const controller = new AbortController()
    controller.abort()

    const result = await editTool.execute(
      { filePath: 'abort.ts', edits: [{ oldText: 'content', newText: 'new' }] },
      createContext({ abortSignal: controller.signal })
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain('aborted')
  })

  it('edits 为 JSON 字符串时自动解析', async () => {
    writeFileSync(join(TMP, 'json.ts'), 'foo bar\n')
    await readTool.execute({ path: 'json.ts' }, createContext())

    const result = await editTool.execute(
      {
        filePath: 'json.ts',
        edits: JSON.stringify([{ oldText: 'foo', newText: 'baz' }]),
      },
      createContext()
    )
    expect(result.success).toBe(true)
    expect(readFileSync(join(TMP, 'json.ts'), 'utf-8')).toContain('baz bar')
  })

  it('弯引号容错匹配', async () => {
    writeFileSync(join(TMP, 'quote.ts'), 'const s = \u201Chello\u201D\n')
    await readTool.execute({ path: 'quote.ts' }, createContext())

    const result = await editTool.execute(
      {
        filePath: 'quote.ts',
        edits: [{ oldText: 'const s = "hello"', newText: 'const s = "world"' }],
      },
      createContext()
    )
    expect(result.success).toBe(true)
    const content = readFileSync(join(TMP, 'quote.ts'), 'utf-8')
    expect(content).toContain('\u201Cworld\u201D')
  })

  it('所有 oldText 匹配原始文件（非增量）', async () => {
    writeFileSync(join(TMP, 'noninc.ts'), 'aaa\nbbb\nccc\n')
    await readTool.execute({ path: 'noninc.ts' }, createContext())

    const result = await editTool.execute(
      {
        filePath: 'noninc.ts',
        edits: [
          { oldText: 'aaa', newText: 'AAA' },
          { oldText: 'bbb', newText: 'BBB' },
        ],
      },
      createContext()
    )
    expect(result.success).toBe(true)
    const content = readFileSync(join(TMP, 'noninc.ts'), 'utf-8')
    expect(content).toBe('AAA\nBBB\nccc\n')
  })

  it('UTF-16LE 文件编辑后保持 UTF-16LE 编码', async () => {
    const utf16Buf = encodeFile('hello world\n', 'utf-16le')
    writeFileSync(join(TMP, 'utf16.txt'), utf16Buf)
    await readTool.execute({ path: 'utf16.txt' }, createContext())

    const result = await editTool.execute(
      { filePath: 'utf16.txt', edits: [{ oldText: 'hello', newText: 'goodbye' }] },
      createContext()
    )
    expect(result.success).toBe(true)

    const afterBuf = readFileSync(join(TMP, 'utf16.txt'))
    expect(afterBuf[0]).toBe(0xFF)
    expect(afterBuf[1]).toBe(0xFE)
    const text = afterBuf.subarray(2).toString('utf16le')
    expect(text).toContain('goodbye world')
  })

  it('UTF-8 BOM 文件编辑后不产生双 BOM', async () => {
    const bomBuf = encodeFile('hello world\n', 'utf-8-bom')
    writeFileSync(join(TMP, 'bom.txt'), bomBuf)
    await readTool.execute({ path: 'bom.txt' }, createContext())

    const result = await editTool.execute(
      { filePath: 'bom.txt', edits: [{ oldText: 'hello', newText: 'goodbye' }] },
      createContext()
    )
    expect(result.success).toBe(true)

    const afterBuf = readFileSync(join(TMP, 'bom.txt'))
    expect(afterBuf[0]).toBe(0xEF)
    expect(afterBuf[1]).toBe(0xBB)
    expect(afterBuf[2]).toBe(0xBF)
    expect(afterBuf[3]).not.toBe(0xEF)
    const text = afterBuf.subarray(3).toString('utf-8')
    expect(text).toContain('goodbye world')
  })

  it('GBK 文件编辑后保持 GBK 编码', async () => {
    const iconv = require('iconv-lite')
    const gbkBuf = encodeFile('hello 世界\n', 'gbk')
    writeFileSync(join(TMP, 'gbk.txt'), gbkBuf)
    await readTool.execute({ path: 'gbk.txt' }, createContext())

    const result = await editTool.execute(
      { filePath: 'gbk.txt', edits: [{ oldText: 'hello', newText: '你好' }] },
      createContext()
    )
    expect(result.success).toBe(true)

    const afterBuf = readFileSync(join(TMP, 'gbk.txt'))
    const decoded = iconv.decode(afterBuf, 'gbk')
    expect(decoded).toContain('你好')
    expect(decoded).toContain('世界')
  })

  it('同文件并发编辑串行化（不丢失更新）', async () => {
    writeFileSync(join(TMP, 'concurrent.ts'), 'section_a\nsection_b\nsection_c\n')
    await readTool.execute({ path: 'concurrent.ts' }, createContext())
    const ctx = createContext()

    const p1 = editTool.execute(
      { filePath: 'concurrent.ts', edits: [{ oldText: 'section_a', newText: 'SECTION_A' }] },
      ctx
    )
    const p2 = editTool.execute(
      { filePath: 'concurrent.ts', edits: [{ oldText: 'section_b', newText: 'SECTION_B' }] },
      ctx
    )

    const [r1, r2] = await Promise.all([p1, p2])
    expect(r1.success).toBe(true)
    expect(r2.success).toBe(true)

    const content = readFileSync(join(TMP, 'concurrent.ts'), 'utf-8')
    expect(content).toContain('SECTION_A')
    expect(content).toContain('SECTION_B')
    expect(content).toContain('section_c')
  })

  it('编辑后 ReadState 自动刷新，连续编辑无需重新读取', async () => {
    writeFileSync(join(TMP, 'refresh.ts'), 'aaa\nbbb\nccc\n')
    await readTool.execute({ path: 'refresh.ts' }, createContext())
    const ctx = createContext()

    const r1 = await editTool.execute(
      { filePath: 'refresh.ts', edits: [{ oldText: 'aaa', newText: 'AAA' }] },
      ctx
    )
    expect(r1.success).toBe(true)

    const r2 = await editTool.execute(
      { filePath: 'refresh.ts', edits: [{ oldText: 'bbb', newText: 'BBB' }] },
      ctx
    )
    expect(r2.success).toBe(true)

    const content = readFileSync(join(TMP, 'refresh.ts'), 'utf-8')
    expect(content).toBe('AAA\nBBB\nccc\n')
  })

  it('外部修改后编辑被拒绝', async () => {
    writeFileSync(join(TMP, 'external.ts'), 'original\n')
    await readTool.execute({ path: 'external.ts' }, createContext())

    writeFileSync(join(TMP, 'external.ts'), 'modified externally\n')
    const future = new Date(Date.now() + 10000)
    utimesSync(join(TMP, 'external.ts'), future, future)

    const result = await editTool.execute(
      { filePath: 'external.ts', edits: [{ oldText: 'original', newText: 'new' }] },
      createContext()
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain('modified externally')
  })

  it('mtime 变化但内容未变时允许编辑（云同步假阳性）', async () => {
    writeFileSync(join(TMP, 'cloudsync.ts'), 'same content\n')
    await readTool.execute({ path: 'cloudsync.ts' }, createContext())

    const future = new Date(Date.now() + 10000)
    utimesSync(join(TMP, 'cloudsync.ts'), future, future)

    const result = await editTool.execute(
      { filePath: 'cloudsync.ts', edits: [{ oldText: 'same content', newText: 'new content' }] },
      createContext()
    )
    expect(result.success).toBe(true)
  })

  // ── 回归：readState 键规范化 + write 回种（Windows 路径大小写死循环根因） ──

  it.runIf(process.platform === 'win32')(
    'Windows: read 与 edit 路径大小写不一致时仍视为已读（readState 键大小写无关）',
    async () => {
      // 模拟 read 用一种大小写、edit 用另一种大小写的真实场景：
      // Windows 文件系统大小写不敏感，但若 readState 键大小写敏感，会误判"未读取"
      // 并触发模型 read→edit→失败→read 的死循环。
      writeFileSync(join(TMP, 'CaseTest.ts'), 'const a = 1\n')
      await readTool.execute({ path: 'CaseTest.ts' }, createContext())

      // 用全小写文件名再 edit（指向同一物理文件）
      const result = await editTool.execute(
        { filePath: 'casetest.ts', edits: [{ oldText: 'const a = 1', newText: 'const a = 2' }] },
        createContext()
      )
      expect(result.success).toBe(true)
      expect(readFileSync(join(TMP, 'CaseTest.ts'), 'utf-8')).toContain('const a = 2')
    }
  )

  // ── I1 回归：readState 实例隔离 ──────────────────────────────

  it('两个独立 readState 互不污染（A 读不影响 B 的 edit 校验）', async () => {
    writeFileSync(join(TMP, 'iso_a.txt'), 'content A\n')
    writeFileSync(join(TMP, 'iso_b.txt'), 'content B\n')

    // A readState：读 iso_a.txt
    const readStateA = createReadState()
    await readTool.execute(
      { path: 'iso_a.txt' },
      { workingDir: TMP, readState: readStateA }
    )
    // B readState：空，从未读
    const readStateB = createReadState()

    // 用 A 的 readState edit iso_a.txt → 应该成功
    const okResult = await editTool.execute(
      {
        filePath: 'iso_a.txt',
        edits: [{ oldText: 'content A', newText: 'A was edited' }]
      },
      { workingDir: TMP, readState: readStateA }
    )
    expect(okResult.success).toBe(true)

    // 用 B 的 readState edit iso_b.txt → 应该失败 "File has not been read"
    const failResult = await editTool.execute(
      {
        filePath: 'iso_b.txt',
        edits: [{ oldText: 'content B', newText: 'B was edited' }]
      },
      { workingDir: TMP, readState: readStateB }
    )
    expect(failResult.success).toBe(false)
    expect(failResult.error).toContain('not been read')
  })

  it('readState.clone() 产生独立副本（修改 clone 不影响原始）', async () => {
    writeFileSync(join(TMP, 'clone_test.txt'), 'hello\n')
    const parent = createReadState()
    await readTool.execute(
      { path: 'clone_test.txt' },
      { workingDir: TMP, readState: parent }
    )

    const child = parent.clone()
    // 子副本读到的文件应该与父副本一致（继承）
    const absPath = join(TMP, 'clone_test.txt')
    expect(child.get(absPath)).toBeDefined()
    expect(child.get(absPath)!.content).toBe('hello\n')

    // 修改子副本不影响父副本（隔离）
    child.set(absPath, { content: 'modified', timestamp: 999 })
    expect(parent.get(absPath)!.content).toBe('hello\n')
    expect(child.get(absPath)!.content).toBe('modified')
  })

  it('write 创建文件后可直接 edit，无需再次 read（write 回种 readState）', async () => {
    // write 工具写出文件后应回种 readState，避免模型陷入
    // write → edit("File has not been read yet") → read → edit 的多余往返/死循环。
    const writeResult = await writeTool.execute(
      { path: 'fresh.ts', content: 'line1\nline2\n' },
      createContext()
    )
    expect(writeResult.success).toBe(true)

    const editResult = await editTool.execute(
      { filePath: 'fresh.ts', edits: [{ oldText: 'line1', newText: 'LINE1' }] },
      createContext()
    )
    expect(editResult.success).toBe(true)
    expect(readFileSync(join(TMP, 'fresh.ts'), 'utf-8')).toBe('LINE1\nline2\n')
  })

  it('write 覆写已有文件后可直接 edit（回种刷新为最新内容）', async () => {
    writeFileSync(join(TMP, 'over.ts'), 'old content\n')
    // 不先 read，直接 write 覆写
    const writeResult = await writeTool.execute(
      { path: 'over.ts', content: 'brand new\n' },
      createContext()
    )
    expect(writeResult.success).toBe(true)

    const editResult = await editTool.execute(
      { filePath: 'over.ts', edits: [{ oldText: 'brand new', newText: 'edited' }] },
      createContext()
    )
    expect(editResult.success).toBe(true)
    expect(readFileSync(join(TMP, 'over.ts'), 'utf-8')).toBe('edited\n')
  })

  // ── skill 目录只读保证：即使 ToolContext 带 extraAllowedRoots，edit/write 仍拒 ──

  it('edit 对 skill 目录路径仍拒绝（不消费 extraAllowedRoots）', async () => {
    const skillDir = join(process.cwd(), '.test-skill-root-edit')
    mkdirSync(join(skillDir, 'references'), { recursive: true })
    writeFileSync(join(skillDir, 'references', 'rule.md'), 'do-not-edit\n')
    try {
      const target = join(skillDir, 'references', 'rule.md')
      // 即使上下文带了额外根（read 会放行），edit 仍双参校验 → 越界
      const result = await editTool.execute(
        { filePath: target, edits: [{ oldText: 'do-not-edit', newText: 'hacked' }] },
        createContext({ extraAllowedRoots: [skillDir] })
      )
      expect(result.success).toBe(false)
      expect(result.error).toContain('越界')
      expect(readFileSync(target, 'utf-8')).toBe('do-not-edit\n')
    } finally {
      rmSync(skillDir, { recursive: true, force: true })
    }
  })

  it('write 对 skill 目录路径仍拒绝（不消费 extraAllowedRoots）', async () => {
    const skillDir = join(process.cwd(), '.test-skill-root-write')
    mkdirSync(join(skillDir, 'references'), { recursive: true })
    writeFileSync(join(skillDir, 'references', 'rule.md'), 'original\n')
    try {
      const target = join(skillDir, 'references', 'rule.md')
      const result = await writeTool.execute(
        { path: target, content: 'hacked\n' },
        createContext({ extraAllowedRoots: [skillDir] })
      )
      expect(result.success).toBe(false)
      expect(result.error).toContain('越界')
      expect(readFileSync(target, 'utf-8')).toBe('original\n')
    } finally {
      rmSync(skillDir, { recursive: true, force: true })
    }
  })
})
