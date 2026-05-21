import { describe, it, expect } from 'vitest'
import { computeFileDiff } from '../../../src/shared/diff/compute'
import type { DiffEntry } from '../../../src/shared/diff/types'

describe('computeFileDiff', () => {
  it('新建文件：所有行为 added', () => {
    const result = computeFileDiff('new.txt', '', 'line1\nline2\nline3', 'added')

    expect(result.filePath).toBe('new.txt')
    expect(result.status).toBe('added')
    expect(result.hunks).toHaveLength(1)
    expect(result.hunks[0].oldStart).toBe(0)
    expect(result.hunks[0].oldLines).toBe(0)
    expect(result.hunks[0].newStart).toBe(1)
    expect(result.hunks[0].newLines).toBe(3)
    expect(result.hunks[0].content).toBe('+line1\n+line2\n+line3')
  })

  it('删除文件：所有行为 removed', () => {
    const result = computeFileDiff('old.txt', 'a\nb\nc', '', 'deleted')

    expect(result.filePath).toBe('old.txt')
    expect(result.status).toBe('deleted')
    expect(result.hunks).toHaveLength(1)
    expect(result.hunks[0].oldStart).toBe(1)
    expect(result.hunks[0].oldLines).toBe(3)
    expect(result.hunks[0].newStart).toBe(0)
    expect(result.hunks[0].newLines).toBe(0)
    expect(result.hunks[0].content).toBe('-a\n-b\n-c')
  })

  it('修改文件：能检测新增行', () => {
    const result = computeFileDiff('file.ts', 'line1\nline2', 'line1\nline2\nline3', 'modified')

    expect(result.status).toBe('modified')
    const allContent = result.hunks.map(h => h.content).join('\n')
    expect(allContent).toContain('+line3')
  })

  it('修改文件：能检测删除行', () => {
    const result = computeFileDiff('file.ts', 'a\nb\nc', 'a\nc', 'modified')

    expect(result.status).toBe('modified')
    const allContent = result.hunks.map(h => h.content).join('\n')
    expect(allContent).toContain('-b')
  })

  it('修改文件：能检测替换行', () => {
    const result = computeFileDiff('file.ts', 'old line', 'new line', 'modified')

    expect(result.status).toBe('modified')
    const allContent = result.hunks.map(h => h.content).join('\n')
    expect(allContent).toContain('-old line')
    expect(allContent).toContain('+new line')
  })

  it('内容相同时不产生 hunk', () => {
    const result = computeFileDiff('same.ts', 'identical\ncontent', 'identical\ncontent', 'modified')

    expect(result.hunks).toHaveLength(0)
  })

  it('空文件到有内容：返回 added hunk', () => {
    const result = computeFileDiff('f.txt', '', 'hello', 'modified')

    expect(result.hunks.length).toBeGreaterThanOrEqual(1)
    expect(result.hunks[0].content).toContain('+hello')
  })

  it('hunk 中上下文行以空格开头', () => {
    const result = computeFileDiff('f.ts', 'a\nb\nc\nd\ne', 'a\nb\nX\nd\ne', 'modified')

    const allLines = result.hunks.flatMap(h => h.content.split('\n'))
    const contextLines = allLines.filter(l => l.startsWith(' '))
    // 周围不变行应该作为上下文出现
    expect(contextLines.length).toBeGreaterThan(0)
  })

  it('多段不相邻的修改生成多个 hunk', () => {
    // 修改第一行和最后一行，中间保留大量不变行
    const oldLines = ['FIRST', ...Array(20).fill('middle'), 'LAST']
    const newLines = ['first_changed', ...Array(20).fill('middle'), 'last_changed']
    const result = computeFileDiff('big.ts', oldLines.join('\n'), newLines.join('\n'), 'modified')

    // 两段修改间隔足够远，应该生成两个独立的 hunk
    expect(result.hunks.length).toBeGreaterThanOrEqual(2)
  })

  it('保留文件路径不变', () => {
    const result = computeFileDiff('src/utils/helper.ts', 'a', 'b', 'modified')
    expect(result.filePath).toBe('src/utils/helper.ts')
  })
})
