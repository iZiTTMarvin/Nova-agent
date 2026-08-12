/**
 * lsTool 大目录控量测试。
 * 单独成文件：fs/promises.readdir 需 mock 构造超大目录，与 tools.test.ts 的真实 fs 测试隔离。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'
import { mkdtempSync, rmSync } from 'fs'
import type { Dirent } from 'fs'

// 只覆盖 readdir，保留 fs/promises 其余真实导出，避免波及其它工具的导入。
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  return { ...actual, readdir: vi.fn() }
})

import { readdir } from 'fs/promises'
import { lsTool, LS_MAX_ENTRIES } from '../../../../src/runtime/tools/lsTool'
import { createReadState } from '../../../../src/runtime/tools/editTool'
import type { ToolContext } from '../../../../src/runtime/tools/types'

const mockedReaddir = vi.mocked(readdir)

/** 构造最小可用的 Dirent：lsTool 只用 name 与 isDirectory()。 */
function dirent(name: string, isDir: boolean): Dirent {
  return {
    name,
    isDirectory: () => isDir,
    isFile: () => !isDir,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false,
    isSymbolicLink: () => false,
  } as unknown as Dirent
}

describe('lsTool 控量', () => {
  let workingDir: string

  beforeEach(() => {
    // 真实存在的绝对路径锚点（readdir 已 mock，不会真正读盘，但路径校验与标头需要它）。
    workingDir = mkdtempSync(join(tmpdir(), 'nova-ls-cap-'))
    mockedReaddir.mockReset()
  })

  afterEach(() => {
    rmSync(workingDir, { recursive: true, force: true })
  })

  function ctx(): ToolContext {
    return { workingDir, readState: createReadState() }
  }

  it('声明字符级兜底上限，与 find 对齐', () => {
    expect(lsTool.maxResultSizeChars).toBe(100_000)
  })

  it('小目录：无截断提示、无 truncationMeta，输出与单层列举逐行一致', async () => {
    mockedReaddir.mockResolvedValue([dirent('hello.txt', false), dirent('src', true)])

    const result = await lsTool.execute({ path: '.' }, ctx())

    expect(result.success).toBe(true)
    expect(result.truncationMeta).toBeUndefined()
    expect(result.output).toBe(`[workspace: ${workingDir}]\nhello.txt\nsrc/`)
  })

  it('大目录：只展示前 N 条 + 末尾收窄建议，truncationMeta 反映未截断总数', async () => {
    const count = LS_MAX_ENTRIES + 2
    const names = Array.from(
      { length: count },
      (_, i) => `file_${String(i).padStart(4, '0')}.txt`
    )
    mockedReaddir.mockResolvedValue(names.map((n) => dirent(n, false)))

    const result = await lsTool.execute({ path: '.' }, ctx())

    expect(result.success).toBe(true)

    const outLines = result.output!.split('\n')
    // 1 行标头 + 前 N 条条目 + 1 行提示
    expect(outLines.length).toBe(1 + LS_MAX_ENTRIES + 1)
    // 封顶之外的条目绝不内联
    expect(result.output).not.toContain('file_0501.txt')
    // 末尾提示行
    const hint = outLines[outLines.length - 1]
    expect(hint).toContain(`共 ${count} 个条目`)
    expect(hint).toContain(`已显示前 ${LS_MAX_ENTRIES} 个`)

    expect(result.truncationMeta).toBeDefined()
    expect(result.truncationMeta).toEqual({
      totalBytes: Buffer.byteLength(names.join('\n'), 'utf-8'),
      totalLines: count,
      shownLines: LS_MAX_ENTRIES,
      truncated: true,
    })
  })

  it('空目录：输出 (空目录)，无 truncationMeta', async () => {
    mockedReaddir.mockResolvedValue([])

    const result = await lsTool.execute({ path: '.' }, ctx())

    expect(result.success).toBe(true)
    expect(result.output).toBe(`[workspace: ${workingDir}]\n(空目录)`)
    expect(result.truncationMeta).toBeUndefined()
  })

  it('条目按名称排序，保证大目录截断的确定性', async () => {
    // readdir 顺序无保证；乱序 mock 输入下输出必须稳定排序
    mockedReaddir.mockResolvedValue([
      dirent('zeta.txt', false),
      dirent('alpha.txt', false),
      dirent('Beta.txt', false)
    ])

    const result = await lsTool.execute({ path: '.' }, ctx())

    expect(result.success).toBe(true)
    const lines = result.output!.split('\n')
    expect(lines[1]).toBe('alpha.txt')
    expect(lines[2]).toBe('Beta.txt')
    expect(lines[3]).toBe('zeta.txt')
  })

  it('越界路径返回错误，不读取目录', async () => {
    const result = await lsTool.execute({ path: '../../etc' }, ctx())

    expect(result.success).toBe(false)
    expect(result.error).toContain('越界')
    expect(result.truncationMeta).toBeUndefined()
    expect(mockedReaddir).not.toHaveBeenCalled()
  })
})
