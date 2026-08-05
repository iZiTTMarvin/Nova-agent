import { describe, expect, it } from 'vitest'
import { computeDiffLines, countEntryChanges } from '../../../../src/renderer/features/diff/diffLines'
import type { DiffEntry, DiffHunk } from '../../../../src/shared/diff/types'

describe('computeDiffLines', () => {
  it('上下文 / 新增 / 删除行号按 oldStart·newStart 递进', () => {
    const hunk: DiffHunk = {
      oldStart: 10,
      oldLines: 3,
      newStart: 20,
      newLines: 4,
      content: ' ctx\n-old\n+new1\n+new2'
    }
    const lines = computeDiffLines(hunk)
    expect(lines).toEqual([
      { prefix: ' ', text: 'ctx', realLineNo: 10 },
      { prefix: '-', text: 'old', realLineNo: 11 },
      { prefix: '+', text: 'new1', realLineNo: 21 },
      { prefix: '+', text: 'new2', realLineNo: 22 }
    ])
  })
})

describe('countEntryChanges', () => {
  it('只统计 +/- 前缀行，不含上下文', () => {
    const entry: DiffEntry = {
      filePath: 'a.ts',
      status: 'modified',
      hunks: [
        {
          oldStart: 1,
          oldLines: 3,
          newStart: 1,
          newLines: 4,
          content: ' keep\n-del1\n-del2\n+add1\n+add2\n+add3'
        }
      ]
    }
    expect(countEntryChanges(entry)).toEqual({ additions: 3, deletions: 2 })
  })

  it('空 hunk content 计为 0', () => {
    const entry: DiffEntry = {
      filePath: 'b.ts',
      status: 'added',
      hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 0, content: '' }]
    }
    expect(countEntryChanges(entry)).toEqual({ additions: 0, deletions: 0 })
  })
})
