import { describe, expect, it } from 'vitest'
import type { DiffHunk } from '../../../src/shared/diff/types'
import { buildHunkPatch } from '../../../src/renderer/features/diff/pierrePatch'

describe('buildHunkPatch', () => {
  it('生成 Pierre 可消费的 unified patch，并规范 Windows 路径', () => {
    const hunk: DiffHunk = {
      oldStart: 10,
      oldLines: 2,
      newStart: 10,
      newLines: 2,
      content: ' keep\n-old\n+new'
    }

    const result = buildHunkPatch('src\\value.ts', hunk, 'modified')

    expect(result.patch).toContain('diff --git a/src/value.ts b/src/value.ts')
    expect(result.patch).toContain('--- a/src/value.ts')
    expect(result.patch).toContain('+++ b/src/value.ts')
    expect(result.patch).toContain('@@ -10,2 +10,2 @@')
    expect(result.omittedLines).toBe(0)
  })

  it('截断时按实际展示行重新计算 hunk 跨度', () => {
    const hunk: DiffHunk = {
      oldStart: 3,
      oldLines: 4,
      newStart: 3,
      newLines: 4,
      content: ' context\n-remove\n+add\n tail'
    }

    const result = buildHunkPatch('a.ts', hunk, 'modified', 3)

    expect(result.patch).toContain('@@ -3,2 +3,2 @@')
    expect(result.patch).not.toContain(' tail')
    expect(result).toMatchObject({
      totalLines: 4,
      renderedLines: 3,
      omittedLines: 1
    })
  })

  it('新增和删除文件使用 /dev/null 边界', () => {
    const added = buildHunkPatch('new file.ts', {
      oldStart: 0,
      oldLines: 0,
      newStart: 1,
      newLines: 1,
      content: '+hello'
    }, 'added')
    const deleted = buildHunkPatch('old.ts', {
      oldStart: 1,
      oldLines: 1,
      newStart: 0,
      newLines: 0,
      content: '-bye'
    }, 'deleted')

    expect(added.patch).toContain('--- /dev/null')
    expect(added.patch).toContain('+++ "b/new file.ts"')
    expect(deleted.patch).toContain('--- a/old.ts')
    expect(deleted.patch).toContain('+++ /dev/null')
  })

  it('status 决定 /dev/null 落在 old 或 new 侧，与 hunk 行号无关', () => {
    const hunk: DiffHunk = {
      oldStart: 1,
      oldLines: 1,
      newStart: 1,
      newLines: 1,
      content: ' x\n-old\n+new'
    }

    const asAdded = buildHunkPatch('f.ts', hunk, 'added')
    const asDeleted = buildHunkPatch('f.ts', hunk, 'deleted')

    expect(asAdded.patch).toContain('--- /dev/null')
    expect(asAdded.patch).toContain('+++ b/f.ts')
    expect(asDeleted.patch).toContain('--- a/f.ts')
    expect(asDeleted.patch).toContain('+++ /dev/null')
  })

  it('空 content 不伪造 1/1 hunk', () => {
    const result = buildHunkPatch('empty.ts', {
      oldStart: 1,
      oldLines: 0,
      newStart: 1,
      newLines: 0,
      content: ''
    }, 'modified')

    expect(result.patch).not.toContain('@@')
    expect(result).toMatchObject({
      totalLines: 0,
      renderedLines: 0,
      omittedLines: 0
    })
  })
})
