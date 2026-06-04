import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, readFileSync, rmSync, statSync, utimesSync } from 'fs'
import { join } from 'path'
import { editTool } from '../../../../src/runtime/tools/editTool'
import { readTool } from '../../../../src/runtime/tools/readTool'
import { readState } from '../../../../src/runtime/tools/editTool'
import { encodeFile } from '../../../../src/runtime/tools/editDiff'
import type { ToolContext } from '../../../../src/runtime/tools/types'

const TMP = join(process.cwd(), '.test-workspace-edit')

function createContext(overrides?: Partial<ToolContext>): ToolContext {
  return { workingDir: TMP, ...overrides }
}

describe('editTool 集成测试', () => {
  beforeEach(() => {
    mkdirSync(TMP, { recursive: true })
    readState.clear()
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
})
